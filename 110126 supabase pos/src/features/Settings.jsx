import { useState } from 'react';
import { repo } from '../data/repo.js';
import { useApp } from '../ui/context.js';
import { Field, PageHead } from '../ui/kit.jsx';
import { PAPERS, printHtml, remember } from '../lib/print.js';
import { TrialNameCard } from './Trial.jsx';

// Currencies with 2 decimals (the app stores amounts to the cent). Others such as JPY or VND are not offered.
const CURRENCIES = ['PHP', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'HKD', 'THB', 'MYR', 'INR', 'AED', 'SAR'];

// One-tap setups: they fill in currency, language/region, time zone and the first day of the week.
const REGIONS = [
  { label: 'United States – Eastern (New York, Florida…)', currency: 'USD', locale: 'en-US', timezone: 'America/New_York', week: '0' },
  { label: 'United States – Central (Texas, Illinois…)', currency: 'USD', locale: 'en-US', timezone: 'America/Chicago', week: '0' },
  { label: 'United States – Mountain (Colorado, Utah…)', currency: 'USD', locale: 'en-US', timezone: 'America/Denver', week: '0' },
  { label: 'United States – Arizona (no daylight saving)', currency: 'USD', locale: 'en-US', timezone: 'America/Phoenix', week: '0' },
  { label: 'United States – Pacific (California, Washington…)', currency: 'USD', locale: 'en-US', timezone: 'America/Los_Angeles', week: '0' },
  { label: 'United States – Alaska', currency: 'USD', locale: 'en-US', timezone: 'America/Anchorage', week: '0' },
  { label: 'United States – Hawaii', currency: 'USD', locale: 'en-US', timezone: 'Pacific/Honolulu', week: '0' },
  { label: 'Philippines', currency: 'PHP', locale: 'en-PH', timezone: 'Asia/Manila', week: '1' },
];

export default function Settings() {
  const { can, trial } = useApp();
  return (
    <>
      <PageHead title="Settings" />
      <div className="stack">
        <PrinterCard />
        {trial && <TrialNameCard />}
        {!trial && can('editBusiness') && <BusinessCard />}
        {!trial && can('editBusiness') && <TaxCard />}
        <div className="panels">
          <ListCard title="Product categories" table="categories" listKey="categories" />
          <ListCard title="Sales channels" table="sales_channels" listKey="channels" />
          <ListCard title="Payment methods" table="payment_methods" listKey="methods" />
          <ListCard title="Expense categories" table="expense_categories" listKey="expenseCategories" />
        </div>
      </div>
    </>
  );
}

