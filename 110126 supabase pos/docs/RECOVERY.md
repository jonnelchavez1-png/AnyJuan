# If something goes wrong

| Problem | What to do |
|---|---|
| Page says "not connected to a database" | In Netlify add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, then **Clear cache and deploy site**. |
| A bad update was published | Netlify → Deploys → pick the last good deploy → **Publish deploy**. Takes seconds, nothing in the database changes. |
| Cannot sign in | Supabase → Authentication → Users: check the email exists and is confirmed; reset the password there. |
| Locked out as owner | Authentication → Users → make sure the owner email from `setup.sql` exists and is confirmed. If an owner was switched off by mistake, run in the SQL Editor: `update public.profiles set active = true, role = 'owner' where email = 'YOUR@EMAIL';` |
| Wrong stock number | Products → Stock → add or remove the difference with a reason. History keeps both. |
| A sale was entered wrongly | Sales → open it → Void with a reason, then sell again correctly. |
| Key was exposed | Supabase → Project Settings → API → regenerate the keys, update the Netlify variables, redeploy. |
| Database mistake | Supabase → Database → Backups (daily on paid plans). On the free plan, export your data regularly: Products and Sales both have **Download CSV**. |
| Go back to the old app | It is untouched in `legacy/` and on the `main` branch in git. |
