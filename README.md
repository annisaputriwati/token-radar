# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/annisaputriwati/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/annisaputriwati/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Launch Signal** — a token launch radar built for the make.fun bounty "Build the best token launch radar". It reads the sealed DefiLlama snapshot, finds the protocols that still record no token (the whole 40-protocol watchlist plus the pre-token protocols below its floor, 198 ranked in all), and prices what each launch would be worth with a model derived only from the snapshot's own figures: implied value = TVL × the median market-cap/TVL multiple of traded protocols in the same category × a bounded seven-day growth factor × a tokenless-age factor. Every row carries a concrete farm plan (steps with costs and time frames, varied by category and chains), and the static dashboard is sortable and filterable with a detail view per protocol that shows the model's arithmetic in full.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
