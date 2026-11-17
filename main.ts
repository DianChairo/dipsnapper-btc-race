/**
 * DipSnapper: buy sharp dips, sell the snap-back (cbBTC 1-minute replay).
 *
 * Why this shape: in this replay a round trip pays roughly 25-45 bps of
 * fees, slippage and the order's own pool impact, so a bot has to harvest
 * moves clearly larger than that, and it has to be selective. On one-minute
 * cbBTC bars the reliable pattern is overreaction: a fast drop of half a
 * percent or more over the last hour tends to bounce back over the next one
 * to two hours, while strength after a fast rise tends to fade (and being
 * long-only we cannot fade it, we can only refuse to chase it).
 *
 * The bot, long only with at most one position:
 *
 *   - watches the trailing DIP_LOOK return; when it falls to -DIP_BPS or
 *     lower and the fall has stopped for a bar, the move counts as an
 *     overreaction and we buy, provided the slow regime filter passes: the
 *     close must not sit more than REGIME_TOL_BPS under the slow EMA, which
 *     keeps us out of a genuine collapse where dips keep dipping;
 *   - sizing is a fixed share of equity, additionally capped so the buy's
 *     own estimated price impact against the latest close's pool depth
 *     stays under IMPACT_CAP_BPS (impact is a real cost here, and it grows
 *     with size);
 *   - exits, first one that fires:
 *       target: close reaches TARGET_BPS over the actual fill price;
 *       stop: close falls STOP_BPS under the fill price;
 *       stale: MAX_HOLD bars pass without the bounce;
 *     Two further exits exist as switches and are off in the shipped setup
 *     (recovery to the fast EMA, and healing back to the pre-dip level):
 *     on the development window they closed trades before the snap-back
 *     had paid for the round trip;
 *   - after any exit, COOLDOWN bars must pass before the next dip counts,
 *     and a dip that is still deepening re-arms only on a fresh trigger.
 *
 * Everything is a deterministic function of the bars and fills seen so far:
 * no clock, no environment, no randomness. Money stays in bigints; only
 * the indicator averages use floating point, always updated in the same
 * order.
 */

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units (hello.fees also carries it)

// --- signal parameters ---------------------------------------------------
const DIP_LOOK = 45; // trailing return lookback for the dip, bars
const DIP_BPS = 50; // dip depth that triggers a buy, bps under the lookback
const EMA_FAST = 30; // recovery reference EMA, bars
const EMA_SLOW = 240; // regime EMA, bars
const REGIME_TOL_BPS = 250; // how far under the regime EMA a dip may sit, bps

// --- sizing ----------------------------------------------------------------
const SIZE_PCT = 100; // share of equity a buy may spend, percent
const IMPACT_CAP_BPS = 14; // cap on the buy's own estimated impact, bps

// --- exits -------------------------------------------------------------------
const TARGET_BPS = 85; // take profit over the fill price, bps
const RECOVERY_ON = 0; // 1: also exit when the close recovers to the fast EMA
const HEAL_ON = 0; // 1: also exit when the close heals back to the pre-dip level
const HEAL_TOL_BPS = 15; // how far under that level still counts as healed, bps
const STOP_BPS = 100; // hard stop under the fill price, bps
const MAX_HOLD = 150; // bars after which a stale position is closed
const COOLDOWN = 20; // bars to sit out after an exit
const DIP_STAB = 1; // 1: the dip must stop falling for a bar before we buy

// --- order plumbing ----------------------------------------------------------
const BUY_SLIP_BPS = 200; // max_slippage_bps sent with buys
const SELL_SLIP_BPS = 600; // max_slippage_bps sent with sells (exits must land)

/** The strategy state, advanced one batch at a time. */
class DipSnapper {
  closes: number[] = []; // every close seen, oldest first
  emaFast: number | null = null; // floating-point EMAs of the close
  emaSlow: number | null = null;
  entryPrice: bigint | null = null; // fill price of the open position
  entrySeq = -1; // batch seq whose fills opened it
  entryRef: number | null = null; // close DIP_LOOK bars before the entry dip
  pendingRef: number | null = null; // entry_ref candidate, set when a buy is sent
  lastExitSeq = -1_000_000_000;

