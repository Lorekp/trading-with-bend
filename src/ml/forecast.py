"""CPU model adapters for the checked JavaScript forecasting interface.

JSON on stdin/stdout; diagnostic output goes to stderr. No pickle loading,
filesystem data access, partition selection, execution or trading decisions.
"""
import contextlib
import importlib.metadata
import json
import platform
import sys

import numpy as np


def runtime():
    return {"python": platform.python_version(), "system": platform.system(), "machine": platform.machine(), **{
        name: importlib.metadata.version(name)
        for name in ("numpy", "scipy", "scikit-learn", "lightgbm", "torch")
    }}


def build_tcn(features):
    import torch
    from torch import nn

    class ResidualBlock(nn.Module):
        def __init__(self, inputs, dilation):
            super().__init__()
            # Padding only on the left makes every encoded time step causal.
            layers = []
            for channels in (inputs, 32):
                layers.extend([nn.ConstantPad1d((2 * dilation, 0), 0),
                               nn.Conv1d(channels, 32, 3, dilation=dilation),
                               nn.ReLU(), nn.Dropout(0.1)])
            self.layers = nn.Sequential(*layers)
            self.shortcut = nn.Conv1d(inputs, 32, 1) if inputs != 32 else nn.Identity()

        def forward(self, x):
            return torch.relu(self.layers(x) + self.shortcut(x))

    class TCN(nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = nn.Sequential(*[
                ResidualBlock(features if i == 0 else 32, dilation)
                for i, dilation in enumerate((1, 2, 4, 8))
            ])
            self.head = nn.Sequential(nn.Linear(32, 16), nn.ReLU(), nn.Linear(16, 1))

        def forward(self, x):
            return self.head(self.encoder(x)[:, :, -1]).squeeze(-1)

    return TCN()


def parameters(kind, supplied):
    defaults = {
        "zero": {}, "ridge": {"alpha": 1.0},
        "lightgbm": {"nEstimators": 100, "patience": 10, "learningRate": 0.05, "numLeaves": 15},
        "tcn": {"epochs": 20, "patience": 4, "batchSize": 128, "learningRate": 0.001},
    }[kind]
    if set(supplied) - set(defaults):
        raise ValueError("Unsupported model parameters")
    options = {**defaults, **supplied}
    for name, value in options.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be positive and finite")
        if name not in ("alpha", "learningRate") and not isinstance(value, int):
            raise ValueError(f"{name} must be an integer")
    return options


def tensor(x, contract):
    import torch
    return torch.tensor(x.reshape(-1, contract["sequenceLength"], contract["featureCount"]),
                        dtype=torch.float32).transpose(1, 2).contiguous()


def fit(request):
    kind = request["kind"]
    p = parameters(kind, request["parameters"])
    x, y = np.asarray(request["x"], dtype=np.float64), np.asarray(request["y"], dtype=np.float64)
    vx, vy = np.asarray(request["validationX"], dtype=np.float64), np.asarray(request["validationY"], dtype=np.float64)
    if not all(np.isfinite(a).all() for a in (x, y, vx, vy)):
        raise ValueError("Nonfinite model input")
    diagnostics = {}
    if kind == "zero":
        state = {"constant": request["zero"]}
    elif kind == "ridge":
        # A maintained solver handles the hundreds of lag columns without
        # extending the toolkit's small dense normal-equations implementation.
        from sklearn.linear_model import Ridge
        model = Ridge(alpha=p["alpha"], solver="lsqr", tol=1e-8).fit(x, y)
        state = {"coefficients": model.coef_.tolist(), "intercept": float(model.intercept_)}
    elif kind == "lightgbm":
        import lightgbm as lgb
        model = lgb.LGBMRegressor(n_estimators=p["nEstimators"], learning_rate=p["learningRate"],
                                 num_leaves=p["numLeaves"], random_state=request["seed"],
                                 n_jobs=1, deterministic=True, force_col_wise=True, verbosity=-1)
        model.fit(x, y, eval_set=[(vx, vy)], eval_metric="l2",
                  callbacks=[lgb.early_stopping(p["patience"], verbose=False)])
        state = {"booster": model.booster_.model_to_string(num_iteration=model.best_iteration_)}
        diagnostics = {"bestIteration": model.best_iteration_}
    else:
        import torch
        torch.set_num_threads(1)
        torch.manual_seed(request["seed"])
        torch.use_deterministic_algorithms(True)
        model = build_tcn(request["contract"]["featureCount"])
        tx, tv = tensor(x, request["contract"]), tensor(vx, request["contract"])
        ty, target_v = torch.tensor(y, dtype=torch.float32), torch.tensor(vy, dtype=torch.float32)
        optimizer = torch.optim.AdamW(model.parameters(), lr=p["learningRate"], weight_decay=0.01)
        best, stale, best_state, history = float("inf"), 0, None, []
        for epoch in range(p["epochs"]):
            model.train()
            permutation = torch.randperm(len(tx))
            for indices in permutation.split(p["batchSize"]):
                optimizer.zero_grad()
                loss = torch.nn.functional.mse_loss(model(tx[indices]), ty[indices])
                if not torch.isfinite(loss):
                    raise ValueError("Nonfinite training loss")
                loss.backward()
                optimizer.step()
            model.eval()
            with torch.no_grad():
                prediction = torch.cat([model(batch) for batch in tv.split(p["batchSize"])])
                score = float(torch.nn.functional.mse_loss(prediction, target_v))
            if not np.isfinite(score):
                raise ValueError("Nonfinite validation loss")
            history.append(score)
            if score < best:
                best, stale = score, 0
                best_state = {name: value.detach().clone() for name, value in model.state_dict().items()}
                best_epoch = epoch + 1
            else:
                stale += 1
            if stale >= p["patience"]:
                break
        state = {"weights": {name: value.tolist() for name, value in best_state.items()}}
        diagnostics = {"bestEpoch": best_epoch, "epochsRun": len(history), "validationMSEStandardized": history,
                       "parameters": sum(value.numel() for value in model.parameters()), "receptiveField": 61}
    predictions = predict({**request, "state": state, "x": vx})
    return {"state": state, "parameters": p, "diagnostics": diagnostics, "runtime": runtime(), "predictions": predictions}


def predict(request):
    x, state, kind = np.asarray(request["x"], dtype=np.float64), request["state"], request["kind"]
    if kind == "zero":
        result = np.full(len(x), state["constant"])
    elif kind == "ridge":
        result = x @ np.asarray(state["coefficients"]) + state["intercept"]
    elif kind == "lightgbm":
        import lightgbm as lgb
        result = lgb.Booster(model_str=state["booster"]).predict(x, num_threads=1)
    elif kind == "tcn":
        import torch
        torch.set_num_threads(1)
        model = build_tcn(request["contract"]["featureCount"])
        model.load_state_dict({name: torch.tensor(value) for name, value in state["weights"].items()})
        model.eval()
        with torch.no_grad():
            result = torch.cat([model(batch) for batch in tensor(x, request["contract"]).split(128)]).numpy()
    else:
        raise ValueError("Unknown model adapter")
    if not np.isfinite(result).all():
        raise ValueError("Nonfinite forecast output")
    return result.tolist()


if __name__ == "__main__":
    request = json.load(sys.stdin)
    # Keep native/library chatter away from the JSON protocol.
    with contextlib.redirect_stdout(sys.stderr):
        if "expectedRuntime" in request and request["expectedRuntime"] != runtime():
            raise ValueError("Python runtime changed from the registered or fitted environment")
        if request["operation"] == "runtime":
            result = runtime()
        elif request["operation"] == "fit":
            result = fit(request)
        elif request["operation"] == "predict":
            result = {"predictions": predict(request)}
        else:
            raise ValueError("Unknown operation")
    json.dump(result, sys.stdout, allow_nan=False)
