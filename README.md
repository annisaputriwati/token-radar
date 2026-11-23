# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/annisaputriwati/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/annisaputriwati/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Launch Signal** — a token launch radar built for the make.fun bounty "Build the best token launch radar". It reads the sealed DefiLlama snapshot and accounts for all 758 protocols in it: 416 already trading, 144 set aside as products of another protocol, and 198 pre-token protocols ranked (the whole 40-protocol watchlist included). Each launch is priced by a value model fitted on the snapshot's own 128 traded peers — an ordinary least squares fit of log(market cap) on log(TVL) — multiplied by launch odds measured from the snapshot itself (the share of comparable protocols that already carry a token, by tokenless-age and TVL band). The fitted model was chosen by a seeded held-out test run at build time: it prices the traded peers out of sample with a median absolute log error of 1.20, against 1.65 for flat category-median multiples; category offsets, a growth term and an age term were fitted, tested and rejected, and the dashboard's model page publishes the full table. Every row carries a concrete farm plan (steps with costs and time frames, varied by category and chains) netted to a verdict — FARM, THIN or SKIP — from the plan's own costed steps, and the static dashboard is sortable and filterable with a detail view per protocol that shows the model's arithmetic and the farm netting in full.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
