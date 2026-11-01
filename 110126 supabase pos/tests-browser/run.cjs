// Runs the real screens in a real browser (Chromium) against the fake database. Usage: node tests-browser/run.cjs
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
  const login = async (email) => { await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill('correct-horse'); await page.getByRole('button', { name: 'Sign in' }).click(); };

  console.log('Sign in');
  await page.goto(base);
  await page.getByLabel('Email').waitFor();
  await page.getByLabel('Email').fill('owner@example.com'); await page.getByLabel('Password').fill('wrong'); await page.getByRole('button', { name: 'Sign in' }).click();
  check('wrong password shows an error', await page.getByRole('alert').filter({ hasText: 'Invalid login' }).isVisible());
  await login('owner@example.com');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  check('owner lands on the dashboard', true);
  check('empty dashboard says so, not zeros pretending to be data', await page.getByText('No sales or expenses in this period yet').isVisible());
  check('margin shows a dash when there are no sales', (await page.locator('.kpi', { hasText: 'Gross profit' }).first().innerText()).includes('Margin –'));

  console.log('Tax settings');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('My business charges tax').check();
  await page.getByLabel('Rate %').fill('12');
  await page.getByRole('button', { name: 'Save tax settings' }).click();
  await page.getByText('Saved').first().waitFor();
  let d = await db(); check('tax saved as 12% inclusive', d.businesses[0].tax_enabled && d.businesses[0].tax_rate === 12 && d.businesses[0].tax_mode === 'inclusive');

  console.log('Selling (with a dropped connection)');
  await page.getByRole('link', { name: 'Sell' }).click();
  const tile = (n) => page.locator('button.tile', { hasText: n });
  await tile('Cola 290ml').click(); await tile('Cola 290ml').click();
  await tile('Chips 60g').click();
  await page.getByLabel('Discount', { exact: true }).fill('10');
  const totalsText = await page.locator('.totals').innerText();
  check('screen shows total ₱225.00 (inclusive 12%, 10% discount, exempt item)', /Total\s*₱225\.00/.test(totalsText.replace(/\n/g, '')), totalsText);
  check('screen shows tax ₱19.29', totalsText.includes('19.29'), totalsText);
  await page.screenshot({ path: path.join(shots, 'sell-desktop.png') });
  await page.evaluate(() => { window.__fakeFail = { createSale: 1 }; });
  await page.getByRole('button', { name: /Charge/ }).click();
  await page.getByText('Cannot reach the server').waitFor();
  check('dropped connection gives a plain message and keeps the cart', await page.getByText('Cola 290ml').count() > 0);
  d = await db(); check('nothing recorded yet', d.sales.length === 0);
  await page.getByRole('button', { name: /Charge/ }).click();
  await page.getByRole('dialog', { name: 'Receipt' }).waitFor();
  d = await db();
  check('retry recorded the sale exactly once', d.sales.length === 1);
  check('stock fell by what was sold (Cola 10→8)', d.products.find((p) => p.name === 'Cola 290ml').quantity === 8);
  check('server totals match', d.sales[0].total === 225 && d.sales[0].tax_amount === 19.29 && d.sales[0].net_sales === 205.71, JSON.stringify(d.sales[0]));
  const rtext = await page.locator('#receipt').innerText();
  check('receipt shows invoice, tax line, total, payment', /INV-000001/.test(rtext) && /Tax 12%\s*\(included\)/.test(rtext) && rtext.includes('₱225.00') && /Paid/.test(rtext), rtext);
  await page.screenshot({ path: path.join(shots, 'receipt-desktop.png') });
  await page.getByRole('button', { name: 'Done' }).click();

  console.log('Pay later and stock limits');
  await tile('Rice 1kg').click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'More Rice 1kg' }).click();
  check('cannot add more than is in stock', await page.getByText('Only 3 of Rice 1kg in stock').isVisible());
  await page.getByLabel('Payment', { exact: true }).selectOption('later');
  await page.getByRole('button', { name: /Charge/ }).click();
  check('pay later needs a customer', await page.getByText('Choose a customer').isVisible());
  await page.getByLabel('Customer').selectOption({ label: 'Aling Rosa' });
  await page.getByRole('button', { name: /Charge/ }).click();
  await page.getByRole('dialog', { name: 'Receipt' }).waitFor();
  check('receipt shows balance due', (await page.locator('#receipt').innerText()).includes('BALANCE DUE'));
  await page.getByRole('button', { name: 'Done' }).click();

  console.log('Sales history');
  await page.getByRole('link', { name: 'Sales' }).click();
  await page.getByRole('button', { name: 'INV-000002' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Amount').fill('1000');
  await page.getByRole('button', { name: 'Save payment' }).click();
  check('over-payment is refused', await page.getByText('more than the balance').isVisible());
  await page.getByLabel('Amount').fill('50');
  await page.getByRole('button', { name: 'Save payment' }).click();
  await page.getByText('Payment recorded').first().waitFor();
  d = await db(); check('part payment recorded', d.payments.filter((p) => p.sale_id === d.sales[1].id).reduce((n, p) => n + p.amount, 0) === 50);
  await page.getByRole('button', { name: 'INV-000001' }).click();
  await page.getByRole('button', { name: 'Void' }).click();
  await page.getByRole('button', { name: 'Void sale' }).click();
  check('void needs a reason', await page.getByText('Please write a reason').isVisible());
  await page.getByLabel('Reason').fill('test');
  await page.getByRole('button', { name: 'Void sale' }).click();
  await page.getByText('Sale voided').first().waitFor();
  d = await db(); check('void put stock back (Cola 10)', d.products.find((p) => p.name === 'Cola 290ml').quantity === 10 && d.sales[0].status === 'voided');

  console.log('Products and expenses');
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('button', { name: '＋ Add product' }).click();
  await page.getByLabel('Name').fill('Soap'); await page.getByLabel('Price', { exact: true }).fill('abc');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  check('bad price is explained', await page.getByText('The price must be a number').isVisible());
  await page.getByLabel('Price', { exact: true }).fill('30'); await page.getByLabel('Opening stock').fill('12');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Product added').first().waitFor();
  d = await db(); check('product saved with opening stock', d.products.some((p) => p.name === 'Soap' && p.quantity === 12 && p.price === 30));
  await page.getByRole('row', { name: /Rice 1kg/ }).getByRole('button', { name: 'Stock' }).click();
  await page.getByLabel('Change (+ add, − remove)').fill('-99'); await page.getByRole('button', { name: 'Save change' }).click();
  check('cannot remove more stock than exists', await page.getByText('Stock cannot go below zero').isVisible());
  await page.getByLabel('Change (+ add, − remove)').fill('5'); await page.getByLabel('Reason').fill('delivery'); await page.getByRole('button', { name: 'Save change' }).click();
  await page.getByText('Stock updated').first().waitFor();
  await page.screenshot({ path: path.join(shots, 'products-desktop.png') });
  await page.getByRole('link', { name: 'Expenses' }).click();
  await page.getByRole('button', { name: '＋ Add expense' }).click();
  await page.getByLabel('Amount').fill('300'); await page.getByLabel('Category').selectOption({ label: 'Rent' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Expense added').first().waitFor();
  d = await db(); check('expense saved', d.expenses.length === 1 && d.expenses[0].amount === 300);

  console.log('Dashboard');
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('button', { name: 'This month' }).click();
  await page.locator('.hero .big').waitFor();
  const hero = await page.locator('.hero .big').innerText();
  const live = d.sales.filter((s) => s.status === 'completed'); const expectNet = live.reduce((n, s) => n + s.net_sales, 0);
  check(`net sales on the hero equals recorded net sales (${hero})`, hero.replace(/[^\d.]/g, '') === expectNet.toFixed(2) || (expectNet === 0 && hero.includes('0.00')), `${hero} vs ${expectNet}`);
  const kpi = (l) => page.locator('.kpi', { hasText: l }).first().innerText();
  check('expenses KPI = 300', (await kpi('Expenses')).includes('₱300.00'));
  check('receivables KPI = what is still owed', (await kpi('Receivables')).includes(`₱${(d.sales[1].total - 50).toFixed(2)}`), await kpi('Receivables'));
  check('definition tooltips exist', await page.locator('.tip .bubble').count() >= 8);
  check('trend chart and table fallback exist', await page.locator('svg.chart').count() === 1 && await page.getByText('View as table').count() === 1);
  await page.getByRole('button', { name: 'Custom range' }).click();
  check('custom range shows date pickers', await page.getByLabel('From', { exact: true }).isVisible());
  await page.getByRole('button', { name: 'This year' }).click(); await page.locator('.hero .big').waitFor();
  await page.screenshot({ path: path.join(shots, 'dashboard-desktop.png'), fullPage: true });

  console.log('Team and sign out');
  await page.getByRole('link', { name: 'Team' }).click();
  await page.getByRole('row', { name: /Nina New/ }).getByRole('button', { name: 'Activate' }).waitFor();
  check('owner sees the waiting person', true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email').waitFor();
  await login('new@example.com');
  await page.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  check('an inactive person only sees "waiting for approval"', await page.getByRole('link', { name: 'Sell' }).count() === 0);
  await page.screenshot({ path: path.join(shots, 'waiting.png') });

  console.log('Phone width');
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByLabel('Email').waitFor();
  await page.setViewportSize({ width: 390, height: 800 });
  await login('owner@example.com'); await page.evaluate(() => { location.hash = '#/dashboard'; }); await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no sideways scrolling on a phone (dashboard)', !overflow);
  await page.screenshot({ path: path.join(shots, 'dashboard-phone.png'), fullPage: true });
  await page.getByRole('button', { name: /Menu/ }).click(); await page.getByRole('link', { name: 'Sell' }).click();
  await page.getByRole('heading', { name: 'Sell' }).waitFor(); await page.waitForTimeout(400);
  check('menu closes after choosing a page on a phone', !(await page.locator('#sidebar.open').count()));
  check('no sideways scrolling on a phone (sell)', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await page.screenshot({ path: path.join(shots, 'sell-phone.png') });

  console.log('Every screen, phone and desktop');
  for (const [w, h, tag] of [[390, 800, 'phone'], [1280, 860, 'desktop']]) {
    await page.setViewportSize({ width: w, height: h });
    for (const r of ['dashboard', 'sell', 'sales', 'products', 'expenses', 'settings', 'team']) {
      await page.evaluate((x) => { location.hash = '#/' + x; }, r);
      await page.locator('h1').first().waitFor(); await page.waitForTimeout(250);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(`${r} fits the ${tag} screen (no sideways scroll)`, !wide);
      await page.screenshot({ path: path.join(shots, `${r}-${tag}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });

  console.log('Cashier role');
  await page.getByRole('button', { name: 'Sign out' }).click().catch(async () => { await page.getByRole('button', { name: /Menu/ }).click(); await page.getByRole('button', { name: 'Sign out' }).click(); });
  await page.getByLabel('Email').waitFor();
  await login('cashier@example.com');
  await page.getByRole('heading', { name: 'Sell' }).waitFor();
  const links = await page.locator('nav a').allInnerTexts();
  check('cashier menu is only Sell, Sales, Products', links.map((t) => t.replace(/[^A-Za-z]/g, '')).join(',') === 'Sell,Sales,Products', links.join(','));
  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await page.waitForTimeout(250);
  check('cashier cannot open the dashboard by typing the address', await page.getByRole('heading', { name: 'Dashboard' }).count() === 0);
  await page.evaluate(() => { location.hash = '#/products'; }); await page.getByRole('heading', { name: 'Products' }).waitFor();
  check('cashier cannot add or edit products', await page.getByRole('button', { name: '＋ Add product' }).count() === 0 && await page.getByRole('button', { name: 'Edit' }).count() === 0);
  check('cashier does not see cost prices', await page.getByRole('columnheader', { name: 'Cost' }).count() === 0);

  check('no errors in the browser console', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
