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
