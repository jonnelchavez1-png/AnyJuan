// The return calculator. A line-for-line twin of plan_return() in supabase/setup.sql: the Return window uses it to
// show what a return is worth before it is saved, and the database works out the same numbers itself.
// tests/returns.test.js pins the rules, and tests-db/reconcile.mjs checks it against the real database.
//
// Rules (whole cents, quantities in milli-units):
//  1. Returning the LAST units of a line takes exactly what is left of that line, so repeated returns always add
//     up to the original sale to the cent.
//  2. Returning some units takes their share of the line (gross, discount, tax, cost), rounded half up.
//  3. The return's total is gross - discount (+ tax when tax was added on top of the price).
//  4. Money handed back = what the customer has paid beyond what they now owe. Unpaid sales just owe less.
//  5. Items put back in stock take their cost off cost of goods sold; damaged items (not restocked) do not.

import { divRound } from './money.js';

const share = (amount, qMilli, lineMilli) => divRound(amount * qMilli, lineMilli);

/**
 * @param {object} input
 * @param {{total:number, taxMode:string}} input.sale                 cents
 * @param {Array<{id:string, name?:string, qtyMilli:number, gross:number, discount:number, tax:number, total:number,
 *                unitCost:number, prior:{qtyMilli:number, gross:number, discount:number, tax:number, total:number, basis:number}}>} input.lines
 * @param {Array<{id:string, qtyMilli:number, restock?:boolean}>} input.items   what the customer brings back
 * @param {{paid:number, returned:number, refunded:number}} input.money         cents, before this return
 */
export function planReturn({ sale, lines, items, money }) {
  const seen = new Set();
  const out = [];
  let sub = 0; let disc = 0; let tax = 0; let total = 0; let cogs = 0;
  for (const it of items) {
    if (seen.has(it.id)) throw new Error('Each item can only be listed once.');
    seen.add(it.id);
    const l = lines.find((x) => x.id === it.id);
    if (!l) throw new Error('That item is not part of this sale.');
    const q = it.qtyMilli;
    if (!Number.isInteger(q) || q <= 0) throw new Error(`The quantity to return for "${l.name || 'item'}" is not valid.`);
    const remaining = l.qtyMilli - l.prior.qtyMilli;
    if (q > remaining) throw new Error(`You can return at most ${remaining / 1000} of "${l.name || 'item'}" (the rest was already returned).`);
    const lineCogs = divRound(l.qtyMilli * l.unitCost, 1000);
    let gross; let d; let t; let tot; let basis;
    if (q === remaining) {
      gross = l.gross - l.prior.gross; d = l.discount - l.prior.discount; t = l.tax - l.prior.tax;
      tot = l.total - l.prior.total; basis = lineCogs - l.prior.basis;
    } else {
      gross = Math.min(share(l.gross, q, l.qtyMilli), l.gross - l.prior.gross);
      d = Math.min(share(l.discount, q, l.qtyMilli), l.discount - l.prior.discount);
      t = Math.min(share(l.tax, q, l.qtyMilli), l.tax - l.prior.tax);
      tot = sale.taxMode === 'exclusive' ? gross - d + t : gross - d;
      tot = Math.min(tot, l.total - l.prior.total);
      basis = Math.min(share(lineCogs, q, l.qtyMilli), lineCogs - l.prior.basis);
    }
    const restock = it.restock !== false;
    const c = restock ? basis : 0;
    out.push({ id: l.id, name: l.name, qtyMilli: q, gross, discount: d, tax: t, total: tot, cogsBasis: basis, cogs: c, restocked: restock });
    sub += gross; disc += d; tax += t; total += tot; cogs += c;
  }
  const owed = sale.total - (money.returned + total) - (money.paid - money.refunded);
  return { lines: out, subtotal: sub, discount: disc, tax, total, net: total - tax, cogs, refund: Math.max(-owed, 0), balanceAfter: Math.max(owed, 0) };
}
