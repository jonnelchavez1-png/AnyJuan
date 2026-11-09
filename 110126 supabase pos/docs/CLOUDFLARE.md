# Moving the website from Netlify to Cloudflare Pages

The full step-by-step guide is the doc "Move the POS from Netlify to Cloudflare Pages" (shared with the owner). Summary:

- Cloudflare Pages free: 500 builds a month (Netlify free: about 20 deploys from 300 credits).
- Project settings: production branch `main`, build command `npm run build`, output `dist`, **root directory `110126 supabase pos`**.
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable key only, never a secret/service_role key), `NODE_VERSION=20`.
- `public/_headers` carries the security headers (same as netlify.toml) and keeps `/sw.js` fresh.
- A new web address is a new "origin": unsent offline sales stay on the old address. Every device must show "Nothing waiting" before it moves, then sign in again and reinstall the app.
- Add the new address in Supabase > Authentication > URL Configuration.
- Keep the Netlify site as a fallback; stop its builds so it stops using credits.
- Choose the final address (own domain) BEFORE moving devices so they only move once.
