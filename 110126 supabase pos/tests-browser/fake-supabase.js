// A tiny in-memory stand-in for Supabase, used ONLY by the browser tests (the real package cannot be
// installed in the test sandbox). It implements just the calls the app makes. The sale maths reuses the
// app's own calculator, so these tests check the screens and the flow; the SQL itself is checked by
// supabase/verify.sql on a real database.
import { computeSale } from '../src/lib/tax.js';
import { planReturn } from '../src/lib/returns.js';

const uid = () => crypto.randomUUID();
const OWNER = { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com' };
const CASH = { id: '00000000-0000-4000-8000-000000000003', email: 'cashier@example.com' };
const WAIT = { id: '00000000-0000-4000-8000-000000000002', email: 'new@example.com' };
const TRIAL = { id: '00000000-0000-4000-8000-000000000009', email: 'trial@example.com' };

const cat = (name, n) => ({ id: uid(), name, sort_order: n, active: true });
const db = {
  businesses: [{ id: uid(), name: 'Test Mart', currency: 'PHP', locale: 'en-PH', timezone: 'Asia/Manila', week_starts_on: 1, tax_enabled: false, tax_name: 'Tax', tax_rate: 0, tax_mode: 'inclusive', receipt_header: 'Branch 1', receipt_footer: 'Thank you!' }],
  profiles: [
    { id: OWNER.id, name: 'Olivia Owner', email: OWNER.email, role: 'owner', active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: CASH.id, name: 'Carl Cashier', email: CASH.email, role: 'cashier', active: true, created_at: '2026-01-15T00:00:00Z' },
    { id: WAIT.id, name: 'Nina New', email: WAIT.email, role: 'cashier', active: false, created_at: '2026-02-01T00:00:00Z' },
    { id: TRIAL.id, name: 'Tina Trial', email: TRIAL.email, role: 'owner', active: true, account_type: 'trial', created_at: '2026-03-01T00:00:00Z' },
  ],
  categories: [cat('Drinks', 1), cat('Snacks', 2)],
  expense_categories: [cat('Rent', 1), cat('Supplies', 2)],
  sales_channels: [cat('In-store', 1)],
  payment_methods: [cat('Cash', 1), cat('E-wallet', 2)],
  products: [], customers: [], sales: [], sale_items: [], payments: [], expenses: [], inventory_movements: [], returns: [], return_items: [], shifts: [], cash_movements: [],
};
const P = (name, price, cost, qty, extra = {}) => ({ id: uid(), name, sku: null, barcode: null, category_id: db.categories[0].id, price, cost_price: cost, track_stock: true, quantity: qty, reorder_level: 5, tax_exempt: false, active: true, ...extra });
db.products.push(P('Cola 290ml', 100, 40, 10), P('Chips 60g', 50, 20, 5, { tax_exempt: true, barcode: '4800' }), P('Rice 1kg', 55, 40, 3, { reorder_level: 5 }));
db.customers.push({ id: uid(), name: 'Aling Rosa', phone: null });

let session = null; const listeners = new Set();
const fail = () => (window.__fakeFail ||= {});
const setSession = (s, ev = 'SIGNED_IN') => { session = s; listeners.forEach((l) => l(ev, s)); save(); };
// Optional (offline browser test only): keep the pretend database and sign-in across page reloads, like a real server and a real browser would.
function save() { if (!window.__fakePersist) return; try { localStorage.setItem('fake.db', JSON.stringify(db)); localStorage.setItem('fake.session', JSON.stringify(session)); } catch { /* ignore */ } }
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem('fake.db') || 'null'); if (d) Object.keys(d).forEach((k) => { db[k] = d[k]; });
    const s = JSON.parse(localStorage.getItem('fake.session') || 'null'); if (s) session = s;
  } catch { /* ignore */ }
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const num = (v) => Number(v);
const r2 = (v) => Math.round(v * 100) / 100;

