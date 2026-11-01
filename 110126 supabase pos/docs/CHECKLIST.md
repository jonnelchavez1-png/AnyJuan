# Walk-through checklist (about 15 minutes, do it once after setup)

Tick each line. Anything that does not behave as written: note the screen and what you saw.

**Sign in and people**
- [ ] Owner can sign in. A wrong password shows a clear message.
- [ ] A second test account can be created and sees "Waiting for approval" until you activate it under Team.
- [ ] A **cashier** sees only Sell, Sales and Products (no Dashboard, Expenses, Settings, Team) and cannot add or edit products.

**Settings**
- [ ] Business name, currency, time zone saved. Tax off: receipts show no tax line.
- [ ] Tax on (e.g. 12% included): a ₱100 item shows ₱10.71 tax, customer pays ₱100. Switch to "added on top": customer pays ₱112.

**Selling**
- [ ] Add 2 products, give 10% discount, pay in full: receipt shows subtotal, discount, tax, total, payment.
- [ ] Sale marked "Pay later" asks for a customer and shows the balance. Record a part payment on Sales; the balance drops.
- [ ] Try to sell more than is in stock: it is refused.
- [ ] Turn the internet off, press Charge: clear message, cart kept. Turn it on, press Charge again: exactly one sale recorded.
- [ ] Void a sale with a reason: stock goes back, the sale shows as Voided and disappears from the dashboard.

**Products, expenses**
- [ ] Add a product with a cost price and opening stock. Use Stock to add and remove units; the history shows each change.
- [ ] Add an expense; void it; totals update.

**Dashboard** (compare with Sales and Expenses lists)
- [ ] Today, This week, This month, This quarter, This year and Custom all load.
- [ ] Net sales = total of completed sales without tax. Receivables = what is still owed. Net profit = gross profit − expenses.
- [ ] No sales: margins show a dash, not 0% or an error.
- [ ] Phone: no sideways scrolling; the menu opens and closes.

**Database proof**
- [ ] `supabase/verify.sql` shows ALL CHECKS PASSED.
