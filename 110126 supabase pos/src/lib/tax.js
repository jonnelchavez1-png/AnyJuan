// The sale calculator. This is a line-for-line twin of the create_sale function in
// supabase/setup.sql: the cart uses it to show what the customer will pay, and the database
// recomputes the same numbers itself (it never trusts these). tests/tax.test.js pins the rules.
//
// Rules (all in whole cents):
//  1. line gross = quantity x price, rounded half up
//  2. order discount (percent or fixed amount) is shared over the lines to the cent: every line's share is
//     rounded down and the leftover cents go to the lines that lost the most (earlier line wins a tie)
//  3. tax is optional. When on and the rate is above 0:
//       inclusive: prices already contain tax.  tax = amount x rate / (100 + rate);  customer pays the amount
//       exclusive: prices are before tax.        tax = amount x rate / 100;          customer pays amount + tax
//     products marked "tax exempt" never get tax. Tax is rounded per line.
//  4. net sales (revenue) = total - tax. Tax is money held for the government, not revenue.

import { divRound, toMilli } from './money.js';

/**
 * @param {object} input
 * @param {Array<{qty:number, priceCents:number, costCents?:number, taxExempt?:boolean}>} input.lines  qty in real units (1.5)
 * @param {{type:'percent'|'amount', value:number}|null} [input.discount]  percent as 10 for 10%; amount in cents
 * @param {{enabled:boolean, rate:number, mode:'inclusive'|'exclusive'}} [input.tax]
 */
export function computeSale({ lines, discount = null, tax = { enabled: false, rate: 0, mode: 'inclusive' } }) {
  const rateMilli = Math.round((Number(tax?.rate) || 0) * 1000);
  const mode = tax?.enabled && rateMilli > 0 ? tax.mode : 'none';

  const rows = lines.map((l) => {
    const qtyMilli = toMilli(l.qty);
    const gross = divRound(qtyMilli * l.priceCents, 1000);
    const cost = divRound(qtyMilli * (l.costCents || 0), 1000);
    return { gross, cost, discount: 0, tax: 0, total: 0, exempt: !!l.taxExempt };
  });

  const subtotal = rows.reduce((n, r) => n + r.gross, 0);

  let discountTotal = 0;
  if (discount && subtotal > 0) {
    const v = Number(discount.value) || 0;
    if (discount.type === 'percent') {
      discountTotal = divRound(subtotal * Math.round(Math.min(Math.max(v, 0), 100) * 1000), 100000);
    } else if (discount.type === 'amount') {
      discountTotal = Math.min(Math.max(Math.round(v), 0), subtotal);
    }
  }

  if (discountTotal > 0) {
    // BigInt keeps these products exact however large the amounts are
    const D = BigInt(discountTotal);
    const S = BigInt(subtotal);
    let given = 0;
    const rem = rows.map((r, i) => {
      const exact = D * BigInt(r.gross); // share = exact / subtotal
      r.discount = Number(exact / S);
      given += r.discount;
      return { i, frac: exact % S };
    });
    let left = discountTotal - given;
    rem.sort((a, b) => (a.frac === b.frac ? a.i - b.i : a.frac > b.frac ? -1 : 1));
    for (const { i } of rem) {
      if (left <= 0) break;
      rows[i].discount += 1;
      left -= 1;
    }
  }

  for (const r of rows) {
    const amount = r.gross - r.discount;
    if (mode === 'inclusive') {
      r.tax = r.exempt ? 0 : divRound(amount * rateMilli, 100000 + rateMilli);
      r.total = amount;
    } else if (mode === 'exclusive') {
      r.tax = r.exempt ? 0 : divRound(amount * rateMilli, 100000);
      r.total = amount + r.tax;
    } else {
      r.tax = 0;
      r.total = amount;
    }
  }

  const taxTotal = rows.reduce((n, r) => n + r.tax, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const cogs = rows.reduce((n, r) => n + r.cost, 0);
  return { lines: rows, subtotal, discount: discountTotal, tax: taxTotal, total, net: total - taxTotal, cogs, mode };
}
