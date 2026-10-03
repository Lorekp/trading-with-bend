---
name: bend-research-design
description: Design hypothesis-led trading studies in the local trading-with-bend framework, including falsification, bias controls, bounded parameter search and untouched final evaluation. Use for research plans, strategy hypotheses or deciding what experiment would provide credible evidence.
---

# Bend Research Design

Turn a trading idea into an experiment whose result can change the decision to pursue it.

Resolve repository paths from the target `trading-with-bend` checkout, not this installed skill. Read its `AGENTS.md` and `docs/RESEARCH.md`; confirm the referenced exports in `src/index.mjs` before writing executable code. These skills distill a 2026-10-03 documentation snapshot; the local implementation is authoritative.

For a new study, read [study-design.md](references/study-design.md). State the proposed mechanism, its observable prediction, the strongest alternative explanation, and a result that would disprove the edge. Exploratory searches are legitimate: label them exploratory and reserve different, untouched evidence for confirmation instead of inventing a hypothesis after seeing winners.

For parameter search, robustness checks or a changed thesis, read [falsification.md](references/falsification.md). Freeze the comparison population, split plan, execution assumptions, primary selection objective and research budget before evaluating candidates. Match the scope of that freeze to the task; a small diagnostic need not become a large campaign.

Implement the plan with `walkForwardSplits`, `evaluateStudy`, `gridJobs` and the existing experiment registry. Use all validation folds, common cash/hold baselines and the same source/venue identities. The shipped `selectStudy` ranks exact aggregate validation return; it does not implement an arbitrary risk-adjusted objective.

Treat the final tail as spent once `withFinalHoldout` releases it, including on failure. Release it only when the requested task calls for final evaluation and the selected strategy and protocol are fixed.

Deliver a concise research plan or recorded study artifact with hypothesis/discovery status, data availability assumptions, controls, search budget, rejection criteria and the next decision. Separate economic evidence from successful simulator execution.
