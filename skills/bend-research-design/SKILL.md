---
name: bend-research-design
description: Design hypothesis-led trading studies in the local trading-with-bend framework, including falsification, bias controls, bounded parameter search and untouched final evaluation. Use for research plans, strategy hypotheses or deciding what experiment would provide credible evidence.
---

# Bend Research Design

Turn a trading idea into an experiment whose result can change the decision to pursue it.

Resolve repository paths from the target `trading-with-bend` checkout, not this installed skill. Read its `AGENTS.md` and `docs/RESEARCH.md`; confirm the referenced exports in `src/index.mjs` before writing executable code. These skills distill a 2026-10-03 documentation snapshot; the local implementation is authoritative.

For a new study, read [study-design.md](references/study-design.md). State the proposed mechanism, its observable prediction, the strongest alternative explanation, and a result that would disprove the edge. Exploratory searches are legitimate: label them exploratory and reserve different, untouched evidence for confirmation instead of inventing a hypothesis after seeing winners.

For parameter search, robustness checks, confirmation or a changed thesis, read [falsification.md](references/falsification.md). Freeze the comparison population, split plan, execution assumptions, economic acceptance and total research budget before evaluating candidates. Profitability-seeking swarms also predeclare search-wide uncertainty analysis. Match that scope to the task; a small diagnostic need not become a large campaign.

Implement the plan with `walkForwardSplits`, `evaluateStudy` and, for official multi-agent studies, `createCampaign`. Use all validation folds, common cash/hold baselines and the same source/venue identities. The shipped selector ranks exact aggregate validation return. Apply a separately frozen economic accept/reject rule to that winner; rejection can be the completed research result.

The coordinator retains final values and fixes one absolute shared `finalAuthorityDirectory` across checkouts. Official final evaluation uses `releaseCampaignFinal`; `withFinalHoldout` is the lower-level helper. Treat a released tail as spent even on failure, and release only when requested after strategy/protocol freeze.

Deliver a concise research plan or recorded study artifact with hypothesis/discovery status, data availability assumptions, controls, search budget, rejection criteria and the next decision. Separate economic evidence from successful simulator execution.
