# Change Impact Report: v2 → v3

**Nothing was deleted.** The whole previous version is in `legacy/v2-committed/` (committed code, migrations, docs, old build) and the working copy you sent is in `legacy/user-working-copy/` (your `supabaseClient.js` key was redacted there).

| Area | v2 | v3 | Risk / what you must do |
|---|---|---|---|
| Database | Several migrations, open sign-up could create staff | One `setup.sql` for a **new, empty** project; staff inactive until the owner activates them | Use a **new Supabase project**. Old data is not migrated automatically (say if you need that). |
| Sales | Client could write sales and totals | Only `create_sale` / `void_sale` / `record_payment` / `adjust_stock`; the database recomputes everything | Any old code that inserts into `sales` directly no longer works (by design). |
| Tax | Fixed or absent | Optional, inclusive or exclusive, per-product exempt | Default is **off**. Turn on in Settings. |
| Stock | Editable | Changes only via sale, void or adjustment, all logged | Use **Stock** on the Products list. |
| Dashboard | Partial / estimated | Defined metrics, previous-period comparison, no invented figures | None. |
| Keys | A key was committed in the working copy | Only the two `VITE_` variables; secret keys refused | **Rotate** the key that was in `supabaseClient.js` (Supabase → API → regenerate) if it was ever shared. |
| Password handling | Client-side hashing (removed in the last commit) | Supabase Auth only | None. |

Rollback: the old version is untouched in `legacy/` and in git history (`main`). v3 lives on the `rebuild/v3` branch.


## Update: returns and refunds, shared dates, tax report, receipts
- New tables `returns`, `return_items`; new functions `create_return`, `plan_return`, `dash_lines`; replaced `period_totals`,
  `get_dashboard`, `get_tax_report`, `void_sale` (refuses a sale that has returns), `record_payment` (uses the balance after returns)
  and the `sales_overview` view (adds `returned`, `refunded`; `balance` now = total - returned - (paid - refunded)).
- Existing sales, products, payments and expenses are untouched. Upgrading: run `supabase/update-returns.sql` once.
- App: one shared date range on Dashboard, Sales, Expenses and Tax report; Sales/Expenses read every row (paged); receipts print only the receipt.


## Update: cash drawer shifts (additive only)
- New tables `shifts`, `cash_movements`; new functions `current_shift`, `get_shift`, `open_shift`, `add_cash_movement`, `close_shift`
  (plus private helpers `shift_figures`, `is_cash_method`). Upgrading: run `supabase/update-drawer.sql` once (after `update-returns.sql`).
- **No existing table, view or function was changed.** Sales, payments, returns, the dashboard, the tax report and the Sell screen never read the drawer,
  and the drawer never writes to them. Selling is not blocked when no shift is open.
- App: one new page "Cash drawer" (owner, manager, cashier open/close and move cash; accountant can read). Existing pages are unchanged.
- Proof it changes nothing: after the update all earlier checks give the same results (unit 80, browser 110, database 1,151 on a fresh and an upgraded database,
  `verify.sql`), plus new ones for the drawer (unit +4, browser +18, database 35). A browser check also confirms Sales and Dashboard show identical figures before and after using the drawer.
- Rollback: the app is tagged `before-drawer-shifts` in git. The two new tables can stay in the database without harm.
