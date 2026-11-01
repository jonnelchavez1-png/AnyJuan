// Turns the numbers the database returns into the figures the dashboard shows.
// Amounts from the database are plain numbers (e.g. 205.71); the dashboard works in cents.
import { toCents } from './money.js';

/** part / whole, or null when there is nothing to divide by (so the screen shows a dash, not 0% or NaN). */
export function ratio(part, whole) {
  if (!whole || whole <= 0) return null;
  return part / whole;
}

/** Change between two numbers: { diff, pct }. pct is null when the earlier value is 0 (it would be infinite). */
export function change(current, previous) {
  const diff = current - previous;
  return { diff, pct: previous ? diff / Math.abs(previous) : null };
}

/** Convert one period's totals from the database into cents plus the derived ratios. */
export function periodFigures(t) {
  if (!t) return null;
  const c = (k) => toCents(t[k]);
  const net = c('net_sales');
  const gross = c('gross_profit');
  const netProfit = c('net_profit');
  const orders = Number(t.orders) || 0;
  return {
    orders,
    units: Number(t.units) || 0,
    grossSales: c('gross_sales'),
    discounts: c('discounts'),
    taxCollected: c('tax_collected'),
    billed: c('billed'),
    netSales: net,
    cogs: c('cogs'),
    grossProfit: gross,
    collected: c('collected'),
    expenses: c('expenses'),
    netProfit,
    grossMargin: ratio(gross, net),
    netMargin: ratio(netProfit, net),
    averageOrder: orders ? Math.round(net / orders) : null,
  };
}

/** Everything the dashboard shows, ready to draw. */
export function dashboardFigures(report) {
  const current = periodFigures(report.current);
  const previous = periodFigures(report.previous);
  const compare = {};
  for (const key of ['netSales', 'grossProfit', 'expenses', 'netProfit', 'orders', 'collected', 'billed', 'taxCollected']) {
    compare[key] = change(current[key], previous[key]);
  }
  return {
    current,
    previous,
    compare,
    receivables: { count: Number(report.receivables?.count) || 0, amount: toCents(report.receivables?.amount) },
    hasPreviousData: previous.orders > 0 || previous.expenses > 0,
  };
}
