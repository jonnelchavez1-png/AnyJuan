# Returns and refunds - how they work

**Who:** owner and manager (the database refuses anyone else). **Where:** Sales > Return on a sale, or open the sale > Return items.

**What a return is.** A separate record (RET-000001...) that points at the original sale. The sale itself is never edited.
You choose items and how many (partial returns, several returns on one sale are fine). Each line can go back on the shelf
(Restock ticked) or not (damaged: tick off).

**Counted when?** On the day the goods come back, not on the day of the original sale. So a month that is already
reported never changes afterwards. Net sales, tax collected, cost of goods, payments collected, top items, categories and
channels on the Dashboard and the Tax report are all after returns.

**Money back.** Only what the customer has paid beyond what they now owe:
- sale not paid yet: nothing is handed back, the balance owed goes down;
- sale paid: the value of the returned items goes back (by the method you pick);
- part paid: only the extra goes back.

**Exact to the cent.** Returning the last units of a line takes exactly what is left of it, so several partial returns
always add up to the original sale. Items put back in stock take their cost off cost of goods sold; damaged items do not.

**Voiding.** A sale that has a return can no longer be voided (return what is left instead), so stock is never put back twice.

**Checked by:** `tests/returns.test.js` (rules), `tests-db/reconcile.mjs` (hundreds of random returns on a real database:
the JavaScript calculator and the database agree on every line; Dashboard, Tax report, stock, balances and refunds all add up).
