// DCA ladder calculator for linear (USDT-margined) perpetual futures.
// Zero dependencies. Works in the browser (<script type="module">) and in Node 18+.
//
// All results are estimates. Exchanges use tiered maintenance margin, mark price,
// funding and their own fee schedules, so real liquidation prices differ.

/**
 * @typedef {Object} LadderInput
 * @property {'long'|'short'} side
 * @property {number} entryPrice       Price of the first order.
 * @property {number} firstOrder       Position value of the first order, in USDT.
 * @property {number} orders           Total number of orders, including the first (1..100).
 * @property {number} stepPct          Distance from the first order to the second, in %.
 * @property {number} [stepScale=1]    Each next gap = previous gap x stepScale.
 * @property {number} [sizeScale=1]    Each next order = previous order x sizeScale.
 * @property {number} [takeProfitPct=1] Take-profit distance from the average entry, in % (under 100).
 * @property {number} [leverage=1]
 * @property {'isolated'|'cross'} [marginMode='isolated']
 * @property {number} [wallet]         Cross margin only: USDT in the futures wallet.
 * @property {number} [mmrPct=0.5]     Maintenance margin rate, in %.
 * @property {number} [feePct=0.05]    Fee per side, in % of position value.
 */

/** Largest total position the calculator will build, in USDT. */
export const MAX_POSITION = 1e12;

/** Input error that names the offending field, so a UI can point at it. */
export class LadderInputError extends RangeError {
  constructor(field, message) {
    super(message);
    this.name = 'LadderInputError';
    this.field = field;
  }
}

const num = (input, field, { min, max, def, minExclusive = false }) => {
  const raw = input[field];
  if (raw === undefined || raw === null || raw === '') {
    if (def === undefined) throw new LadderInputError(field, `${field} is required`);
    return def;
  }
  const n = Number(raw);
  const tooLow = minExclusive ? n <= min : n < min;
  if (!Number.isFinite(n) || tooLow || n > max) {
    const low = minExclusive ? `above ${min}` : `at least ${min}`;
    throw new LadderInputError(field, `${field} must be ${low} and at most ${max}`);
  }
  return n;
};

/** Validates and fills defaults. Throws LadderInputError (a RangeError) on bad input. */
export function normalize(input) {
  const side = input.side === 'short' ? 'short' : 'long';
  const marginMode = input.marginMode === 'cross' ? 'cross' : 'isolated';
  const out = {
    side,
    marginMode,
    entryPrice: num(input, 'entryPrice', { min: 0, minExclusive: true, max: 1e9 }),
    firstOrder: num(input, 'firstOrder', { min: 0, minExclusive: true, max: 1e9 }),
    orders: Math.round(num(input, 'orders', { min: 1, max: 100 })),
    stepPct: 0,
    stepScale: num(input, 'stepScale', { min: 0.1, max: 10, def: 1 }),
    sizeScale: num(input, 'sizeScale', { min: 0.1, max: 10, def: 1 }),
    takeProfitPct: num(input, 'takeProfitPct', { min: 0, max: 99, def: 1 }),
    leverage: num(input, 'leverage', { min: 1, max: 200, def: 1 }),
    mmrPct: num(input, 'mmrPct', { min: 0, max: 50, def: 0.5 }),
    feePct: num(input, 'feePct', { min: 0, max: 5, def: 0.05 }),
    wallet: null,
  };
  out.stepPct = num(input, 'stepPct', { min: 0, max: 99, def: out.orders === 1 ? 0 : undefined });
  if (marginMode === 'cross') out.wallet = num(input, 'wallet', { min: 0, max: 1e12 });
  return out;
}

/**
 * Liquidation price of a single linear position.
 * Long:  collateral + Q(L - P) = mmr * Q * L  ->  L = (Q*P - collateral) / (Q * (1 - mmr))
 * Short: collateral + Q(P - L) = mmr * Q * L  ->  L = (Q*P + collateral) / (Q * (1 + mmr))
 * Returns null when a long cannot be liquidated by price alone (L <= 0).
 */
export function liquidationPrice(side, qty, avgEntry, collateral, mmr) {
  if (qty <= 0) return null;
  if (side === 'long') {
    const l = (qty * avgEntry - collateral) / (qty * (1 - mmr));
    // Treat floating-point dust as "no liquidation" (e.g. 1x isolated longs).
    return l > avgEntry * 1e-9 ? l : null;
  }
  return (qty * avgEntry + collateral) / (qty * (1 + mmr));
}

