# Offline readiness (not built yet, designed for)

Today the app is **online only**. These pieces already exist so offline can be added later without redoing the screens or the database:

| Need | Already in place |
|---|---|
| Record a sale with no internet | Sales and payments get their **id on the device** (`newId()`), and `occurred_at` records when the sale really happened. |
| Send it later without double counting | `create_sale` and `record_payment` are **idempotent**: the same id sent twice changes nothing and returns `duplicate: true`. Already used by the "press Charge again" retry. |
| One place to change | Screens only call `src/data/repo.js`. Offline means changing what `createSale`, `recordPayment`, `voidSale`, `adjustStock` do there (save in IndexedDB, send when online) and caching the product lists for reads. |
| Server stays the judge | Prices, tax and totals are recomputed by the database on arrival. A late sale that no longer fits (stock gone, product switched off) is rejected with a clear message and must be fixed by a person. |
| Limits | The database refuses sales older than 3 days (cashier) / 1 year (owner, manager), so very old queues need manager review. |

## What would still need building
1. An outbox (IndexedDB) with "waiting to send" and "failed, needs attention" lists on screen.
2. A service worker and manifest so the app opens offline and can be installed.
3. Cached reads (products, customers, lists) with a "last updated" label.
4. A rule for stock that changed while offline (the server rejects overselling; show the cashier what failed).
Voids, stock adjustments and expenses are intentionally left online-only in a first offline version.
