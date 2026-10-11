import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLadder, liquidationPrice, breakEvenPrice, normalize, LadderInputError } from '../ladder.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('single long order at 10x isolated matches the textbook formula', () => {
  const { rows } = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 1000, orders: 1, leverage: 10, mmrPct: 0.5 });
  // L = P * (1 - 1/lev) / (1 - mmr)
  close(rows[0].liquidation, (100 * (1 - 0.1)) / (1 - 0.005));
  close(rows[0].avgEntry, 100);
  close(rows[0].margin, 100);
});

test('single short order at 10x isolated matches the textbook formula', () => {
  const { rows } = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 1000, orders: 1, leverage: 10, mmrPct: 0.5 });
  // L = P * (1 + 1/lev) / (1 + mmr)
  close(rows[0].liquidation, (100 * (1 + 0.1)) / (1 + 0.005));
});

test('equal-size long ladder: prices, quantity-weighted average', () => {
  const { rows } = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 3, stepPct: 10, leverage: 1 });
  close(rows[1].price, 90);
  close(rows[2].price, 80);
  const qty = 1 + 100 / 90 + 100 / 80;
  close(rows[2].qty, qty);
  close(rows[2].avgEntry, 300 / qty); // harmonic mean, not 90
  assert.ok(rows[2].avgEntry < 90);
});

test('step and size scales compound', () => {
  const { rows } = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 10, orders: 4, stepPct: 2, stepScale: 2, sizeScale: 3 });
  assert.deepEqual(rows.map((r) => r.deviationPct), [0, 2, 6, 14]);
  assert.deepEqual(rows.map((r) => r.orderValue), [10, 30, 90, 270]);
  close(rows[3].positionValue, 400);
});

test('short ladder adds above the entry', () => {
  const { rows } = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 10, orders: 3, stepPct: 5 });
  close(rows[1].price, 105);
  close(rows[2].price, 110);
  assert.ok(rows[2].takeProfit < rows[2].avgEntry);
});

test('1x long isolated cannot be liquidated by price', () => {
  const { rows } = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 1, leverage: 1, mmrPct: 0.5 });
  assert.equal(rows[0].liquidation, null);
});

test('cross margin uses the wallet, more wallet = lower long liquidation', () => {
  const base = { side: 'long', entryPrice: 100, firstOrder: 1000, orders: 1, leverage: 10, marginMode: 'cross' };
  const small = buildLadder({ ...base, wallet: 200 }).rows[0].liquidation;
  const big = buildLadder({ ...base, wallet: 500 }).rows[0].liquidation;
  assert.ok(big < small);
  close(small, liquidationPrice('long', 10, 100, 200, 0.005));
});

test('cross margin reports a wallet shortfall', () => {
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 1000, orders: 2, stepPct: 5, leverage: 5, marginMode: 'cross', wallet: 300 });
  close(r.summary.totalMargin, 400);
  close(r.summary.walletShortfall, 100);
});

test('flags when liquidation comes before the next order', () => {
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 3, stepPct: 20, leverage: 10 });
  assert.equal(r.rows[0].liqBeforeNext, true);
  assert.equal(r.summary.liquidatedBeforeOrder, 2);
});

test('long ladder stops before price reaches zero', () => {
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 10, orders: 20, stepPct: 10 });
  assert.equal(r.rows.length, 10); // 0..90% down; 100% is impossible
});

test('break-even covers fees on both sides', () => {
  const be = breakEvenPrice('long', 100, 0.001);
  const pnl = (be - 100) - 0.001 * 100 - 0.001 * be;
  close(pnl, 0);
  const bs = breakEvenPrice('short', 100, 0.001);
  close((100 - bs) - 0.001 * 100 - 0.001 * bs, 0);
});

test('rejects nonsense input and names the field', () => {
  const field = (input) => {
    try { normalize(input); } catch (e) { assert.ok(e instanceof LadderInputError); return e.field; }
    return null;
  };
  assert.equal(field({ side: 'long', entryPrice: 0, firstOrder: 10, orders: 1 }), 'entryPrice');
  assert.equal(field({ side: 'long', entryPrice: 10, firstOrder: 10, orders: 0 }), 'orders');
  assert.equal(field({ side: 'long', entryPrice: 10, firstOrder: 10, orders: 2, stepPct: 1, marginMode: 'cross' }), 'wallet');
  assert.equal(field({ side: 'long', entryPrice: 10, firstOrder: 10, orders: 3, stepPct: '' }), 'stepPct');
  assert.equal(field({ side: 'short', entryPrice: 10, firstOrder: 10, orders: 1, takeProfitPct: 100 }), 'takeProfitPct');
  assert.equal(field({ side: 'long', entryPrice: 'abc', firstOrder: 10, orders: 1 }), 'entryPrice');
});

