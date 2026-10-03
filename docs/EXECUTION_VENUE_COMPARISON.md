# Bybit versus OKX execution data

Compared on 2026-10-03 Europe/Berlin (2026-10-02 UTC). Binance remains the
information source. This study evaluates alternative execution datasets; it
does not change the execution adapter or implement perpetual accounting.

**Recommendation: use OKX ETH-USDT-SWAP as the next execution-data candidate.**
It has higher observed ETH turnover, deeper top-of-book liquidity, finer archive
updates, and a lower published standard taker fee. Bybit provides stronger
sequence and timestamp diagnostics. This conclusion is based on one sample day,
not a certification of September coverage or live execution quality.

## Volume

The matching sample is September 15, 2026, 00:00–24:00 UTC, for USDT-margined
ETH perpetuals. Official daily candles report:

| Measure | Bybit ETHUSDT | OKX ETH-USDT-SWAP |
| --- | ---: | ---: |
| September 15 ETH volume | 1,703,548.77 ETH | 4,403,324.579 ETH |
| September 15 quote turnover | 4,150,715,854.05 USDT | 10,727,430,705.47 USDT |
| Current rolling 24-hour ETH volume | 1,629,307.32 ETH | 3,353,759.245 ETH |

OKX had **2.58× the sample-day quote turnover** and **2.06× the current ETH
quantity volume**. Current tickers were captured around 2026-10-02 22:13:10 UTC;
these are changing, venue-reported figures. The daily turnover comparison uses
actual quote turnover, not base volume multiplied by the latest price.