  /** Learn entry/exit facts from the fills this batch carries. */
  noteFills(state: BarsState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      if (f.side === 'buy') {
        this.entryPrice = BigInt(f.price);
        this.entrySeq = state.seq;
        this.entryRef = this.pendingRef;
      } else {
        this.entryPrice = null;
        this.entrySeq = -1;
        this.entryRef = null;
        this.lastExitSeq = state.seq;
      }
    }
  }

  /** Fold one close into the EMAs; return the trailing dip in bps, or null. */
  indicators(close: number): number | null {
    this.closes.push(close);
    const kf = 2.0 / (EMA_FAST + 1);
    const ks = 2.0 / (EMA_SLOW + 1);
    if (this.emaFast === null || this.emaSlow === null) {
      this.emaFast = close;
      this.emaSlow = close;
    } else {
      this.emaFast += (close - this.emaFast) * kf;
      this.emaSlow += (close - this.emaSlow) * ks;
    }
    if (this.closes.length > DIP_LOOK) {
      const then = this.closes[this.closes.length - 1 - DIP_LOOK]!;
      return Math.floor((close * BPS) / then) - BPS;
    }
    return null;
  }

  /** Why the open position should close on this batch, or null. */
  exitReason(state: BarsState, close: number): string | null {
    if (this.entryPrice === null) {
      // The position is on the books but its fill was never noted (cannot
      // happen in this protocol; stay safe): price it from its recorded
      // cost so the exits still have a reference. cost is in quote units;
      // price = cost / qty at the symbol's scales: 10^(5+8-6) = 10^7.
      const held = state.positions.get(SYMBOL)!;
      this.entryPrice = (held.cost * 10_000_000n) / held.qty;
      this.entrySeq = state.seq;
      this.entryRef = close;
    }
    const entry = Number(this.entryPrice);
    if (close * BPS >= entry * (BPS + TARGET_BPS)) return 'target';
    if (RECOVERY_ON === 1 && this.emaFast !== null && close >= this.emaFast) return 'recovery';
    if (HEAL_ON === 1 && this.entryRef !== null) {
      if (close * BPS >= this.entryRef * (BPS - HEAL_TOL_BPS)) return 'healed';
    }
    if (close * BPS <= entry * (BPS - STOP_BPS)) return 'stop';
    if (state.seq - this.entrySeq >= MAX_HOLD) return 'stale';
    return null;
  }

  /** A buy order for this batch, or null to stay flat. */
  enter(state: BarsState, close: number, dipBps: number | null): OrderInput | null {
    if (dipBps === null || dipBps > -DIP_BPS) return null;
    if (DIP_STAB === 1 && this.closes.length >= 2) {
      if (this.closes[this.closes.length - 1]! < this.closes[this.closes.length - 2]!) return null;
    }
    if (state.seq - this.lastExitSeq < COOLDOWN) return null;
    if (this.closes.length <= Math.max(EMA_SLOW, DIP_LOOK)) return null;
    if (this.emaSlow !== null && close * BPS < this.emaSlow * (BPS - REGIME_TOL_BPS)) return null;
    let spend = (state.equity * BigInt(SIZE_PCT)) / 100n;
    if (spend > state.cash) spend = state.cash;
    const depth = state.depthAt(SYMBOL);
    if (depth !== null && depth.length > 0) {
      const cap = (depth[0]! * BigInt(IMPACT_CAP_BPS)) / BigInt(BPS);
      if (spend > cap) spend = cap;
    }
    if (spend < MIN_NOTIONAL) return null;
    this.pendingRef = this.closes[this.closes.length - 1 - DIP_LOOK]!;
    return { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: BUY_SLIP_BPS };
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    this.noteFills(state, batch);
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);
    const dipBps = this.indicators(close);
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      if (this.exitReason(state, close) !== null) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SELL_SLIP_BPS }];
      }
      return [];
    }
    const order = this.enter(state, close, dipBps);
    return order === null ? [] : [order];
  }
}

const bot = new DipSnapper();

await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