/** Price at which closing the whole position nets zero after entry and exit fees. */
export function breakEvenPrice(side, avgEntry, fee) {
  return side === 'long' ? (avgEntry * (1 + fee)) / (1 - fee) : (avgEntry * (1 - fee)) / (1 + fee);
}

/**
 * Builds the ladder. One row per order, describing the position right after that order fills.
 * @param {LadderInput} input
 */
export function buildLadder(input) {
  const p = normalize(input);
  const long = p.side === 'long';
  const mmr = p.mmrPct / 100;
  const fee = p.feePct / 100;

  const rows = [];
  let gap = p.stepPct;
  let deviation = 0;
  let orderValue = p.firstOrder;
  let qty = 0;
  let cost = 0;
  let walletShortAtOrder = null;

  for (let i = 0; i < p.orders; i++) {
    if (i > 0) {
      deviation += gap;
      gap *= p.stepScale;
      orderValue *= p.sizeScale;
    }
    if (long && deviation >= 100) break; // price cannot go to zero or below
    if (cost + orderValue > MAX_POSITION) {
      throw new LadderInputError('sizeScale', `The ladder grows past ${MAX_POSITION.toExponential(0)} USDT. Lower the size multiplier or the number of orders.`);
    }

    const price = p.entryPrice * (1 + ((long ? -1 : 1) * deviation) / 100);

    // Cross margin: can the wallet open this order, counting the open loss so far?
    if (p.marginMode === 'cross' && walletShortAtOrder === null) {
      const openPnl = long ? qty * price - cost : cost - qty * price;
      const free = p.wallet + openPnl - cost / p.leverage;
      if (orderValue / p.leverage > free + 1e-9) walletShortAtOrder = i + 1;
    }

    qty += orderValue / price;
    cost += orderValue;
    if (!Number.isFinite(qty)) {
      throw new LadderInputError('entryPrice', 'Entry price is too small for this order size.');
    }
    const avg = cost / qty;
    const margin = cost / p.leverage;
    const collateral = p.marginMode === 'cross' ? p.wallet : margin;
    const liq = liquidationPrice(p.side, qty, avg, collateral, mmr);
    const tp = long ? avg * (1 + p.takeProfitPct / 100) : avg * (1 - p.takeProfitPct / 100);
    // Signed distance from this fill to liquidation; <= 0 means the position is liquidated at once.
    const room = liq === null ? null : ((long ? price - liq : liq - price) / price) * 100;

    rows.push({
      order: i + 1,
      price,
      deviationPct: deviation,
      orderValue,
      positionValue: cost,
      qty,
      avgEntry: avg,
      takeProfit: tp,
      breakEven: breakEvenPrice(p.side, avg, fee),
      margin,
      liquidation: liq,
      roomToLiqPct: room,
      // Small tolerance so rounding noise at leverage = 1 / mmr does not flip the flag.
      liquidatedAtFill: room !== null && room <= 1e-9,
      // Would the next order (if any) sit beyond the liquidation price?
      liqBeforeNext: false,
    });
  }

  for (let i = 0; i < rows.length - 1; i++) {
    const liq = rows[i].liquidation;
    if (liq === null) continue;
    const next = rows[i + 1].price;
    rows[i].liqBeforeNext = long ? next <= liq : next >= liq;
  }

  const last = rows[rows.length - 1];
  const firstBlocked = rows.find((r) => r.liqBeforeNext);
  const firstLiquidated = rows.find((r) => r.liquidatedAtFill);
  return {
    input: p,
    rows,
    summary: {
      ordersPlaced: rows.length,
      totalPositionValue: last.positionValue,
      totalMargin: last.margin,
      maxDeviationPct: last.deviationPct,
      finalAvgEntry: last.avgEntry,
      finalTakeProfit: last.takeProfit,
      finalLiquidation: last.liquidation,
      // Cross margin: wallet must cover the margin of every order.
      walletShortfall: p.marginMode === 'cross' ? Math.max(0, last.margin - p.wallet) : 0,
      // Cross margin: first order the wallet cannot open once open losses are counted.
      walletShortAtOrder,
      // First order whose fill is already at or beyond the liquidation price.
      liquidatedAtOrder: firstLiquidated ? firstLiquidated.order : null,
      // First order that could never fill because liquidation comes first.
      liquidatedBeforeOrder: firstBlocked ? firstBlocked.order + 1 : null,
    },
  };
}