[CoinGecko's derivatives table](https://www.coingecko.com/en/exchanges/derivatives)
also showed higher exchange-wide rolling volume for OKX: 373,654.6411 BTC
equivalent versus 244,774.2976 for Bybit, or 1.53×. The table ranks by open interest;
that rank is not a volume rank. These figures cover broader derivatives markets
and are not the ETH-only comparison above.

## Downloaded archives and audit

Both official files downloaded without credentials, paid access, or AWS:

- [Bybit archive](https://quote-saver.bycsi.com/orderbook/linear/ETHUSDT/2026-09-15_ETHUSDT_ob200.data.zip)
- [OKX archive](https://static.okx.com/cdn/okx/match/orderbook/pro/L2/400lv/daily/20260915/ETH-USDT-SWAP-L2orderbook-400lv-2026-09-15.tar.gz)

| Measure | Bybit | OKX |
| --- | ---: | ---: |
| Compressed size (decimal MB) | 179.03 | 470.93 |
| Uncompressed content (decimal GB) | 0.969 | 2.682 |
| Raw records in downloaded file | 858,317 | 6,649,163 |
| Levels per side throughout reconstruction | 200 | 400 |
| Snapshots / incremental updates | 2 / 858,315 | 96 / 6,649,067 |
| Inter-message time: median / p99 | 100 / 103 ms | 10 / 60 ms |
| Maximum inter-message gap | 900 ms | 481 ms |
| First timestamp, UTC | 00:00:01.731 | 00:00:00.008 |
| Last timestamp, UTC | September 16 00:00:01.731 | 23:59:59.997 |
| Update IDs in archive | Yes; consecutive between snapshots | No |
| Matching-engine timestamp | Yes, alongside publication timestamp | No separate field |
| Per-book checksum in archive | No | No |

All records parsed. Neither reconstruction produced empty, locked, or crossed
books, negative/invalid quantities, duplicate price entries within a message,
wrong symbols, backward timestamps, or updates before the initial snapshot.
Neither sample had inter-message gaps longer than one second. Bybit's update IDs
had no gaps or reversals between snapshots. OKX has no sequence fields in this
archive, so ordered timestamps and valid reconstructed books cannot prove that
updates were not omitted.

Bybit's file includes **19 records after the UTC day boundary** and misses the
first 1.731 seconds. Filter by event time when joining daily files. The raw file
was preserved, and quote comparisons stop strictly before September 16.

## Liquidity comparison

Reconstructed both books and sampled the latest available state on the same UTC
one-second grid, from 00:00:02 through 23:59:59: **86,398 quotes per venue**.
No quote uses an event timestamp later than its grid timestamp. These derived
files are sampled L1 `bookTicker` views; raw L2 files remain available.

| Measure | Bybit | OKX |
| --- | ---: | ---: |
| Median spread | 0.04044 bps | 0.04043 bps |
| Median best-bid displayed value | 67,142 USDT | 269,284 USDT |
| Median best-ask displayed value | 67,451 USDT | 248,434 USDT |
| Median displayed bid depth within 1 bp of mid | 173,414 USDT | 588,916 USDT |
| Median displayed ask depth within 1 bp of mid | 194,705 USDT | 537,289 USDT |
| 100,000-USDT buy sweep cost vs mid: mean / p95 | 0.305 / 1.114 bps | 0.119 / 0.758 bps |
| 100,000-USDT sell sweep cost vs mid: mean / p95 | 0.343 / 1.240 bps | 0.105 / 0.705 bps |

Sweeps use a base quantity equal to the stated notional divided by that venue's
midpoint. They consume displayed levels and include the half-spread, but exclude
fees, latency, impact, and queue effects. They are descriptive hypothetical costs,
not actual fills. One-second sampling can miss brief stress events; for example,
the maximum sampled spread was larger on OKX despite its better typical depth.

OKX quantities were converted from contracts using current instrument metadata:
0.1 ETH per contract. Bybit linear quantities are ETH. Historical instrument
specifications should be pinned before production backtests. Neither archive
contains local receipt timestamps, and L2 cannot establish exact maker queue
position. Statistics use floating-point arithmetic and are not formally proved.

## Fees and funding

Published baseline perpetual fees checked at comparison time, without VIP,
promotional, or negotiated discounts:

| Fee | Bybit VIP 0 | OKX level 1 |
| --- | ---: | ---: |
| Maker, each fill | 0.020% = 2 bps | 0.020% = 2 bps |
| Taker, each fill | 0.055% = 5.5 bps | 0.050% = 5 bps |
| Maker/maker round trip | 4 bps | 4 bps |
| Maker/taker round trip | 7.5 bps | 7 bps |
| Taker/taker round trip | 11 bps | 10 bps |

At 10,000 USDT notional on each leg, a taker/taker round trip costs **11 USDT on
Bybit versus 10 USDT on OKX**, before spread, slippage and funding. These fees
apply to filled notional, not margin posted. Account region and fee tier can
change the applicable rates; these are benchmark assumptions, not verified
account-specific rates or a complete historical fee schedule.

Sources: [Bybit VIP fee table](https://www.bybit.com/en/help-center/article/Benefits-of-the-VIP-Program),
[OKX futures fee calculation](https://www.okx.com/en-us/help/how-to-calculate-the-contract-transaction-fee).

Funding is separate and can reverse sign. For the three September 15 settlement
timestamps (00:00, 08:00, 16:00 UTC), the sum of retrieved funding rates was:

- Bybit: **−0.9677 bps**, a net receipt for a long.
- OKX: **+0.507593 bps**, a net payment for a long.

For hypothetical constant 10,000-USDT notional held across all three settlements,
that is approximately **0.9677 USDT received** on Bybit and **0.5076 USDT paid**
on OKX. Actual funding requires the position and mark at each settlement;
these sums are not a general funding-cost ranking.

## Reproduction and artifacts

All raw files, API responses, SHA-256 provenance, complete audit JSON, and derived
quotes are under `data/execution-venue-comparison/` (gitignored data directory).
The file `manifest.json` records the downloads and comparison inputs.

```powershell
python scripts/audit-execution-samples.py bybit
python scripts/audit-execution-samples.py okx
```

The audit streams compressed archives without extracting multi-GB files. Full
reconstruction checks every record. A separate pass verified both quote exports
have the same 86,398 timestamps, causal source timestamps, positive sizes, and
spread statistics matching the audit. No shared accounting or replay code changed.

Official schemas: [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline),
[Bybit order books](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook),
[OKX market data](https://app.okx.com/docs-v5/en/#order-book-trading-market-data).
