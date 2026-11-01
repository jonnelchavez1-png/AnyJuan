import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSale } from '../src/lib/tax.js';

const off = { enabled: false, rate: 0, mode: 'inclusive' };
const incl = (rate = 12) => ({ enabled: true, rate, mode: 'inclusive' });
const excl = (rate = 12) => ({ enabled: true, rate, mode: 'exclusive' });

test('no tax: total is just the sum of the lines', () => {
  const r = computeSale({ lines: [{ qty: 2, priceCents: 1500 }, { qty: 1, priceCents: 999 }], tax: off });
  assert.equal(r.subtotal, 3999);
  assert.equal(r.tax, 0);
  assert.equal(r.total, 3999);
  assert.equal(r.net, 3999);
  assert.equal(r.mode, 'none');
});

test('tax switched on but rate 0 behaves like no tax', () => {
  const r = computeSale({ lines: [{ qty: 1, priceCents: 1000 }], tax: { enabled: true, rate: 0, mode: 'exclusive' } });
  assert.equal(r.mode, 'none');
  assert.equal(r.total, 1000);
});

test('inclusive tax: customer pays the shelf price, tax is carved out of it (12%)', () => {
  const r = computeSale({ lines: [{ qty: 1, priceCents: 11200 }], tax: incl(12) });
  assert.equal(r.total, 11200);
  assert.equal(r.tax, 1200);
  assert.equal(r.net, 10000);
});

test('exclusive tax: tax is added on top (12%)', () => {
  const r = computeSale({ lines: [{ qty: 1, priceCents: 10000 }], tax: excl(12) });
  assert.equal(r.tax, 1200);
  assert.equal(r.total, 11200);
  assert.equal(r.net, 10000);
});

test('same scenario as supabase/verify.sql: 10% discount, inclusive 12%, one exempt product', () => {
  const r = computeSale({
    lines: [{ qty: 2, priceCents: 10000, costCents: 4000 }, { qty: 1, priceCents: 5000, costCents: 2000, taxExempt: true }],
    discount: { type: 'percent', value: 10 },
    tax: incl(12),
  });
  assert.equal(r.subtotal, 25000);
  assert.equal(r.discount, 2500);
  assert.deepEqual(r.lines.map((l) => l.discount), [2000, 500]);
  assert.equal(r.tax, 1929); // 18000 x 12 / 112 = 1928.57 -> 19.29
  assert.equal(r.total, 22500);
  assert.equal(r.net, 20571);
  assert.equal(r.cogs, 10000);
});

test('exclusive example from verify.sql', () => {
  const r = computeSale({ lines: [{ qty: 1, priceCents: 10000 }], tax: excl(12) });
  assert.deepEqual([r.tax, r.total, r.net], [1200, 11200, 10000]);
});

test('exempt products never carry tax in either mode', () => {
  for (const tax of [incl(), excl()]) {
    const r = computeSale({ lines: [{ qty: 3, priceCents: 1000, taxExempt: true }], tax });
    assert.equal(r.tax, 0);
    assert.equal(r.total, 3000);
  }
});

test('discount is shared to the cent: the pieces always add up to the whole', () => {
  // 3 equal lines, fixed discount of 1.00 -> 33 + 33 + 33 = 99, the extra cent goes to the first line
  const r = computeSale({
    lines: [{ qty: 1, priceCents: 1000 }, { qty: 1, priceCents: 1000 }, { qty: 1, priceCents: 1000 }],
    discount: { type: 'amount', value: 100 },
    tax: off,
  });
  assert.deepEqual(r.lines.map((l) => l.discount), [34, 33, 33]);
  assert.equal(r.lines.reduce((n, l) => n + l.discount, 0), 100);
  assert.equal(r.total, 2900);
});

test('largest remainder gets the leftover cent, ties go to the earlier line', () => {
  // gross 1.00, 2.00 ; discount 0.10 -> shares 3.333 and 6.666 cents -> floors 3 + 6, leftover 1 -> second line (.666)
  const r = computeSale({ lines: [{ qty: 1, priceCents: 100 }, { qty: 1, priceCents: 200 }], discount: { type: 'amount', value: 10 }, tax: off });
  assert.deepEqual(r.lines.map((l) => l.discount), [3, 7]);
});

test('discount can never exceed the subtotal or go below zero', () => {
  const big = computeSale({ lines: [{ qty: 1, priceCents: 500 }], discount: { type: 'amount', value: 99999 }, tax: off });
  assert.equal(big.discount, 500);
  assert.equal(big.total, 0);
  const neg = computeSale({ lines: [{ qty: 1, priceCents: 500 }], discount: { type: 'amount', value: -50 }, tax: off });
  assert.equal(neg.discount, 0);
  const over = computeSale({ lines: [{ qty: 1, priceCents: 500 }], discount: { type: 'percent', value: 250 }, tax: off });
  assert.equal(over.discount, 500);
});

test('decimal quantities (weights) round the line to the cent', () => {
  const r = computeSale({ lines: [{ qty: 0.375, priceCents: 5500 }], tax: off });
  assert.equal(r.subtotal, 2063); // 20.625 -> 20.63 (half up) is 2063
  const r2 = computeSale({ lines: [{ qty: 1.5, priceCents: 1999 }], tax: off });
  assert.equal(r2.subtotal, 2999); // 29.985 -> 29.99
});

test('empty cart and zero prices do not break', () => {
  const r = computeSale({ lines: [], tax: incl() });
  assert.deepEqual([r.subtotal, r.discount, r.tax, r.total, r.net], [0, 0, 0, 0, 0]);
  const z = computeSale({ lines: [{ qty: 2, priceCents: 0 }], discount: { type: 'percent', value: 10 }, tax: excl() });
  assert.equal(z.total, 0);
});

test('percent discount rounds half up and supports decimals (7.5%)', () => {
  const r = computeSale({ lines: [{ qty: 1, priceCents: 1001 }], discount: { type: 'percent', value: 7.5 }, tax: off });
  assert.equal(r.discount, 75); // 75.075 -> 75
  const r2 = computeSale({ lines: [{ qty: 1, priceCents: 1000 }], discount: { type: 'percent', value: 0.05 }, tax: off });
  assert.equal(r2.discount, 1); // 0.5 -> 1 (half up)
});

test('total always equals the sum of its parts', () => {
  for (let seed = 1; seed <= 300; seed++) {
    let x = seed;
    const rnd = (n) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % n; };
    const lines = Array.from({ length: 1 + rnd(5) }, () => ({ qty: (1 + rnd(5000)) / 1000, priceCents: rnd(100000), costCents: rnd(50000), taxExempt: rnd(4) === 0 }));
    const tax = [off, incl(12), excl(12), excl(7.5), incl(5.25)][rnd(5)];
    const discount = [null, { type: 'percent', value: rnd(101) }, { type: 'amount', value: rnd(200000) }][rnd(3)];
    const r = computeSale({ lines, discount, tax });
    assert.equal(r.lines.reduce((n, l) => n + l.gross, 0), r.subtotal);
    assert.equal(r.lines.reduce((n, l) => n + l.discount, 0), r.discount, `seed ${seed}: discounts add up`);
    assert.equal(r.lines.reduce((n, l) => n + l.total, 0), r.total);
    assert.equal(r.net, r.total - r.tax);
    assert.ok(r.lines.every((l) => l.discount >= 0 && l.discount <= l.gross && l.tax >= 0));
    assert.ok(r.total >= 0 && r.net >= 0, `seed ${seed}: no negative money`);
  }
});
