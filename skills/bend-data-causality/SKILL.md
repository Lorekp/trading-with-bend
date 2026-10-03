---
name: bend-data-causality
description: Prepare or audit market data and features for trading-with-bend, preserving publication timing, exact units, gaps, provenance and independent information/execution sources. Use for ingestion, as-of joins, resampling or leakage diagnosis.
---

# Bend Data Causality

Make each decision consume only data that was available then, in explicitly declared units.

Repository paths refer to the target `trading-with-bend` checkout. Read `AGENTS.md`, `docs/MARKET_DATA.md` and the relevant adapter contract; verify current exports in `src/index.mjs`. This skill adapts a 2026-10-03 knowledge snapshot to local APIs.

For ingestion, missing data, vendor revisions, cross-venue joins or ETH intraday admission, read [availability-and-units.md](references/availability-and-units.md). Use existing archive loaders, preparation and as-of utilities before inventing parsers. Preserve raw data and failed attempts. Verify actual overlapping coverage; state which publication/receipt timestamps are observed and which delays are assumed.

For historical windows, features or scale limits, read [features-and-history.md](references/features-and-history.md). Use `RollingFeatures` / `computeFeatures` for supported trailing transforms and prepared information sources for large inputs. Keep prediction labels separate from visible features.

Information observations and execution events have separate contracts. Source price, volume or displayed depth cannot silently supply fill prices/budgets. Normalize canonical instrument, currency and lot size explicitly, then provide the venue's data independently.

Finish with immutable processed artifacts or a bounded audit of the requested data: units, timing, selection, coverage/gaps, revisions, dependencies and any unresolved assumptions. A successful checksum or Bend visibility check does not certify vendor completeness or economic tradability.
