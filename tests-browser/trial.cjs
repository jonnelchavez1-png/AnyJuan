// Trial sandbox screens in a real browser (fake database). Usage: node tests-browser/trial.cjs
const path = require('path'); const http = require('http'); const fs = require('fs');
const { execFileSync } = require('child_process');
execFileSync('node', [path.join(__dirname, 'build.cjs')], { stdio: 'inherit' });
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const out = path.join(__dirname, 'out'); const shots = path.join(__dirname, 'screenshots'); fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const f = path.join(out, req.url === '/' || !path.extname(req.url.split('?')[0]) ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(d); } });
});
let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log('  ok  ', name); } else { failures.push(name); console.log('  FAIL', name, detail); } };

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const db = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__fake.db)));
  const login = async (email) => { await page.getByLabel('Email').fill(email); await page.getByLabel('Password', { exact: true }).fill('correct-horse'); await page.getByRole('button', { name: 'Sign in' }).click(); };

  console.log('Normal user: no trial anything');
  await page.goto(base);
  await login('owner@example.com');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  check('owner has no trial banner', await page.getByText('Trial mode.').count() === 0);
  check('owner has no Start Fresh button', await page.getByRole('button', { name: 'Start Fresh' }).count() === 0);
  check('no trial call was made for the owner', !(await db()).__trial);
  await page.evaluate(() => { location.hash = '#/account'; });
  await page.getByLabel('New password').waitFor();
  check('owner still has the change-password form', await page.getByRole('button', { name: 'Save new password' }).isVisible());
  await page.getByRole('link', { name: 'Team' }).click();
  check('owner still has live Team controls', await page.getByRole('button', { name: 'Switch off' }).first().isEnabled());
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor(); await page.getByLabel('Business name').waitFor();
  check('owner still edits the real business and tax', await page.getByLabel('My business charges tax').count() === 1);
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByLabel('Email').waitFor();
  check('owner sign-out does not call trial_end', !(await db()).__trial);

  console.log('Trial user');
  await login('trial@example.com');
  await page.getByText('Trial mode.').waitFor();
  check('trial user sees the trial banner', await page.getByText('Trial mode.').isVisible());
  check('trial user sees Start Fresh', await page.getByRole('button', { name: 'Start Fresh' }).isVisible());
  check('trial_begin was called once', (await db()).__trial.calls.filter((c) => c === 'trial_begin').length === 1);
  check('sidebar says Trial account', await page.locator('.who').innerText().then((t) => /trial account/i.test(t)));
  await page.evaluate(() => { location.hash = '#/products'; }); await page.getByRole('heading', { name: 'Products' }).waitFor();
  check('the sample products are there at first', await page.getByText('Cola 290ml').isVisible());

  console.log('Team page is look-only');
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByText('trial accounts cannot add, change or switch off people', { exact: false }).waitFor();
  check('every Team button is disabled', (await page.getByRole('button', { name: /Switch off|Activate/ }).evaluateAll((els) => els.every((e) => e.disabled))) === true);
  check('no role dropdowns', await page.locator('select').count() === 0);
  check('real team members are not shown', await page.getByText('Carl Cashier').count() === 0 && await page.getByText('Olivia Owner').count() === 0);

  console.log('Password is locked for trial');
  await page.evaluate(() => { location.hash = '#/account'; });
  await page.getByText('The password is locked on trial accounts', { exact: false }).waitFor();
  check('trial has no change-password form', await page.getByLabel('New password').count() === 0 && await page.getByRole('button', { name: 'Save new password' }).count() === 0);

  console.log('Settings: only the trial name');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor(); await page.getByLabel('Business name').waitFor();
  check('no tax / currency card for trial', await page.getByLabel('My business charges tax').count() === 0);
  await page.getByLabel('Business name').fill("Maria's Sari-Sari"); await page.getByRole('button', { name: 'Save name' }).click();
  await page.locator('.side-brand .biz', { hasText: "Maria's Sari-Sari" }).waitFor();
  check('the trial name shows in the sidebar', true);
  check('the real business record is unchanged', (await db()).businesses[0].name === 'Test Mart');

  console.log('Start Fresh');
  await page.getByRole('button', { name: 'Start Fresh' }).click();
  await page.getByRole('dialog').getByText('Are you sure you want to start fresh? Your current trial environment will be reset. All original sample business records will remain safe and unchanged.').waitFor();
  check('confirmation text is exact', true);
  check('dialog has Cancel and Confirm and Start Fresh', await page.getByRole('button', { name: 'Cancel' }).isVisible() && await page.getByRole('button', { name: 'Confirm and Start Fresh' }).isVisible());
  await page.getByRole('button', { name: 'Cancel' }).click();
  check('Cancel changes nothing', (await db()).products.length === 3 && !(await db()).__trial.calls.includes('trial_start_fresh'));
  await page.getByRole('button', { name: 'Start Fresh' }).click();
  await page.getByRole('button', { name: 'Confirm and Start Fresh' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByText('Fresh start: your trial shop is now empty.').waitFor();
  check('Start Fresh called the server once', (await db()).__trial.calls.filter((c) => c === 'trial_start_fresh').length === 1);
  check('the dashboard is empty', await page.getByText('No sales or expenses in this period yet').isVisible());
  await page.evaluate(() => { location.hash = '#/products'; }); await page.getByRole('heading', { name: 'Products' }).waitFor();
  check('products list is empty after Start Fresh', await page.getByText('Cola 290ml').count() === 0);
  check('the trial business name is kept', await page.locator('.side-brand .biz', { hasText: "Maria's Sari-Sari" }).isVisible());

  console.log('Expiry');
  await page.evaluate(() => { window.__fake.db.__trial.expired = true; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: 'Your trial session has ended' }).waitFor();
  check('an expired session shows the ended screen', true);
  await page.getByRole('button', { name: 'Sign in again' }).click(); await page.getByLabel('Email').waitFor();

  console.log('Logout ends the trial');
  await page.evaluate(() => { window.__fake.db.__trial.expired = false; });
  await login('trial@example.com');
  await page.getByText('Trial mode.').waitFor();
  const before = (await db()).__trial.calls.filter((c) => c === 'trial_end').length;
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByLabel('Email').waitFor();
  check('Sign out called trial_end', (await db()).__trial.calls.filter((c) => c === 'trial_end').length === before + 1);

  check('no errors in the browser console', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