test('empty optional fields fall back to defaults, not zero', () => {
  const p = normalize({ side: 'long', entryPrice: 10, firstOrder: 10, orders: 1, mmrPct: '', feePct: '', leverage: '' });
  assert.equal(p.mmrPct, 0.5);
  assert.equal(p.feePct, 0.05);
  assert.equal(p.leverage, 1);
});

test('take-profit sits above the average for a long and below for a short', () => {
  const l = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 2, stepPct: 10, takeProfitPct: 2 });
  close(l.rows[1].takeProfit, l.rows[1].avgEntry * 1.02);
  const s = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 100, orders: 2, stepPct: 10, takeProfitPct: 2 });
  close(s.rows[1].takeProfit, s.rows[1].avgEntry * 0.98);
  close(normalize({ side: 'long', entryPrice: 1, firstOrder: 1, orders: 1 }).takeProfitPct, 1);
});

test('rows use the fee for break-even', () => {
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 1, feePct: 0.1 });
  close(r.rows[0].breakEven, (100 * 1.001) / 0.999);
  const d = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 100, orders: 1 });
  close(d.rows[0].breakEven, (100 * 0.9995) / 1.0005);
});

test('summary cards come from the last row', () => {
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 4, stepPct: 3, sizeScale: 2, leverage: 2 });
  const last = r.rows[3];
  assert.equal(r.summary.finalAvgEntry, last.avgEntry);
  assert.equal(r.summary.finalTakeProfit, last.takeProfit);
  assert.equal(r.summary.finalLiquidation, last.liquidation);
  assert.equal(r.summary.maxDeviationPct, 9);
  assert.equal(r.summary.totalMargin, 750);
});

test('short ladder flags liquidation before the next order', () => {
  // 10x short: L = 100 * 1.1 / 1.005 = 109.45 < 115, so order 2 never fills.
  const r = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 100, orders: 3, stepPct: 15, leverage: 10 });
  assert.equal(r.rows[0].liqBeforeNext, true);
  assert.equal(r.summary.liquidatedBeforeOrder, 2);
  const ok = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 100, orders: 2, stepPct: 5, leverage: 10 });
  assert.equal(ok.rows[0].liqBeforeNext, false);
  assert.equal(ok.summary.liquidatedBeforeOrder, null);
});

test('cross short uses the wallet', () => {
  const r = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 1000, orders: 1, leverage: 10, marginMode: 'cross', wallet: 500 });
  close(r.rows[0].liquidation, (10 * 100 + 500) / (10 * 1.005));
});

test('room to liquidation is signed and flags positions liquidated on fill', () => {
  const ok = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 1, leverage: 10 });
  close(ok.rows[0].roomToLiqPct, 100 - (90 / 0.995));
  assert.equal(ok.rows[0].liquidatedAtFill, false);
  const dead = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 1, leverage: 200, mmrPct: 1 });
  assert.ok(dead.rows[0].roomToLiqPct < 0);
  assert.equal(dead.summary.liquidatedAtOrder, 1);
  const broke = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 100, orders: 1, leverage: 10, marginMode: 'cross', wallet: 0 });
  assert.equal(broke.summary.liquidatedAtOrder, 1);
});

test('cross wallet check counts open losses', () => {
  // Order 1: 300 @100 (margin 100). Order 2 at 90: open loss 30, free = 300 - 30 - 100 = 170 < 200 margin.
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 300, orders: 2, stepPct: 10, sizeScale: 2, leverage: 3, marginMode: 'cross', wallet: 300 });
  assert.equal(r.summary.walletShortAtOrder, 2);
  const fine = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 300, orders: 2, stepPct: 10, sizeScale: 2, leverage: 3, marginMode: 'cross', wallet: 330 });
  assert.equal(fine.summary.walletShortAtOrder, null);
});

test('1x long never shows a dust liquidation price', () => {
  const r = buildLadder({ side: 'long', entryPrice: 2.37, firstOrder: 100, orders: 3, stepPct: 2, stepScale: 1.3, sizeScale: 1.5, leverage: 1 });
  assert.ok(r.rows.every((row) => row.liquidation === null));
});

test('refuses ladders that grow absurdly large', () => {
  assert.throws(() => buildLadder({ side: 'long', entryPrice: 100, firstOrder: 1e6, orders: 100, stepPct: 0.1, sizeScale: 10 }), LadderInputError);
});

test('limits: take-profit below 0, mmr above 50 and fractional orders', () => {
  assert.throws(() => normalize({ side: 'long', entryPrice: 1, firstOrder: 1, orders: 1, takeProfitPct: -1 }), LadderInputError);
  assert.throws(() => normalize({ side: 'long', entryPrice: 1, firstOrder: 1, orders: 1, mmrPct: 51 }), LadderInputError);
  assert.equal(normalize({ side: 'long', entryPrice: 1, firstOrder: 1, orders: 2.6, stepPct: 1 }).orders, 3);
  // orders rounds to 1, so an empty step is fine
  assert.equal(normalize({ side: 'long', entryPrice: 1, firstOrder: 1, orders: 1.4, stepPct: '' }).stepPct, 0);
});