function useSaver(patchFn) {
  const { business, toast, reload } = useApp();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try { const patch = patchFn(); await repo.saveBusiness(business.id, patch); toast('Saved', 'good'); await reload(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return { busy, error, save };
}

function BusinessCard() {
  const { business } = useApp();
  const [f, setF] = useState({ name: business.name, currency: business.currency, locale: business.locale, timezone: business.timezone, week: String(business.week_starts_on), maxDisc: String(Number(business.cashier_max_discount_pct ?? 100)), header: business.receipt_header || '', footer: business.receipt_footer || '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const applyRegion = (i) => { const r = REGIONS[Number(i)]; if (r) setF((s) => ({ ...s, currency: r.currency, locale: r.locale, timezone: r.timezone, week: r.week })); };
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const { busy, error, save } = useSaver(() => {
    if (!f.name.trim()) throw new Error('Please enter the business name.');
    if (!/^[A-Za-z]{3}$/.test(f.currency)) throw new Error('The currency must be a 3-letter code such as PHP.');
    try { new Intl.DateTimeFormat(f.locale, { timeZone: f.timezone }); } catch { throw new Error('That language/region or time zone is not recognised (examples: en-PH and Asia/Manila).'); }
    const md = Number(f.maxDisc);
    if (!Number.isFinite(md) || md < 0 || md > 100) throw new Error('The cashier discount limit must be between 0 and 100 percent.');
    return { cashier_max_discount_pct: md, name: f.name.trim(), currency: f.currency.toUpperCase(), locale: f.locale.trim(), timezone: f.timezone.trim(), week_starts_on: Number(f.week), receipt_header: f.header.trim() || null, receipt_footer: f.footer.trim() || null };
  });
  return (
    <section className="card"><h2>Business</h2>
      <Field label="Quick setup by region" id="rg" hint="Pick your state's time zone and the dollar in one step. You can still change each box below."><select id="rg" className="input" defaultValue="" onChange={(e) => applyRegion(e.target.value)}><option value="" disabled>Choose a region…</option>{REGIONS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}</select></Field>
      <div className="grid2" style={{ marginTop: '.6rem' }}>
        <Field label="Business name" id="bn"><input id="bn" className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Currency" id="bc"><input id="bc" className="input" list="currencies" value={f.currency} onChange={set('currency')} /><datalist id="currencies">{CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Language / region" id="bl" hint="Controls how numbers and dates look, e.g. en-PH"><input id="bl" className="input" value={f.locale} onChange={set('locale')} /></Field>
        <Field label="Time zone" id="bt" hint="Decides where one day ends and the next begins in reports."><input id="bt" className="input" list="zones" value={f.timezone} onChange={set('timezone')} /><datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist></Field>
        <Field label="Week starts on" id="bw"><select id="bw" className="input" value={f.week} onChange={set('week')}><option value="1">Monday</option><option value="0">Sunday</option></select></Field>
      </div>
      <Field label="Largest discount a cashier may give (%)" id="md" hint="100 means no limit. Owners and managers are never limited."><input id="md" className="input" inputMode="decimal" value={f.maxDisc} onChange={set('maxDisc')} /></Field>
      <Field label="Receipt header (optional)" id="rh" hint="Printed under the business name. Use several lines: address, phone, tax ID (TIN / EIN)…"><textarea id="rh" className="input" rows={3} value={f.header} onChange={set('header')} /></Field>
      <Field label="Receipt footer" id="rf" hint="For example: Thank you! · Returns within 7 days with this receipt."><textarea id="rf" className="input" rows={2} value={f.footer} onChange={set('footer')} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save business'}</button>
    </section>
  );
}

function TaxCard() {
  const { business } = useApp();
  const [f, setF] = useState({ enabled: business.tax_enabled, name: business.tax_name, rate: String(Number(business.tax_rate)), mode: business.tax_mode });
  const { busy, error, save } = useSaver(() => {
    const rate = Number(f.rate);
    if (f.enabled && (!Number.isFinite(rate) || rate <= 0 || rate > 100)) throw new Error('Enter a tax rate above 0 and up to 100 (for example 12).');
    if (f.enabled && !f.name.trim()) throw new Error('Give the tax a name, such as VAT.');
    return { tax_enabled: f.enabled, tax_name: f.name.trim() || 'Tax', tax_rate: f.enabled ? rate : Number(business.tax_rate) || 0, tax_mode: f.mode };
  });
  return (
    <section className="card"><h2>Tax (optional)</h2>
      <label className="check" style={{ marginTop: '.5rem' }}><input type="checkbox" checked={f.enabled} onChange={(e) => setF((s) => ({ ...s, enabled: e.target.checked }))} />My business charges tax</label>
      {!f.enabled && <p className="muted small">Tax is off. Receipts and reports will not show any tax.</p>}
      {f.enabled && <>
        <div className="grid2" style={{ marginTop: '.5rem' }}>
          <Field label="Tax name" id="tn"><input id="tn" className="input" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} /></Field>
          <Field label="Rate %" id="tr"><input id="tr" className="input" inputMode="decimal" value={f.rate} onChange={(e) => setF((s) => ({ ...s, rate: e.target.value }))} /></Field>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 .75rem' }}><legend style={{ fontWeight: 600, fontSize: '.9rem' }}>How are your prices set?</legend>
          <label className="check"><input type="radio" name="mode" checked={f.mode === 'inclusive'} onChange={() => setF((s) => ({ ...s, mode: 'inclusive' }))} />Tax is included in my prices (customer pays the price shown)</label>
          <label className="check"><input type="radio" name="mode" checked={f.mode === 'exclusive'} onChange={() => setF((s) => ({ ...s, mode: 'exclusive' }))} />Tax is added on top (customer pays price + tax)</label>
        </fieldset>
        <p className="muted small">Example: a ₱100 item at 12% — {f.mode === 'inclusive' ? 'customer pays ₱100, of which ₱10.71 is tax' : 'customer pays ₱112, of which ₱12.00 is tax'}. Mark individual products as tax exempt in Products.</p>
      </>}
      <p className="muted small">Changes apply to new sales only. Past sales keep the tax they were recorded with.</p>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save tax settings'}</button>
    </section>
  );
}

function ListCard({ title, table, listKey }) {
  const app = useApp();
  const rows = app[listKey];
  const [name, setName] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); setError(''); try { await fn(); await app.reload(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const add = () => { if (!name.trim()) return; run(async () => { await repo.saveLookup(table, { name: name.trim(), sort_order: Math.max(0, ...rows.map((r) => r.sort_order)) + 1 }); setName(''); }); };
  return (
    <section className="card"><h2>{title}</h2>
      <p className="muted small">Items are switched off, never deleted, so old records keep their names.</p>
      {rows.map((r) => <ListRow key={r.id} row={r} table={table} run={run} busy={busy} />)}
      <div className="row" style={{ marginTop: '.6rem' }}>
        <input className="input grow" aria-label={`New ${title}`} placeholder="Add new…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} style={{ flex: 1 }} />
        <button className="btn" onClick={add} disabled={busy || !name.trim()}>Add</button>
      </div>
      {error && <div className="notice bad" role="alert" style={{ marginTop: '.5rem' }}>{error}</div>}
    </section>
  );
}

function ListRow({ row, table, run, busy }) {
  const [text, setText] = useState(row.name);
  return (
    <div className="row" style={{ marginTop: '.4rem', opacity: row.active ? 1 : .6 }}>
      <input className="input" style={{ flex: 1 }} aria-label="Name" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text.trim() !== row.name && run(() => repo.saveLookup(table, { id: row.id, name: text.trim() }))} />
      <button className="btn secondary small" disabled={busy} onClick={() => run(() => repo.saveLookup(table, { id: row.id, active: !row.active }))}>{row.active ? 'Switch off' : 'Switch on'}</button>
    </div>
  );
}

/** Per-device printing choice plus a test receipt, so a new printer can be checked without making a sale. */
function PrinterCard() {
  const { business, money } = useApp();
  const [paper, setPaper] = useState(() => (PAPERS[remember('pos.paper')] ? remember('pos.paper') : '80'));
  const test = () => {
    const sample = [['Sample item with a rather long name', 2, 12550], ['Short', 1, 1000]]; // prices in cents, like everywhere else in the app
    const total = sample.reduce((n, [, q, p]) => n + q * p, 0);
    const html = `<div class="receipt"><h3>${esc(business.name)}</h3><div class="center">TEST RECEIPT</div><div class="center">${esc(new Date().toLocaleString(business.locale, { timeZone: business.timezone }))}</div><hr />`
      + sample.map(([n, q, p]) => `<div><div>${esc(n)}</div><div class="line"><span>${q} × ${esc(money(p))}</span><span>${esc(money(q * p))}</span></div></div>`).join('')
      + `<hr /><div class="line"><strong>TOTAL</strong><strong>${esc(money(total))}</strong></div><hr /><div class="center">Centred and nothing cut off?\nThen your printer is set up.</div></div>`;
    printHtml(html, { paper, title: 'Test receipt' });
  };
  return (
    <section className="card"><h2>Receipt printer (this device)</h2>
      <p className="muted small">Each device remembers its own paper size. Choose the paper that is in your printer, then print a test receipt.</p>
      <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Paper" id="pp"><select id="pp" className="input" value={paper} onChange={(e) => { setPaper(e.target.value); remember('pos.paper', e.target.value); }}>{Object.entries(PAPERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <button className="btn secondary" onClick={test}>Print test receipt</button>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>In the print window: pick your receipt printer, set Margins to <strong>None</strong>, and turn off &ldquo;Headers and footers&rdquo;. See docs/PRINTING.md.</p>
    </section>
  );
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