function overview() {
  return db.sales.map((s) => {
    const paid = db.payments.filter((p) => p.sale_id === s.id).reduce((n, p) => n + num(p.amount), 0);
    const rs = db.returns.filter((r) => r.sale_id === s.id); const returned = rs.reduce((n, r) => n + num(r.total), 0); const refunded = rs.reduce((n, r) => n + num(r.refund_amount), 0);
    return { ...s, paid: r2(paid), returned: r2(returned), refunded: r2(refunded), balance: s.status === 'completed' ? r2(s.total - returned - (paid - refunded)) : 0 };
  });
}
const netDown = () => (window.__fake && window.__fake.net === false) || (() => { try { return localStorage.getItem('fake.net') === 'down'; } catch { return false; } })();
const currentUserId = () => (session?.user?.id) || OWNER.id;
function table(name) { return name === 'sales_overview' ? overview() : db[name]; }

class Q {
  constructor(name) { this.name = name; this.f = []; this.ord = []; this.lim = null; this.op = 'select'; this.payload = null; this.one = null; }
  select() { return this; }
  order(c, o = {}) { this.ord.push([c, o.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
  gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
  lt(c, v) { this.f.push((r) => r[c] < v); return this; }
  lte(c, v) { this.f.push((r) => r[c] <= v); return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  then(res, rej) { return this.run().then(res, rej); }
  async run() {
    await new Promise((r) => setTimeout(r, 5));
    if (netDown()) return { data: null, error: { message: 'Failed to fetch' } };
    try {
      const rows = table(this.name);
      if (!rows) throw new Error(`unknown table ${this.name}`);
      let out;
      if (this.op === 'insert') {
        const row = { id: uid(), active: true, created_at: new Date().toISOString(), ...this.payload };
        if (this.name === 'products' && row.track_stock !== false) db.inventory_movements.push({ id: uid(), product_id: row.id, type: 'initial', quantity_change: row.quantity, quantity_after: row.quantity, created_at: row.created_at });
        rows.push(row); out = [row];
      } else if (this.op === 'update') {
        out = rows.filter((r) => this.f.every((f) => f(r)));
        if (this.name === 'products' && 'quantity' in this.payload) throw new Error('Stock can only be changed with a stock adjustment or a sale.');
        out.forEach((r) => Object.assign(r, this.payload));
      } else {
        out = rows.filter((r) => this.f.every((f) => f(r)));
        for (const [c, asc] of [...this.ord].reverse()) out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
        if (this.lim != null) out = out.slice(0, this.lim);
        if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      }
      if (this.op !== 'select') save();
      out = clone(out);
      if (this.one === 'single') { if (out.length !== 1) throw new Error('Expected one row'); return { data: out[0], error: null }; }
      if (this.one === 'maybe') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  }
}

const money = (v) => r2(v);
function rpc(name, a) {
  if (name === 'create_sale') {
    if (fail().createSale > 0) { fail().createSale -= 1; throw new TypeError('Failed to fetch'); }
    const sale = a.p_sale; const existing = db.sales.find((s) => s.id === sale.id);
    if (existing) return { ok: true, duplicate: true, sale_id: existing.id, invoice_number: existing.invoice_number, total: existing.total };
    const b = db.businesses[0];
    const off = sale.offline === true; const flags = {};
    const lines = a.p_items.map((i) => { const p = db.products.find((x) => x.id === i.product_id); if (!p || (!p.active && !off)) throw new Error('One of the products is missing or switched off.'); if (!off && p.track_stock && num(p.quantity) < i.quantity) throw new Error(`Not enough stock for ${p.name}`); if (off && p.track_stock && num(p.quantity) < i.quantity) flags.stock = `${p.name}: sold ${i.quantity}, only ${p.quantity} was in the system. Stock was set to 0: please recount.`; const price = off && i.unit_price != null && i.unit_price >= 0 ? i.unit_price : p.price; if (price !== p.price) flags.price = `${p.name}: sold at ${price}, price now ${p.price}`; return { p, qty: i.quantity, price }; });
    const tax = off && sale.tax_mode ? { enabled: sale.tax_mode !== 'none', rate: num(sale.tax_rate), mode: sale.tax_mode } : { enabled: b.tax_enabled, rate: num(b.tax_rate), mode: b.tax_mode };
    if (off && sale.tax_mode && (sale.tax_mode !== (b.tax_enabled ? b.tax_mode : 'none') || num(sale.tax_rate) !== (b.tax_enabled ? num(b.tax_rate) : 0))) flags.tax = 'Tax at the time of sale differs from the current setting.';
    const calc = computeSale({
      lines: lines.map(({ p, qty, price }) => ({ qty, priceCents: Math.round(price * 100), costCents: Math.round(p.cost_price * 100), taxExempt: p.tax_exempt })),
      discount: sale.discount_type ? { type: sale.discount_type, value: sale.discount_type === 'amount' ? Math.round(sale.discount_value * 100) : sale.discount_value } : null,
      tax,
    });
    const id = sale.id; const paid = (a.p_payments || []).reduce((n, p) => n + p.amount, 0);
    if (paid > calc.total / 100 + 1e-9) throw new Error('Payments are more than the total.');
    const row = { id, invoice_number: `INV-${String(db.sales.length + 1).padStart(6, '0')}`, channel_id: sale.channel_id, customer_id: sale.customer_id, cashier_id: currentUserId(), status: 'completed', subtotal: calc.subtotal / 100, discount_amount: calc.discount / 100, tax_mode: calc.mode, tax_name: calc.mode === 'none' ? null : b.tax_name, tax_rate: calc.mode === 'none' ? 0 : tax.rate, tax_amount: calc.tax / 100, total: calc.total / 100, net_sales: calc.net / 100, cogs: calc.cogs / 100, note: sale.note, occurred_at: sale.occurred_at || new Date().toISOString(), created_at: new Date().toISOString() };
    db.sales.push(row);
    lines.forEach(({ p, qty, price }, i) => { db.sale_items.push({ id: uid(), sale_id: id, line_no: i + 1, product_id: p.id, name: p.name, quantity: qty, unit_price: price, unit_cost: p.cost_price, line_gross: calc.lines[i].gross / 100, discount_amount: calc.lines[i].discount / 100, tax_amount: calc.lines[i].tax / 100, line_total: calc.lines[i].total / 100 }); if (p.track_stock) { const before = p.quantity; p.quantity = off ? Math.max(0, p.quantity - qty) : p.quantity - qty; db.inventory_movements.push({ id: uid(), product_id: p.id, type: 'sale', quantity_change: p.quantity - before, quantity_after: p.quantity, created_at: row.created_at }); } });
    (a.p_payments || []).forEach((p) => db.payments.push({ id: p.id || uid(), sale_id: id, method_id: p.method_id, amount: p.amount, paid_at: row.occurred_at }));
    if (off) {
      (db.sale_offline ||= []).push({ sale_id: id, uploaded_at: new Date().toISOString() });
      Object.entries(flags).forEach(([kind, note]) => (db.sale_reviews ||= []).push({ id: uid(), sale_id: id, kind, note, created_at: new Date().toISOString(), resolved_at: null }));
      return { ok: true, duplicate: false, sale_id: id, invoice_number: row.invoice_number, total: row.total, tax_amount: row.tax_amount, flagged: Object.keys(flags).length };
    }
    return { ok: true, duplicate: false, sale_id: id, invoice_number: row.invoice_number, total: row.total, tax_amount: row.tax_amount };
  }
  if (name === 'server_time') return new Date().toISOString();
  if (name === 'get_sale_reviews') return (db.sale_reviews || []).filter((r) => a.p_include_resolved || !r.resolved_at).map((r) => { const s = db.sales.find((x) => x.id === r.sale_id); return { id: r.id, sale_id: r.sale_id, invoice_number: s.invoice_number, kind: r.kind, note: r.note, total: s.total, occurred_at: s.occurred_at, cashier: 'Carl Cashier', resolved_at: r.resolved_at }; });
  if (name === 'resolve_sale_review') { const r = (db.sale_reviews || []).find((x) => x.id === a.p_id); if (!r) throw new Error('That item was not found.'); r.resolved_at ||= new Date().toISOString(); return { ok: true }; }
  if (name === 'void_sale') {
    const s = db.sales.find((x) => x.id === a.p_sale_id); if (!s) throw new Error('Sale not found.'); if (!a.p_reason?.trim()) throw new Error('Please give a reason.');
    if (s.status === 'voided') return { ok: true, duplicate: true };
    if (db.returns.some((r) => r.sale_id === s.id)) throw new Error('This sale already has a return, so it cannot be voided. Return the remaining items instead.');
    s.status = 'voided'; s.void_reason = a.p_reason;
    db.sale_items.filter((i) => i.sale_id === s.id).forEach((i) => { const p = db.products.find((x) => x.id === i.product_id); if (p.track_stock) p.quantity += num(i.quantity); });
    return { ok: true, duplicate: false };
  }
  if (name === 'record_payment') {
    const s = overview().find((x) => x.id === a.p_sale_id); if (a.p_amount > s.balance + 1e-9) throw new Error(`That is more than the balance (${s.balance}).`);
    if (db.payments.some((p) => p.id === a.p_payment_id)) return { ok: true, duplicate: true };
    db.payments.push({ id: a.p_payment_id, sale_id: a.p_sale_id, method_id: a.p_method_id, amount: a.p_amount, paid_at: new Date().toISOString(), note: a.p_note });
    return { ok: true, duplicate: false };
  }
  if (name === 'create_return') {
    const ret = a.p_return; const dup = db.returns.find((r) => r.id === ret.id);
    if (dup) return { ok: true, duplicate: true, return_id: dup.id, return_number: dup.return_number, total: dup.total, refund_amount: dup.refund_amount };
    if (!String(ret.reason || '').trim()) throw new Error('Please give a reason for the return.');
    const sale = db.sales.find((s) => s.id === ret.sale_id); if (!sale) throw new Error('Sale not found.'); if (sale.status !== 'completed') throw new Error('This sale was voided, so nothing can be returned.');
    const c = (v) => Math.round(num(v) * 100); const own = overview().find((s) => s.id === sale.id);
    const lines = db.sale_items.filter((i) => i.sale_id === sale.id).map((i) => { const prior = { qtyMilli: 0, gross: 0, discount: 0, tax: 0, total: 0, basis: 0 }; db.return_items.filter((x) => x.sale_item_id === i.id).forEach((x) => { prior.qtyMilli += Math.round(num(x.quantity) * 1000); prior.gross += c(x.gross); prior.discount += c(x.discount_amount); prior.tax += c(x.tax_amount); prior.total += c(x.total); prior.basis += c(x.cogs_basis); }); return { id: i.id, name: i.name, product_id: i.product_id, qtyMilli: Math.round(num(i.quantity) * 1000), gross: c(i.line_gross), discount: c(i.discount_amount), tax: c(i.tax_amount), total: c(i.line_total), unitCost: c(i.unit_cost), prior }; });
    const plan = planReturn({ sale: { total: c(sale.total), taxMode: sale.tax_mode }, lines, items: a.p_items.map((i) => ({ id: i.sale_item_id, qtyMilli: Math.round(num(i.quantity) * 1000), restock: i.restock })), money: { paid: c(own.paid), returned: c(own.returned), refunded: c(own.refunded) } });
    if (plan.refund > 0 && !ret.refund_method_id) throw new Error('Choose how the money is given back.');
    const row = { id: ret.id || uid(), return_number: `RET-${String(db.returns.length + 1).padStart(6, '0')}`, invoice_number: sale.invoice_number, sale_id: sale.id, reason: ret.reason.trim(), subtotal: plan.subtotal / 100, discount_amount: plan.discount / 100, tax_amount: plan.tax / 100, total: plan.total / 100, net_amount: plan.net / 100, cogs: plan.cogs / 100, refund_amount: plan.refund / 100, refund_method_id: plan.refund > 0 ? ret.refund_method_id : null, occurred_at: new Date().toISOString() };
    db.returns.push(row);
    plan.lines.forEach((l) => { db.return_items.push({ id: uid(), return_id: row.id, sale_item_id: l.id, product_id: lines.find((x) => x.id === l.id).product_id, name: l.name, quantity: l.qtyMilli / 1000, gross: l.gross / 100, discount_amount: l.discount / 100, tax_amount: l.tax / 100, total: l.total / 100, cogs_basis: l.cogsBasis / 100, cogs: l.cogs / 100, restocked: l.restocked }); const p = db.products.find((x) => x.id === lines.find((y) => y.id === l.id).product_id); if (l.restocked && p.track_stock) { p.quantity = r2(num(p.quantity) + l.qtyMilli / 1000); db.inventory_movements.push({ id: uid(), product_id: p.id, type: 'return', quantity_change: l.qtyMilli / 1000, quantity_after: p.quantity, created_at: row.occurred_at }); } });
    return { ok: true, duplicate: false, return_id: row.id, return_number: row.return_number, total: row.total, refund_amount: row.refund_amount };
  }
  if (name === 'adjust_stock') {
    const p = db.products.find((x) => x.id === a.p_product_id); if (num(p.quantity) + a.p_change < 0) throw new Error('Stock cannot go below zero.');
    p.quantity = r2(num(p.quantity) + a.p_change * 1); db.inventory_movements.push({ id: uid(), product_id: p.id, type: 'adjustment', quantity_change: a.p_change, quantity_after: p.quantity, note: a.p_note, created_at: new Date().toISOString() });
    return { ok: true, quantity: p.quantity };
  }
  if (name === 'get_tax_report') {
    const day = (iso) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
    const inR = (s) => day(s.occurred_at) >= a.p_from && day(s.occurred_at) <= a.p_to;
    const ss = db.sales.filter((s) => s.status === 'completed' && inR(s)); const ids = new Set(ss.map((s) => s.id));
    const rs = db.returns.filter((r) => day(r.occurred_at) >= a.p_from && day(r.occurred_at) <= a.p_to); const rids = new Set(rs.map((r) => r.id));
    const its = db.sale_items.filter((i) => ids.has(i.sale_id)); const rits = db.return_items.filter((i) => rids.has(i.return_id));
    const sum = (arr, f) => money(arr.reduce((n, x) => n + f(x), 0)); const origTax = (ri) => num(db.sale_items.find((i) => i.id === ri.sale_item_id).tax_amount);
    const tot = { orders: ss.length, gross_sales: money(sum(ss, (s) => num(s.subtotal)) - sum(rs, (r) => num(r.subtotal))), discounts: money(sum(ss, (s) => num(s.discount_amount)) - sum(rs, (r) => num(r.discount_amount))), tax_collected: money(sum(ss, (s) => num(s.tax_amount)) - sum(rs, (r) => num(r.tax_amount))), billed: money(sum(ss, (s) => num(s.total)) - sum(rs, (r) => num(r.total))), net_sales: money(sum(ss, (s) => num(s.net_sales)) - sum(rs, (r) => num(r.net_amount))),
      taxable_sales: money(sum(its.filter((i) => num(i.tax_amount) > 0), (i) => num(i.line_total) - num(i.tax_amount)) - sum(rits.filter((ri) => origTax(ri) > 0), (ri) => num(ri.total) - num(ri.tax_amount))), not_taxable_sales: money(sum(its.filter((i) => num(i.tax_amount) === 0), (i) => num(i.line_total) - num(i.tax_amount)) - sum(rits.filter((ri) => origTax(ri) === 0), (ri) => num(ri.total) - num(ri.tax_amount))),
      returns_count: rs.length, returns_total: sum(rs, (r) => num(r.total)), returns_tax: sum(rs, (r) => num(r.tax_amount)) };
    const days = []; for (let d = new Date(a.p_from + 'T00:00:00Z'); d <= new Date(a.p_to + 'T00:00:00Z'); d = new Date(d.getTime() + 864e5)) { const k = d.toISOString().slice(0, 10); const x = ss.filter((s) => day(s.occurred_at) === k); const y = rs.filter((r) => day(r.occurred_at) === k); days.push({ date: k, orders: x.length, net_sales: money(sum(x, (s) => num(s.net_sales)) - sum(y, (r) => num(r.net_amount))), tax: money(sum(x, (s) => num(s.tax_amount)) - sum(y, (r) => num(r.tax_amount))), billed: money(sum(x, (s) => num(s.total)) - sum(y, (r) => num(r.total))), returned: sum(y, (r) => num(r.total)) }); }
    const v = db.sales.filter((s) => s.status === 'voided' && inR(s));
    return { range: { from: a.p_from, to: a.p_to, timezone: 'Asia/Manila' }, totals: tot, by_rate: ss.length ? [{ tax_name: 'VAT', tax_rate: 12, tax_mode: 'inclusive', orders: ss.length, taxable_sales: tot.taxable_sales, not_taxable_sales: tot.not_taxable_sales, tax: tot.tax_collected }] : [], daily: days, voided: { orders: v.length, billed: sum(v, (s) => num(s.total)), tax: sum(v, (s) => num(s.tax_amount)) } };
  }
  // ----- trial sandbox (the real rules are checked on real Postgres by supabase/verify-trial.sql) -----
  if (name === 'trial_begin') { db.__trial = db.__trial || { calls: [], live: null }; db.__trial.calls.push(name); if (!db.__trial.live) db.__trial.live = { session_id: uid(), mode: 'sample', business_name: null, expires_at: '2099-01-01T00:00:00Z' }; return db.__trial.live; }
  if (name === 'trial_heartbeat') { db.__trial.calls.push(name); if (db.__trial.expired) throw new Error('Your trial session has ended. Please sign in again.'); return db.__trial.live; }
  if (name === 'trial_start_fresh') { db.__trial.calls.push(name); ['products', 'customers', 'sales', 'sale_items', 'payments', 'expenses', 'inventory_movements', 'returns', 'return_items', 'shifts', 'cash_movements'].forEach((t) => { db[t].length = 0; }); db.__trial.live = { ...db.__trial.live, session_id: uid(), mode: 'empty' }; return db.__trial.live; }
  if (name === 'trial_set_business_name') { db.__trial.calls.push(name); db.__trial.live = { ...db.__trial.live, business_name: String(a.p_name).trim() }; return db.__trial.live; }
  if (name === 'trial_end') { db.__trial = db.__trial || { calls: [] }; db.__trial.calls.push(name); db.__trial.live = null; return { ok: true, trial: true }; }
  if (name === 'get_dashboard') return dashboard(a);
  // ----- cash drawer (mirrors supabase private.shift_figures; the real SQL is checked by tests-db/drawer.mjs) -----
  if (['current_shift', 'get_shift', 'open_shift', 'add_cash_movement', 'close_shift'].includes(name)) return drawer(name, a);
  throw new Error(`unknown rpc ${name}`);
}


function shiftFigures(sh) {
  const end = sh.closed_at || new Date().toISOString(); const inWin = (t) => t >= sh.opened_at && t <= end;
  const isCash = (id) => /cash/i.test(db.payment_methods.find((m) => m.id === id)?.name || '');
  const pays = db.payments.filter((p) => inWin(p.paid_at)); const saleOf = (p) => db.sales.find((x) => x.id === p.sale_id);
  const cashPays = pays.filter((p) => isCash(p.method_id)); const sum = (l, f) => l.reduce((n, x) => n + num(f(x)), 0);
  const rets = db.returns.filter((r) => inWin(r.occurred_at || r.created_at)); const mv = db.cash_movements.filter((c) => c.shift_id === sh.id);
  const names = {}; pays.filter((p) => !isCash(p.method_id)).forEach((p) => { const n = db.payment_methods.find((m) => m.id === p.method_id)?.name || 'Unknown'; names[n] = (names[n] || 0) + num(p.amount); });
  const f = { opening_cash: num(sh.opening_cash), cash_received: r2(sum(cashPays, (p) => p.amount)), cash_refunded: r2(sum(rets.filter((r) => isCash(r.refund_method_id)), (r) => r.refund_amount)),
    cash_in: r2(sum(mv.filter((c) => c.kind === 'in'), (c) => c.amount)), cash_out: r2(sum(mv.filter((c) => c.kind === 'out'), (c) => c.amount)),
    other_methods: Object.keys(names).sort().map((k) => ({ method: k, amount: r2(names[k]) })), other_refunded: r2(sum(rets.filter((r) => !isCash(r.refund_method_id)), (r) => r.refund_amount)),
    sales_paid: new Set(pays.map((p) => p.sale_id)).size, returns: rets.length, voided_cash: r2(sum(cashPays.filter((p) => saleOf(p)?.status === 'voided'), (p) => p.amount)) };
  f.expected_cash = r2(f.opening_cash + f.cash_received - f.cash_refunded + f.cash_in - f.cash_out);
  return f;
}
function drawer(name, a) {
  const who = (id) => db.profiles.find((p) => p.id === id)?.name || null; const me = fail().user === 'cashier@example.com' ? CASH.id : OWNER.id;
  const open = db.shifts.find((x) => !x.closed_at);
  const view = (sh) => ({ shift: clone(sh), figures: sh.closed_at ? sh.summary : shiftFigures(sh), opened_by_name: who(sh.opened_by), closed_by_name: who(sh.closed_by), movements: db.cash_movements.filter((c) => c.shift_id === sh.id) });
  if (name === 'current_shift') return open ? view(open) : null;
  if (name === 'get_shift') { const sh = db.shifts.find((x) => x.id === a.p_shift_id); if (!sh) throw new Error('Shift not found.'); return view(sh); }
  if (name === 'open_shift') {
    const x = a.p_shift; const dup = x.id && db.shifts.find((y) => y.id === x.id); if (dup) return { ok: true, duplicate: true, shift_id: dup.id, shift_number: dup.shift_number };
    if (x.opening_cash == null || x.opening_cash < 0) throw new Error('Enter the cash counted into the drawer (0 or more).');
    if (open) throw new Error(`A shift is already open (${open.shift_number}). Close it first.`);
    const row = { id: x.id || uid(), shift_number: `SHIFT-${String(db.shifts.length + 1).padStart(5, '0')}`, opened_by: me, opened_at: new Date().toISOString(), opening_cash: x.opening_cash, open_note: x.note || null, closed_by: null, closed_at: null, expected_cash: null, counted_cash: null, difference: null, close_note: null, summary: null };
    db.shifts.push(row); return { ok: true, duplicate: false, shift_id: row.id, shift_number: row.shift_number };
  }
  if (name === 'add_cash_movement') {
    const x = a.p_move; if (x.id && db.cash_movements.some((c) => c.id === x.id)) return { ok: true, duplicate: true };
    if (!(x.amount > 0)) throw new Error('The amount must be above zero.'); if (!String(x.reason || '').trim()) throw new Error('Please write what the cash was for.'); if (!open) throw new Error('There is no open shift. Open one first.');
    db.cash_movements.push({ id: x.id || uid(), shift_id: open.id, kind: x.kind, amount: x.amount, reason: x.reason.trim(), created_by: me, created_at: new Date().toISOString() }); return { ok: true, duplicate: false, expected_cash: shiftFigures(open).expected_cash };
  }
  const sh = db.shifts.find((x) => x.id === a.p_shift_id); if (!sh) throw new Error('Shift not found.');
  if (sh.closed_at) return { ok: true, duplicate: true, shift_id: sh.id, expected_cash: sh.expected_cash, counted_cash: sh.counted_cash, difference: sh.difference };
  if (a.p_counted == null || a.p_counted < 0) throw new Error('Enter the cash you counted (0 or more).');
  const fig = shiftFigures(sh); const diff = r2(a.p_counted - fig.expected_cash);
  if (diff !== 0 && !String(a.p_note || '').trim()) throw new Error(`The cash counted is ${diff < 0 ? 'short' : 'over'} compared with what was expected. Please write a note that explains it.`);
  Object.assign(sh, { closed_by: me, closed_at: new Date().toISOString(), expected_cash: fig.expected_cash, counted_cash: a.p_counted, difference: diff, close_note: a.p_note || null });
  sh.summary = { ...fig }; return { ok: true, duplicate: false, shift_id: sh.id, expected_cash: fig.expected_cash, counted_cash: a.p_counted, difference: diff };
}

function dashboard({ p_from, p_to, p_prev_from, p_prev_to }) {
  const day = (iso) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const totals = (f, t) => {
    const ss = db.sales.filter((s) => s.status === 'completed' && day(s.occurred_at) >= f && day(s.occurred_at) <= t);
    const rs = db.returns.filter((r) => day(r.occurred_at) >= f && day(r.occurred_at) <= t); const rids = new Set(rs.map((r) => r.id));
    const ids = new Set(ss.map((s) => s.id)); const sum = (k) => money(ss.reduce((n, s) => n + num(s[k]), 0)); const rsum = (k) => money(rs.reduce((n, r) => n + num(r[k]), 0));
    const collected = money(db.payments.filter((p) => ids.has(p.sale_id)).reduce((n, p) => n + num(p.amount), 0) - rsum('refund_amount'));
    const exp = money(db.expenses.filter((e) => !e.voided_at && e.expense_date >= f && e.expense_date <= t).reduce((n, e) => n + num(e.amount), 0));
    const units = db.sale_items.filter((i) => ids.has(i.sale_id)).reduce((n, i) => n + num(i.quantity), 0) - db.return_items.filter((i) => rids.has(i.return_id)).reduce((n, i) => n + num(i.quantity), 0);
    const net = money(sum('net_sales') - rsum('net_amount')); const cogs = money(sum('cogs') - rsum('cogs'));
    return { orders: ss.length, units, gross_sales: money(sum('subtotal') - rsum('subtotal')), discounts: money(sum('discount_amount') - rsum('discount_amount')), tax_collected: money(sum('tax_amount') - rsum('tax_amount')), billed: money(sum('total') - rsum('total')), net_sales: net, cogs, gross_profit: money(net - cogs), collected, expenses: exp, net_profit: money(net - cogs - exp), returns_count: rs.length, returns_total: rsum('total'), refunded: rsum('refund_amount') };
  };
  const series = []; for (let d = new Date(p_from + 'T00:00:00Z'); d <= new Date(p_to + 'T00:00:00Z'); d = new Date(d.getTime() + 864e5)) { const k = d.toISOString().slice(0, 10); const t = totals(k, k); series.push({ date: k, orders: t.orders, net_sales: t.net_sales, gross_profit: t.gross_profit, expenses: t.expenses }); }
  const ss = db.sales.filter((s) => s.status === 'completed' && day(s.occurred_at) >= p_from && day(s.occurred_at) <= p_to); const ids = new Set(ss.map((s) => s.id));
  const items = new Map(); db.sale_items.filter((i) => ids.has(i.sale_id)).forEach((i) => { const c = items.get(i.name) || { name: i.name, qty: 0, net_sales: 0 }; c.qty += num(i.quantity); c.net_sales = money(c.net_sales + num(i.line_total) - num(i.tax_amount)); items.set(i.name, c); });
  const list = [...items.values()];
  const owed = overview().filter((s) => s.status === 'completed' && s.balance > 0);
  return { range: { from: p_from, to: p_to, timezone: 'Asia/Manila' }, current: totals(p_from, p_to), previous: totals(p_prev_from, p_prev_to), series, top_by_quantity: [...list].sort((a, b) => b.qty - a.qty), top_by_net_sales: [...list].sort((a, b) => b.net_sales - a.net_sales), by_category: [{ name: 'Drinks', net_sales: money(list.reduce((n, i) => n + i.net_sales, 0)) }].filter((x) => x.net_sales > 0), by_channel: [], by_payment_method: [], expenses_by_category: [], receivables: { count: owed.length, amount: money(owed.reduce((n, s) => n + s.balance, 0)) }, low_stock: db.products.filter((p) => p.track_stock && num(p.quantity) <= num(p.reorder_level)).map((p) => ({ id: p.id, name: p.name, quantity: p.quantity, reorder_level: p.reorder_level })) };
}

export function createClient() {
  if (window.__fakePersist) restore();
  window.__fake = { triggerRecovery: (email) => setSession({ user: [OWNER, CASH, WAIT, TRIAL].find((x) => x.email === email) }, 'PASSWORD_RECOVERY'), db, setUser: (email) => { fail().user = email; } };
  return {
    from: (n) => new Q(n),
    rpc: (name, args) => Promise.resolve().then(() => { if (netDown()) throw new TypeError('Failed to fetch'); try { const out = rpc(name, args); save(); if (name === 'create_sale' && fail().dropReply > 0) { fail().dropReply -= 1; throw new TypeError('Failed to fetch'); } return { data: out, error: null }; } catch (e) { if (e instanceof TypeError) throw e; return { data: null, error: { message: e.message } }; } }),
    auth: {
      getSession: async () => ({ data: { session } }), // (like the real one: works with no internet while the saved sign-in is still valid)
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      signInWithPassword: async ({ email, password }) => {
        const u = [OWNER, CASH, WAIT, TRIAL].find((x) => x.email === email);
        if (!u || password !== 'correct-horse') return { data: null, error: { message: 'Invalid login credentials' } };
        setSession({ user: u }); return { data: { session }, error: null };
      },
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => { setSession(null, 'SIGNED_OUT'); },
      updateUser: async ({ password }) => { if (!session) return { data: null, error: { message: 'Not authenticated' } }; window.__fake.passwords = { ...(window.__fake.passwords || {}), [session.user.email]: password }; return { data: { user: session.user }, error: null }; },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
    },
  };
}
