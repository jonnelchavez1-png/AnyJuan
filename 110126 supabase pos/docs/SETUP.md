# Setup, step by step

You need: a free Supabase account, a free Netlify account (you already have one), and the email address you will use as the **owner**.

## Part 1. The database (Supabase)

1. Go to supabase.com → **New project**. Choose a name, a strong database password (save it), and a region near you. Wait about 2 minutes. **One business = one Supabase project.**
2. Open `supabase/setup.sql` in any text editor. Find the line marked `CHANGE THIS` and replace `CHANGE_ME@example.com` with **your own email**. Save.
3. In Supabase, left menu → **SQL Editor** → **New query**. Paste the *whole* file → **Run**. At the bottom you should see one row with your business and owner email. (An error mentioning "Please edit the line marked CHANGE THIS" means step 2 was skipped.)
4. **Create the owner login right away** (this order matters for safety): left menu → **Authentication → Users → Add user → Create new user**. Use the *same email* as step 2, choose a password, and tick **Auto Confirm User**. Save.
5. (Optional) SQL Editor → paste `supabase/sample_data.sql` → Run, to get 26 sample grocery items.
6. (Optional but recommended once) paste `supabase/verify.sql` → Run. A table showing **ALL CHECKS PASSED** means the database rules work. It removes its own test data.
7. Left menu → **Project Settings → API**. Copy the **Project URL** and the **publishable (anon) key**. *Never* copy the `service_role` / secret key into the app.
8. **Authentication → URL Configuration**: set **Site URL** to your Netlify address once you have it (Part 2).
9. Staff accounts, two ways: (a) leave sign-ups on: people create their own account on the sign-in page and wait; you switch them on under **Team**; or (b) turn **Allow new users to sign up** off and add staff yourself in Authentication → Users, then activate them under **Team**. Either way nobody can use the app until you activate them.

## Part 2. Publishing (Netlify)

1. Put the project files in your GitHub repository (the folder contents, including `package.json`, `index.html`, `netlify.toml`, `src`, `public`; do **not** upload `node_modules` or any `.env` file).
2. Netlify → your site → **Site configuration → Environment variables** → add:
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = the publishable key
3. **Deploys → Trigger deploy → Clear cache and deploy site.** Build command `npm run build`, publish folder `dist` (already set in `netlify.toml`).
4. Open your Netlify address, sign in with the owner email and password. Go to **Settings** and set the business name, currency, time zone and (if you charge tax) the tax. Add products. Make a test sale. Void it.

If the page says the app is "not connected to a database", the two variables are missing or the site was not rebuilt after adding them.

## Part 3. Daily use
- **Sell** → tap items → set discount / customer / payment → **Charge**. If the internet drops, press Charge again: the same sale id is reused, so it is never recorded twice.
- Costs: enter a **cost price** on each product, otherwise profit equals sales.
- Changing tax rates only affects new sales. Old sales keep the tax they had.

## Running it on your own computer (optional)
Install Node 20+, then: `npm install`, copy `.env.example` to `.env` and fill the two values, `npm run dev`.

## Passwords and email (read this before adding staff)
- Everyone can change their own password inside the app: **My account → Change my password**. This needs no email, so it always works.
- **"Forgot password?" sends an email, and Supabase's built-in email sender only delivers to people on your Supabase organization team (2 messages per hour).** For staff outside your team, set up **custom SMTP** (Supabase → Authentication → Emails → SMTP Settings; free providers such as Resend or Brevo work). Until then, create staff accounts yourself (Authentication → Users → Add user, Auto Confirm User) with a strong temporary password, activate them under Team, and ask them to change it at once in My account.
- Do not use passwords like `123450` as temporary passwords. Use a random phrase such as `blue-Tiger-42-lamp`.
- In Supabase → Authentication → URL Configuration, set **Site URL** to your Netlify address and add it under **Redirect URLs** so reset links return to the app.

## Safety notes
- Turn on **Confirm email** in Supabase (Authentication → Providers → Email) if the app is public. The owner address only becomes the owner once its email is confirmed, and only while no owner exists.
- Cashiers can read cost prices (needed for the screens). Give cashier accounts only to people you trust with that.
- Staff are deactivated, never deleted (their history stays).

## Adding Returns and the Tax report to a shop that was set up earlier
If you ran `setup.sql` before Returns existed, open `supabase/update-returns.sql`, paste it into
Supabase > SQL Editor > New query and click Run (do this BEFORE uploading the new app files). It says
"Returns installed". It is safe to run twice, adds new tables and replaces the report functions; your sales,
products and expenses are not changed. It also contains the Tax report (the old `update-tax-report.sql` is replaced by it).

## Adding the Cash drawer to a shop that was set up earlier
First make sure `update-returns.sql` has been run (see above). Then open `supabase/update-drawer.sql`, paste it into
Supabase > SQL Editor > New query and click Run (BEFORE uploading the new app files). It says "Cash drawer installed".
It only adds two new tables and a few functions. Safe to run twice. Nothing about selling, returns, the dashboard or the
tax report changes. If you upload the app first, the Cash drawer page just says it is not switched on yet; selling keeps working.
How to use it: see `docs/DRAWER.md`.

## Receipts
Settings > Business: the header (address, phone, tax ID) and footer take several lines. In the receipt window,
choose the paper (58 mm roll, 80 mm roll, A4/Letter); the choice is remembered on that device.
Print sends only the receipt, never the whole screen.

## Adding Offline selling to a shop that was set up earlier
First make sure `update-returns.sql` has been run. Then open `supabase/update-offline.sql`, paste it into Supabase > SQL Editor > New query and click Run
(BEFORE uploading the new app files). It says "Offline selling installed". It is safe to run twice. Then upload the new `src`, `public`, `docs` folders.
How to use it: see `docs/OFFLINE.md`.
