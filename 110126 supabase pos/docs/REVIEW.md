# What was tested, and what was not

## Tested here
- **71 unit tests** (`npm test`): money in cents, tax (inclusive / exclusive / exempt / discount sharing to the cent), dates in the business time zone and comparison periods, dashboard figures, and **37 readability checks** (every text/background pair meets WCAG AA 4.5:1; chart colours 3:1; chart lines differ by style and marker shape, not colour alone).
- **54 browser checks** (`npm run test:browser`) in real Chromium against a fake database: sign in, wrong password, waiting-for-approval screen, tax settings, selling with a dropped connection (recorded exactly once), stock limits, pay-later rules, part payments, over-payment refused, void with reason and stock restored, product and expense forms with clear errors, stock adjustment, dashboard figures equal the recorded data, no sideways scrolling at phone width, every screen at phone and desktop width, cashier role limits, no console errors.
- **Independent review** of `setup.sql` by a separate reviewer who had not seen the work. Findings and fixes:
  - *Blocker:* anyone could register the owner's email first and become owner. Fixed: only a **confirmed** email, only while no owner exists, plus a promotion trigger on confirmation.
  - NaN accepted as a quantity / amount (could poison reports). Fixed with range checks and table checks.
  - Cashiers could choose invoice numbers, back-date sales and give unlimited discounts. Fixed: server-made invoice numbers, date window (3 days cashier / 1 year manager), a configurable cashier discount limit.
  - Reliance on default table permissions. Fixed: explicit grants; stock column is not writable by the browser at all.
  - Void now reverses exactly what the sale removed; unlogged opening stock closed; payment retries race-safe; audit trail made append-only; `private.bootstrap` locked down.

## NOT tested here (please do these once)
1. **The SQL was run on a throwaway PostgreSQL 16** with a stand-in for Supabase's `auth` schema: `setup.sql` (twice, to prove it can be re-run), `sample_data.sql`, and `verify.sql` all pass, and permissions were probed directly (a cashier cannot escalate to owner, read expenses, open the dashboard, void, write sales or stock; the owner email only becomes owner once confirmed). Running this exposed one real error the earlier reading missed (an `IF` containing a `CASE` ... `THEN`), now fixed. It is still not Supabase itself, so **run `verify.sql` on your own project** as the final proof.
2. **`npm run build` (Vite) was not run** because the package registry is blocked here. The app was bundled with esbuild (same source) and ran in a browser. Netlify's build is the first Vite run.
3. The real Supabase client (`@supabase/supabase-js`) was replaced by a fake in tests; the calls used are standard (`from/select/insert/update/rpc/auth`).

## Known limitations
- Online only. One business per project. Cashiers can see cost prices. Two owners demoting each other at the exact same instant could leave none (very unlikely; the last-owner guard blocks the normal case).
- Email-confirmation behaviour depends on your Supabase auth settings.
