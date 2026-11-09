# AnyJuanPOS v3

A point of sale, stock and money tracker for **one business** (any kind of shop or service). It runs in the browser on a phone, tablet or computer, and keeps its data in your own Supabase project. Online only today, built so offline mode can be added later without rewriting the screens.

**What it does**
- **Sell**: tap products or scan barcodes, discounts (percent or amount), optional tax, pay in full / part / later, receipts you can print or copy.
- **Sales**: history, record later payments, void a sale (stock goes back, a reason is required).
- **Products**: price, cost, stock tracking, low-stock warnings, tax-exempt items, every stock change is logged.
- **Expenses**: your own categories, voiding instead of deleting.
- **Dashboard**: Today / This week / This month / This quarter / This year / Custom, each compared with the previous period. Net sales, tax collected, payments collected, receivables, cost of goods, gross profit and margin, expenses, net profit, orders, top items, categories, channels, payment methods, trend chart. Every number has an "i" explaining exactly how it is worked out. Missing data shows a dash, never an invented value.
- **Settings**: business name, currency, time zone, **optional tax** (inclusive or added on top), your own categories / channels / payment methods / expense categories, cashier discount limit.
- **Team**: new people wait until the owner activates them. Roles: owner, manager, cashier, accountant.

**Start here:** [docs/SETUP.md](docs/SETUP.md) (step by step, no coding needed).

## Money rules (so the numbers can be trusted)
- Amounts are whole cents in the app and `numeric(14,2)` in the database. Quantities have up to 3 decimals.
- The browser never sends prices or totals. `create_sale` in the database recomputes every price, discount share, tax and total itself.
- Tax is per line, rounded half up. **Net sales = total − tax** (tax is held for the tax office, it is not revenue).
- Gross profit = net sales − cost of goods. Net profit = gross profit − expenses. Voided sales and voided expenses are never counted.
- Receivables = what customers still owe today. Collected = payments received in the period.

## Project layout
| Path | What it is |
|---|---|
| `supabase/setup.sql` | The whole database: tables, security rules, sale / void / payment / stock functions, dashboard function. Run once. |
| `supabase/sample_data.sql` | Optional: 26 grocery items to try the app. |
| `supabase/verify.sql` | Optional self-check of the database rules; rolls itself back. |
| `src/lib/` | Money, tax, dates and dashboard maths (plain functions, unit tested). |
| `src/data/repo.js` | The only file that talks to Supabase (this is where offline would plug in). |
| `src/features/`, `src/ui/` | The screens and shared pieces. |
| `tests/`, `tests-browser/` | 71 unit tests; browser tests against a fake database. |
| `legacy/` | The previous version, kept untouched. Nothing was deleted. |

## Commands
`npm install`, then `npm run dev` (local), `npm test` (unit tests), `npm run build` (production files in `dist/`), `npm run test:browser` (browser tests, needs Playwright).

## Settings the app reads
Only two, both public-safe: `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never put a secret / service-role key in the app. See `.env.example`.

## Honest limits
See [docs/REVIEW.md](docs/REVIEW.md) for what was tested, what could not be tested here, and known limitations.
