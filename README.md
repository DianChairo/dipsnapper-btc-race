# dipsnapper-btc-race

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/DianChairo/dipsnapper-btc-race/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/DianChairo/dipsnapper-btc-race/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

DipSnapper is a long-only trading bot for Coinbase Wrapped BTC (cbBTC) on
1-minute bars. It buys sharp, fast dips — a fall of about half a percent
over the trailing 45 minutes that has stopped deepening — and sells the
snap-back, with a profit target over the real fill price, a hard stop, and
a time stop for positions that never bounce. Position size is capped by
the order's own estimated price impact against the pool's depth, because
in this replay every fill pays fees, slippage and impact. The bot is
fully deterministic: no clock, no network, no randomness.

## Run it

```sh
node main.ts < replay.ndjson > orders.ndjson
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8tpwxchz&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
