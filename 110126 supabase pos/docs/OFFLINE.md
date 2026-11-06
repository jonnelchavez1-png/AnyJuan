# Selling with no internet (Offline mode)

## In one minute
- You can keep **selling** when the internet is down. Each sale is saved **on that device** (phone, tablet or computer).
- When the internet comes back, the sales upload **by themselves**, **once each**, in the order they were made, with the **price, tax and time they really had**.
- The shop never needs to "do" anything. A strip at the top tells staff what is happening.

## What works with no internet
| Works | Needs the internet |
|---|---|
| Opening the app (after it was opened once with internet) | Signing in for the very first time on a device |
| Sell: add items, discount, tax, cash / card / pay later for a saved customer | Voids, returns and refunds |
| Printing or showing the receipt (it says "Saved on this device") | Expenses |
| Looking at Products, Customers, Sales, Dashboard, Tax report **as last saved** (a note says when) | Adding a new customer (use Walk-in meanwhile) |
| The "Offline and sync" page | The Cash drawer (open, close, cash in or out) |

### About the Dashboard
It cannot be calculated without the server, so offline it shows **the figures saved the last time it loaded** and says so, plus a line like
"does not include the 2 sales (₱250.00) waiting on this device". The moment sales upload, the Dashboard, Sales list, Tax report, stock and customer balances update.

## Where the sales are kept, and how they stay safe
- Inside the browser's own database (IndexedDB) **plus** a small copy of the list in the browser's storage as a second safety net.
- A sale gets a temporary number like `OFFLINE-3F9A2C`. After upload it gets the real invoice number (INV-000123). The Offline page shows both.
- Every sale has its own unique id made on the device. If the internet drops **while** a sale is uploading and the reply is lost, the next try is recognised by the server and nothing is counted twice.
- Signing out never deletes unsent sales. Staff can sign out, someone else can sign in, and the unsent sales are still there (they upload when the person who made them signs in; an owner or manager can press "Upload under my name").
- **Do not clear browser data / "site data" / use "reset" on a device that still has unsent sales.** The Cash drawer cannot be closed while sales are still waiting on that device.
- iPhone/iPad Safari may remove site data if the app is not opened for about a week. Open the app and let it upload before leaving a device unused. Adding the app to the Home Screen makes this safer.

## What the server decides when sales arrive
The database recomputes every sale and uses the **price and tax the customer was shown**, not today's setting. It **never refuses a real sale just because things changed**. Instead it records the sale and puts a note in the owner's list ("Offline and sync" → *Offline sales to check*):
- the product's price changed after the sale (the customer's price is kept)
- the tax setting changed
- stock was not enough: stock is set to 0 (never negative) and a "please recount" note is added
- the product was switched off in the meantime
- a discount above the cashier's limit
- the sale is more than 3 days old (cashiers) — the limit is 35 days offline
The owner or manager reads each note and presses **Mark checked**.

A sale that is truly invalid (for example the product was deleted) is **not lost and not dropped**: it stays on the device as **Needs attention** with the reason. **Remove** first downloads a backup file of that sale.

## Clock differences
The tablet's clock may be wrong. The app measures the difference with the server's clock when the internet is on, and corrects the sale time when uploading.

## Several devices
Each device has its own waiting list. Stock shown on a device = server stock minus what is still waiting on that device. Two devices that sell the same last item offline will both succeed; the second gets a "please recount" note and stock stays at 0.

## Setting up a tablet
1. With internet, open the site once and sign in. Open the *Offline and sync* page once; if the browser cannot keep sales on the device, a red strip says so (use a normal, not private, window).
2. Chrome/Edge: menu → *Install app* / *Add to Home screen*. Safari: Share → *Add to Home Screen*.
3. Test once: switch on airplane mode, make two small sales, switch it off, wait a minute, and watch them become real invoices.

## Updating the app
After a new version is uploaded, a strip says "A new version of the app is ready" with a **Reload now** button (press it when not in the middle of a sale). Offline devices keep the old version until then; unsent sales are never touched by an update.

## Under the hood (for developers)
`public/sw.js` (app cache) · `src/data/offline/store.js` (IndexedDB) · `src/data/offline/manager.js` (state, network probe, queue) · `src/lib/outbox.js`, `src/lib/sync.js` (queue and upload rules) · `src/data/repo.js` (`createSale` falls back to the queue) · database: `sale_offline`, `sale_reviews`, `server_time()`, `get_sale_reviews()`, `resolve_sale_review()`, and `create_sale(…, offline: true)`.
Tests: `tests/offline.test.js`, `tests-browser/offline.cjs` (real Chromium, service worker and IndexedDB), `tests-db/offline.mjs`.
