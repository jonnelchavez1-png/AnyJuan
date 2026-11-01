import test from 'node:test';
import assert from 'node:assert/strict';
import { divRound, toCents, fromCents, parseAmount, parseQuantity, formatMoney, formatQuantity, formatPercent, toMilli } from '../src/lib/money.js';

test('divRound rounds half up and handles exact results', () => {
  assert.equal(divRound(1, 2), 1);
  assert.equal(divRound(1, 3), 0);
  assert.equal(divRound(2, 3), 1);
  assert.equal(divRound(5, 10), 1);
  assert.equal(divRound(4, 10), 0);
  assert.equal(divRound(10, 5), 2);
  assert.equal(divRound(0, 7), 0);
  assert.throws(() => divRound(1, 0));
});

test('cents conversion survives floating point', () => {
  assert.equal(toCents(19.29), 1929);
  assert.equal(toCents('205.71'), 20571);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(fromCents(1929), 19.29);
  assert.equal(toCents(null), 0);
  assert.equal(toCents('abc'), 0);
  assert.equal(toMilli(1.005), 1005);
});

test('parseAmount reads what people type', () => {
  assert.equal(parseAmount('1,234.50'), 123450);
  assert.equal(parseAmount(' 12 '), 1200);
  assert.equal(parseAmount('0.5'), 50);
  assert.equal(parseAmount('.5'), 50);
  assert.equal(parseAmount('12.'), 1200);
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('1.234'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

test('parseQuantity allows three decimals', () => {
  assert.equal(parseQuantity('1.5'), 1500);
  assert.equal(parseQuantity('0.125'), 125);
  assert.equal(parseQuantity('0.1234'), null);
  assert.equal(parseQuantity('2'), 2000);
  assert.equal(parseQuantity('x'), null);
});

test('formatMoney shows pesos by default and other currencies on request', () => {
  assert.match(formatMoney(123456), /₱\s?1,234\.56/);
  assert.match(formatMoney(-5000), /-₱\s?50\.00|₱-50\.00|-\s?₱\s?50\.00/);
  assert.match(formatMoney(0), /₱\s?0\.00/);
  assert.match(formatMoney(1050, { currency: 'USD', locale: 'en-US' }), /\$10\.50/);
  assert.match(formatMoney(NaN), /0\.00/);
  assert.match(formatMoney(100, { currency: 'ZZZZ' }), /1\.00/); // bad code falls back, never throws
});

test('formatQuantity and formatPercent are tidy', () => {
  assert.equal(formatQuantity(2000), '2');
  assert.equal(formatQuantity(1500), '1.5');
  assert.equal(formatQuantity(250), '0.25');
  assert.equal(formatPercent(0.1234), '12.3%');
  assert.equal(formatPercent(null), '–');
  assert.equal(formatPercent(NaN), '–');
});
