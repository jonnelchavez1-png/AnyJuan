import test from 'node:test';
import assert from 'node:assert/strict';
import { ratio, change, periodFigures, dashboardFigures } from '../src/lib/metrics.js';

const cur = { orders: 4, units: 9, gross_sales: 1000, discounts: 100, tax_collected: 96, billed: 900, net_sales: 804, cogs: 400, gross_profit: 404, collected: 700, expenses: 150, net_profit: 254 };
const prev = { orders: 0, units: 0, gross_sales: 0, discounts: 0, tax_collected: 0, billed: 0, net_sales: 0, cogs: 0, gross_profit: 0, collected: 0, expenses: 0, net_profit: 0 };

test('ratio refuses to divide by nothing', () => {
  assert.equal(ratio(5, 0), null);
  assert.equal(ratio(5, -1), null);
  assert.equal(ratio(1, 4), 0.25);
});

test('change reports a difference and a percentage only when one exists', () => {
  assert.deepEqual(change(150, 100), { diff: 50, pct: 0.5 });
  assert.deepEqual(change(50, 100), { diff: -50, pct: -0.5 });
  assert.deepEqual(change(10, 0), { diff: 10, pct: null });
  assert.deepEqual(change(0, 0), { diff: 0, pct: null });
});

test('figures are in cents and each measure stays separate', () => {
  const f = periodFigures(cur);
  assert.equal(f.netSales, 80400);
  assert.equal(f.billed, 90000);
  assert.equal(f.collected, 70000, 'collected is not the same as billed');
  assert.equal(f.taxCollected, 9600);
  assert.equal(f.grossProfit, 40400);
  assert.equal(f.netProfit, 25400);
  assert.equal(f.averageOrder, 20100);
  assert.ok(Math.abs(f.grossMargin - 404 / 804) < 1e-12);
  assert.ok(Math.abs(f.netMargin - 254 / 804) < 1e-12);
});

test('with no sales, margins and averages are null (shown as a dash), never NaN', () => {
  const f = periodFigures(prev);
  assert.equal(f.grossMargin, null);
  assert.equal(f.netMargin, null);
  assert.equal(f.averageOrder, null);
});

test('dashboard figures include comparisons and flag missing earlier data', () => {
  const d = dashboardFigures({ current: cur, previous: prev, receivables: { count: 2, amount: 200 } });
  assert.equal(d.receivables.amount, 20000);
  assert.equal(d.receivables.count, 2);
  assert.equal(d.compare.netSales.pct, null);
  assert.equal(d.hasPreviousData, false);
  const d2 = dashboardFigures({ current: cur, previous: cur, receivables: null });
  assert.equal(d2.compare.netSales.diff, 0);
  assert.equal(d2.hasPreviousData, true);
  assert.equal(d2.receivables.amount, 0);
});
