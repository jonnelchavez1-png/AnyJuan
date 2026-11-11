# Trial sandbox (for the public trial / demo copy only)

**What it is.** A way to let prospects try AnyJuanPOS on ONE shared copy without messing up the sample shop or each other.

- A *trial user* signs in and gets a **private temporary copy** of the sample shop (same products, sales, expenses, drawer, stock).
- Everything they do (sell, return, add products, expenses, drawer, stock) stays inside that copy, so the dashboard, reports and stock always agree.
- **Start Fresh** replaces their copy with an **empty** shop (only payment methods, channels and categories lists are copied so selling works).
- **Signing out** deletes the copy. If they just close the browser, it expires after about 4 hours without use (24 hours at most) and is deleted. The next login starts again from the sample shop.
- Your original sample rows are never read for changing, edited or deleted by a trial user. Normal accounts (you, your staff, real clients) behave exactly as before.
- Trial users can open **Team** but cannot change anything (the people shown are examples). They can rename **their trial shop** but never the real business.

**Do NOT run this on a real client's POS.** A client project only needs `setup.sql`.

## Turn it on (about 10 minutes)

1. **Upload the app files** from the zip to GitHub (keep the folders, one commit). Cloudflare builds it. Nothing changes for normal users.
2. **Run the database file once.** Supabase > SQL Editor > New query > paste all of `supabase/update-trial.sql` > Run. It is safe to run twice and runs as one all-or-nothing block. It never deletes or changes your existing rows.
   - Either order of step 1 and 2 is safe.
3. **Check it.** New query > paste `supabase/verify-trial.sql` > Run. You want the notice `TRIAL CHECKS PASSED`. It undoes everything it does.
4. **(Recommended) turn on the clean-up sweep.** Supabase > Database > Extensions > search `pg_cron` > enable. Then run `update-trial.sql` once more; it schedules the sweep every 15 minutes. Without it, sign-out clean-up still works, and an abandoned session is cleaned the next time that person signs in.

## Make a trial account

1. Supabase > Authentication > Users > **Add user** > type their email and a password > tick auto-confirm.
2. SQL Editor, run (change the email):
   ```sql
   select public.make_trial_user('prospect@example.com');
   ```
3. Send them the web address, their email and password.

Turn a trial account into a normal account again:
```sql
select public.make_standard_user('prospect@example.com', 'cashier');
```

## Remove a trial user for good
A person with a live session cannot be deleted (this is a safety lock). Run, with their email:
```sql
update public.trial_sessions set ended_at = now()
 where user_id = (select id from public.profiles where lower(email) = lower('prospect@example.com'));
select public.trial_cleanup();
delete from public.profiles where lower(email) = lower('prospect@example.com');
delete from auth.users where lower(email) = lower('prospect@example.com');
```

## What changed in the database (for the curious)
- New table `trial_sessions`; new column `profiles.account_type` (`standard` or `trial`, everyone existing = `standard`).
- New empty column `workspace_id` on 18 tables. **Empty = original data.** Trial rows carry their session id.
- One function, `private.ws()`, decides which workspace the signed-in person is in. Security rules and a database trigger refuse any read or change outside it, even if someone calls the functions directly.
- 17 functions (sell, void, payment, return, stock, drawer, dashboard, tax report, ...) were re-created. The only change inside them: tables are read through a filter that, for a normal account, matches exactly the rows that existed before. Trial documents are numbered `TRL-INV-`, `TRL-RET-`, `TRL-SHIFT-` with their own counters, so your real invoice numbers never skip.
- Names and numbers (category name, SKU, barcode, invoice, one open drawer) are now unique *per workspace*, so a trial copy can reuse them.

## If something looks wrong
- Trial user sees "Getting your trial shop ready..." forever or an error: run `update-trial.sql` (it was probably not run yet), then ask them to refresh.
- Trial user says "Your trial session has ended": that is normal after long inactivity. Sign in again.
- Normal user sees anything odd: tell Claude. `verify-trial.sql` proves originals are untouched.