test('a liquidation exactly at the fill counts as liquidated; the first such order is reported', () => {
  // leverage = 1/mmr puts the liquidation exactly on the entry
  for (const entryPrice of [3, 100, 180.83]) {
    const r = buildLadder({ side: 'long', entryPrice, firstOrder: 100, orders: 1, leverage: 200, mmrPct: 0.5 });
    assert.equal(r.summary.liquidatedAtOrder, 1, `entry ${entryPrice}`);
  }
  const many = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 3, stepPct: 0.1, leverage: 200, mmrPct: 1 });
  assert.equal(many.summary.liquidatedAtOrder, 1);
});

test('real low liquidation prices are not hidden as dust', () => {
  // 1.0101x long: liquidation near 1% of entry must still be shown
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 1, leverage: 1.0101, mmrPct: 0 });
  assert.ok(r.rows[0].liquidation !== null && r.rows[0].liquidation > 0.9 && r.rows[0].liquidation < 1.1);
});

test('liquidation exactly at the next order price blocks it, for long and short', () => {
  // isolated 2x long, mmr 0: L = P/2. With a 50% step the next order sits exactly on L.
  const l = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 100, orders: 2, stepPct: 50, leverage: 2, mmrPct: 0 });
  assert.equal(l.rows[0].liqBeforeNext, true);
  // isolated 2x short, mmr 0: L = 1.5P. With a 50% step the next order sits exactly on L.
  const s = buildLadder({ side: 'short', entryPrice: 100, firstOrder: 100, orders: 2, stepPct: 50, leverage: 2, mmrPct: 0 });
  assert.equal(s.rows[0].liqBeforeNext, true);
});

test('cross wallet check reports the first short order, not a later one', () => {
  const r = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 300, orders: 4, stepPct: 10, sizeScale: 2, leverage: 3, marginMode: 'cross', wallet: 300 });
  assert.equal(r.summary.walletShortAtOrder, 2);
  // free margin 0.5 short of the order margin must still be reported
  const tight = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 300, orders: 1, leverage: 3, marginMode: 'cross', wallet: 99.5 });
  assert.equal(tight.summary.walletShortAtOrder, 1);
});

test('size limit error points at the size multiplier, and the limit is 1e12', () => {
  try {
    buildLadder({ side: 'long', entryPrice: 100, firstOrder: 1e9, orders: 5, stepPct: 1, sizeScale: 10 });
    assert.fail('should throw');
  } catch (e) {
    assert.equal(e.field, 'sizeScale');
  }
  const ok = buildLadder({ side: 'long', entryPrice: 100, firstOrder: 1e9, orders: 3, stepPct: 1, sizeScale: 9 });
  assert.equal(ok.rows.length, 3); // 1e9 + 9e9 + 8.1e10 < 1e12
});

test('an exact tie on prices that do not round cleanly still blocks the next order', () => {
  // entry 3, 10x, mmr 0: liquidation 2.6999999999999997 vs next order 2.7; a plain comparison let the order fill
  const l = buildLadder({ side: 'long', entryPrice: 3, firstOrder: 100, orders: 2, stepPct: 10, stepScale: 1, sizeScale: 1, leverage: 10, mmrPct: 0 });
  assert.equal(l.rows[0].liqBeforeNext, true);
  assert.equal(l.summary.liquidatedBeforeOrder, 2);
  const s = buildLadder({ side: 'short', entryPrice: 29, firstOrder: 100, orders: 2, stepPct: 20, stepScale: 1, sizeScale: 1, leverage: 5, mmrPct: 0 });
  assert.equal(s.rows[0].liqBeforeNext, true);
  // a real gap, however small (~0.00001%), is not swallowed by the tolerance
  const near = buildLadder({ side: 'long', entryPrice: 3, firstOrder: 100, orders: 2, stepPct: 9.99999, stepScale: 1, sizeScale: 1, leverage: 10, mmrPct: 0 });
  assert.equal(near.rows[0].liqBeforeNext, false);
});

test('the tie check is relative, so it works the same on sub-cent prices', () => {
  const tie = buildLadder({ side: 'long', entryPrice: 3e-6, firstOrder: 100, orders: 2, stepPct: 10, stepScale: 1, sizeScale: 1, leverage: 10, mmrPct: 0 });
  assert.equal(tie.rows[0].liqBeforeNext, true);
  // a ~0.00001% gap on a 0.000003 price is ~3e-13 absolute: must not count as a tie
  const gap = buildLadder({ side: 'long', entryPrice: 3e-6, firstOrder: 100, orders: 2, stepPct: 9.99999, stepScale: 1, sizeScale: 1, leverage: 10, mmrPct: 0 });
  assert.equal(gap.rows[0].liqBeforeNext, false);
});
