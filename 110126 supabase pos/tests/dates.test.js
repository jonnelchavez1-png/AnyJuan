import test from 'node:test';
import assert from 'node:assert/strict';
import { todayIn, addDays, addMonths, startOfWeek, startOfMonth, startOfQuarter, startOfYear, endOfMonth, endOfQuarter, rangeFor, previousRange, daysBetween, isYmd, describeRange, bucketSeries, startOfDayInstant } from '../src/lib/dates.js';

test('today is worked out in the business time zone, not UTC', () => {
  const instant = new Date('2026-10-24T20:30:00Z'); // 04:30 on 25 Oct in Manila (UTC+8), still 24 Oct in UTC
  assert.equal(todayIn('Asia/Manila', instant), '2026-10-25');
  assert.equal(todayIn('UTC', instant), '2026-10-24');
  assert.equal(todayIn('America/Los_Angeles', instant), '2026-10-24');
});

test('basic day and month arithmetic', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-10-25', -12), '2025-10-25');
  assert.equal(daysBetween('2026-10-01', '2026-10-25'), 24);
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfQuarter('2026-11-05'), '2026-12-31');
  assert.equal(startOfQuarter('2026-11-05'), '2026-10-01');
  assert.equal(startOfYear('2026-11-05'), '2026-01-01');
  assert.equal(startOfMonth('2026-11-05'), '2026-11-01');
});

test('week start can be Monday or Sunday', () => {
  // 25 Oct 2026 is a Sunday
  assert.equal(startOfWeek('2026-10-25', 1), '2026-10-19');
  assert.equal(startOfWeek('2026-10-25', 0), '2026-10-25');
  assert.equal(startOfWeek('2026-10-21', 1), '2026-10-19');
  assert.equal(startOfWeek('2026-10-19', 1), '2026-10-19');
});

test('presets run from the start of the period up to today', () => {
  const ctx = { today: '2026-10-25', weekStartsOn: 1 };
  assert.deepEqual(rangeFor('today', ctx), { from: '2026-10-25', to: '2026-10-25' });
  assert.deepEqual(rangeFor('week', ctx), { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(rangeFor('month', ctx), { from: '2026-10-01', to: '2026-10-25' });
  assert.deepEqual(rangeFor('quarter', ctx), { from: '2026-10-01', to: '2026-10-25' });
  assert.deepEqual(rangeFor('year', ctx), { from: '2026-01-01', to: '2026-10-25' });
  assert.deepEqual(rangeFor('custom', { ...ctx, custom: { from: '2026-09-01', to: '2026-09-30' } }), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(rangeFor('custom', { ...ctx, custom: { from: '2026-09-30', to: '2026-09-01' } }), { from: '2026-09-01', to: '2026-09-30' }, 'swapped dates are put in order');
  assert.deepEqual(rangeFor('custom', { ...ctx, custom: { from: 'nope', to: '' } }), { from: '2026-10-25', to: '2026-10-25' });
  assert.throws(() => rangeFor('decade', ctx));
});

test('comparison periods', () => {
  const ctx = { today: '2026-10-25', weekStartsOn: 1 };
  assert.deepEqual(previousRange('today', rangeFor('today', ctx)), { from: '2026-10-24', to: '2026-10-24' });
  assert.deepEqual(previousRange('week', rangeFor('week', ctx)), { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(previousRange('month', rangeFor('month', ctx)), { from: '2026-09-01', to: '2026-09-25' });
  assert.deepEqual(previousRange('quarter', rangeFor('quarter', ctx)), { from: '2026-07-01', to: '2026-07-25' });
  assert.deepEqual(previousRange('year', rangeFor('year', ctx)), { from: '2025-01-01', to: '2025-10-25' });
  assert.deepEqual(previousRange('custom', { from: '2026-09-10', to: '2026-09-19' }), { from: '2026-08-31', to: '2026-09-09' });
});

test('comparison never runs past the end of a shorter earlier month', () => {
  // 31 Oct so far vs September (30 days): capped at 30 Sep
  assert.deepEqual(previousRange('month', { from: '2026-10-01', to: '2026-10-31' }), { from: '2026-09-01', to: '2026-09-30' });
  // 29 Mar so far vs February 2026 (28 days)
  assert.deepEqual(previousRange('month', { from: '2026-03-01', to: '2026-03-29' }), { from: '2026-02-01', to: '2026-02-28' });
});

test('isYmd and describeRange', () => {
  assert.ok(isYmd('2026-02-28'));
  assert.ok(!isYmd('2026-02-30'));
  assert.ok(!isYmd('26-02-28'));
  assert.ok(!isYmd(null));
  const one = describeRange({ from: '2026-10-25', to: '2026-10-25' });
  assert.ok(/25/.test(one) && /2026/.test(one) && /Oct/.test(one), one);
  const same = describeRange({ from: '2026-10-01', to: '2026-10-25' });
  assert.ok(/1/.test(same) && /25/.test(same) && /Oct/.test(same) && /2026/.test(same), same);
  const cross = describeRange({ from: '2026-09-20', to: '2026-10-25' });
  assert.ok(/Sep/.test(cross) && /Oct/.test(cross) && /2026/.test(cross), cross);
});

test('series are grouped so a long range stays readable', () => {
  const mk = (n, start = '2026-01-01') => Array.from({ length: n }, (_, i) => ({ date: addDays(start, i), net_sales: 100, gross_profit: 40, expenses: 10, orders: 2 }));
  const day = bucketSeries(mk(30));
  assert.equal(day.unit, 'day');
  assert.equal(day.points.length, 30);
  const week = bucketSeries(mk(120));
  assert.equal(week.unit, 'week');
  assert.ok(week.points.length >= 17 && week.points.length <= 19);
  assert.equal(week.points.reduce((n, p) => n + p.net_sales, 0), 12000, 'totals are kept when grouping');
  const month = bucketSeries(mk(365));
  assert.equal(month.unit, 'month');
  assert.equal(month.points.length, 12);
  assert.equal(month.points.reduce((n, p) => n + p.orders, 0), 730);
  assert.deepEqual(bucketSeries([]), { unit: 'day', points: [] });
});

test('start of a day in a time zone as a real instant', () => {
  assert.equal(startOfDayInstant('2026-10-25', 'Asia/Manila').toISOString(), '2026-10-24T16:00:00.000Z');
  assert.equal(startOfDayInstant('2026-10-25', 'UTC').toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(startOfDayInstant('2026-01-15', 'America/New_York').toISOString(), '2026-01-15T05:00:00.000Z');
  assert.equal(startOfDayInstant('2026-07-15', 'America/New_York').toISOString(), '2026-07-15T04:00:00.000Z'); // daylight saving
  assert.equal(startOfDayInstant('2026-10-25', 'Pacific/Auckland').toISOString(), '2026-10-24T11:00:00.000Z');
});
