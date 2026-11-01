// A tiny in-memory stand-in for Supabase, used ONLY by the browser tests (the real package cannot be
// installed in the test sandbox). It implements just the calls the app makes. The sale maths reuses the
// app's own calculator, so these tests check the screens and the flow; the SQL itself is checked by
// supabase/verify.sql on a real database.
import { computeSale } from '../src/lib/tax.js';

const uid = () => crypto.randomUUID();
const OWNER = { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com' };
const CASH = { id: '00000000-0000-4000-8000-000000000003', email: 'cashier@example.com' };
const WAIT = { id: '00000000-0000-4000-8000-000000000002', email: 'new@example.com' };

const cat = (name, n) => ({ id: uid(), name, sort_order: n, active: true });
const db = {
  businesses: [{ id: uid(), name: 'Test Mart', currency: 'PHP', locale: 'en-PH', timezone: 'Asia/Manila', week_starts_on: 1, tax_enabled: false, tax_name: 'Tax', tax_rate: 0, tax_mode: 'inclusive', receipt_header: 'Branch 1', receipt_footer: 'Thank you!' }],
  profiles: [
    { id: OWNER.id, name: 'Olivia Owner', email: OWNER.email, role: 'owner', active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: CASH.id, name: 'Carl Cashier', email: CASH.email, role: 'cashier', active: true, created_at: '2026-01-15T00:00:00Z' },
    { id: WAIT.id, name: 'Nina New', email: WAIT.email, role: 'cashier', active: false, created_at: '2026-02-01T00:00:00Z' },
  ],
  categories: [cat('Drinks', 1), cat('Snacks', 2)],
  expense_categories: [cat('Rent', 1), cat('Supplies', 2)],
  sales_channels: [cat('In-store', 1)],
  payment_methods: [cat('Cash', 1), cat('E-wallet', 2)],
  products: [], customers: [], sales: [], sale_items: [], payments: [], expenses: [], inventory_movements: [],
};
const P = (name, price, cost, qty, extra = {}) => ({ id: uid(), name, sku: null, barcode: null, category_id: db.categories[0].id, price, cost_price: cost, track_stock: true, quantity: qty, reorder_level: 5, tax_exempt: false, active: true, ...extra });
db.products.push(P('Cola 290ml', 100, 40, 10), P('Chips 60g', 50, 20, 5, { tax_exempt: true, barcode: '4800' }), P('Rice 1kg', 55, 40, 3, { reorder_level: 5 }));
db.customers.push({ id: uid(), name: 'Aling Rosa', phone: null });

let session = null; const listeners = new Set();
const fail = () => (window.__fakeFail ||= {});
const setSession = (s) => { session = s; listeners.forEach((l) => l('X', s)); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const num = (v) => Number(v);
const r2 = (v) => Math.round(v * 100) / 100;

function overview() {
  return db.sales.map((s) => { const paid = db.payments.filter((p) => p.sale_id === s.id).reduce((n, p) => n + num(p.amount), 0); return { ...s, paid: r2(paid), balance: r2(s.total - paid) }; });
}
function table(name) { return name === 'sales_overview' ? overview() : db[name]; }

class Q {
  constructor(name) { this.name = name; this.f = []; this.ord = []; this.lim = null; this.op = 'select'; this.payload = null; this.one = null; }
  select() { return this; }
  order(c, o = {}) { this.ord.push([c, o.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
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
      }
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
    const lines = a.p_items.map((i) => { const p = db.products.find((x) => x.id === i.product_id); if (!p) throw new Error('One of the products is missing or switched off.'); if (p.track_stock && num(p.quantity) < i.quantity) throw new Error(`Not enough stock for ${p.name}`); return { p, qty: i.quantity }; });
    const calc = computeSale({
      lines: lines.map(({ p, qty }) => ({ qty, priceCents: Math.round(p.price * 100), costCents: Math.round(p.cost_price * 100), taxExempt: p.tax_exempt })),
      discount: sale.discount_type ? { type: sale.discount_type, value: sale.discount_type === 'amount' ? Math.round(sale.discount_value * 100) : sale.discount_value } : null,
      tax: { enabled: b.tax_enabled, rate: num(b.tax_rate), mode: b.tax_mode },
    });
    const id = sale.id; const paid = (a.p_payments || []).reduce((n, p) => n + p.amount, 0);
    if (paid > calc.total / 100 + 1e-9) throw new Error('Payments are more than the total.');
    const row = { id, invoice_number: `INV-${String(db.sales.length + 1).padStart(6, '0')}`, channel_id: sale.channel_id, customer_id: sale.customer_id, cashier_id: OWNER.id, status: 'completed', subtotal: calc.subtotal / 100, discount_amount: calc.discount / 100, tax_mode: calc.mode, tax_name: calc.mode === 'none' ? null : b.tax_name, tax_rate: calc.mode === 'none' ? 0 : b.tax_rate, tax_amount: calc.tax / 100, total: calc.total / 100, net_sales: calc.net / 100, cogs: calc.cogs / 100, note: sale.note, occurred_at: sale.occurred_at || new Date().toISOString(), created_at: new Date().toISOString() };
    db.sales.push(row);
    lines.forEach(({ p, qty }, i) => { db.sale_items.push({ id: uid(), sale_id: id, line_no: i + 1, product_id: p.id, name: p.name, quantity: qty, unit_price: p.price, unit_cost: p.cost_price, line_gross: calc.lines[i].gross / 100, discount_amount: calc.lines[i].discount / 100, tax_amount: calc.lines[i].tax / 100, line_total: calc.lines[i].total / 100 }); if (p.track_stock) { p.quantity -= qty; db.inventory_movements.push({ id: uid(), product_id: p.id, type: 'sale', quantity_change: -qty, quantity_after: p.quantity, created_at: row.created_at }); } });
    (a.p_payments || []).forEach((p) => db.payments.push({ id: p.id || uid(), sale_id: id, method_id: p.method_id, amount: p.amount, paid_at: row.occurred_at }));
    return { ok: true, duplicate: false, sale_id: id, invoice_number: row.invoice_number, total: row.total, tax_amount: row.tax_amount };
  }
  if (name === 'void_sale') {
    const s = db.sales.find((x) => x.id === a.p_sale_id); if (!s) throw new Error('Sale not found.'); if (!a.p_reason?.trim()) throw new Error('Please give a reason.');
    if (s.status === 'voided') return { ok: true, duplicate: true };
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
  if (name === 'adjust_stock') {
    const p = db.products.find((x) => x.id === a.p_product_id); if (num(p.quantity) + a.p_change < 0) throw new Error('Stock cannot go below zero.');
    p.quantity = r2(num(p.quantity) + a.p_change * 1); db.inventory_movements.push({ id: uid(), product_id: p.id, type: 'adjustment', quantity_change: a.p_change, quantity_after: p.quantity, note: a.p_note, created_at: new Date().toISOString() });
    return { ok: true, quantity: p.quantity };
  }
  if (name === 'get_dashboard') return dashboard(a);
  throw new Error(`unknown rpc ${name}`);
}

function dashboard({ p_from, p_to, p_prev_from, p_prev_to }) {
  const day = (iso) => new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const totals = (f, t) => {
    const ss = db.sales.filter((s) => s.status === 'completed' && day(s.occurred_at) >= f && day(s.occurred_at) <= t);
    const ids = new Set(ss.map((s) => s.id)); const sum = (k) => money(ss.reduce((n, s) => n + num(s[k]), 0));
    const collected = money(db.payments.filter((p) => ids.has(p.sale_id)).reduce((n, p) => n + num(p.amount), 0));
    const exp = money(db.expenses.filter((e) => !e.voided_at && e.expense_date >= f && e.expense_date <= t).reduce((n, e) => n + num(e.amount), 0));
    const units = db.sale_items.filter((i) => ids.has(i.sale_id)).reduce((n, i) => n + num(i.quantity), 0);
    return { orders: ss.length, units, gross_sales: sum('subtotal'), discounts: sum('discount_amount'), tax_collected: sum('tax_amount'), billed: sum('total'), net_sales: sum('net_sales'), cogs: sum('cogs'), gross_profit: money(sum('net_sales') - sum('cogs')), collected, expenses: exp, net_profit: money(sum('net_sales') - sum('cogs') - exp) };
  };
  const series = []; for (let d = new Date(p_from + 'T00:00:00Z'); d <= new Date(p_to + 'T00:00:00Z'); d = new Date(d.getTime() + 864e5)) { const k = d.toISOString().slice(0, 10); const t = totals(k, k); series.push({ date: k, orders: t.orders, net_sales: t.net_sales, gross_profit: t.gross_profit, expenses: t.expenses }); }
  const ss = db.sales.filter((s) => s.status === 'completed' && day(s.occurred_at) >= p_from && day(s.occurred_at) <= p_to); const ids = new Set(ss.map((s) => s.id));
  const items = new Map(); db.sale_items.filter((i) => ids.has(i.sale_id)).forEach((i) => { const c = items.get(i.name) || { name: i.name, qty: 0, net_sales: 0 }; c.qty += num(i.quantity); c.net_sales = money(c.net_sales + num(i.line_total) - num(i.tax_amount)); items.set(i.name, c); });
  const list = [...items.values()];
  const owed = overview().filter((s) => s.status === 'completed' && s.balance > 0);
  return { range: { from: p_from, to: p_to, timezone: 'Asia/Manila' }, current: totals(p_from, p_to), previous: totals(p_prev_from, p_prev_to), series, top_by_quantity: [...list].sort((a, b) => b.qty - a.qty), top_by_net_sales: [...list].sort((a, b) => b.net_sales - a.net_sales), by_category: [{ name: 'Drinks', net_sales: money(list.reduce((n, i) => n + i.net_sales, 0)) }].filter((x) => x.net_sales > 0), by_channel: [], by_payment_method: [], expenses_by_category: [], receivables: { count: owed.length, amount: money(owed.reduce((n, s) => n + s.balance, 0)) }, low_stock: db.products.filter((p) => p.track_stock && num(p.quantity) <= num(p.reorder_level)).map((p) => ({ id: p.id, name: p.name, quantity: p.quantity, reorder_level: p.reorder_level })) };
}

export function createClient() {
  window.__fake = { db, setUser: (email) => { fail().user = email; } };
  return {
    from: (n) => new Q(n),
    rpc: (name, args) => Promise.resolve().then(() => { try { return { data: rpc(name, args), error: null }; } catch (e) { if (e instanceof TypeError) throw e; return { data: null, error: { message: e.message } }; } }),
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
      signInWithPassword: async ({ email, password }) => {
        const u = [OWNER, CASH, WAIT].find((x) => x.email === email);
        if (!u || password !== 'correct-horse') return { data: null, error: { message: 'Invalid login credentials' } };
        setSession({ user: u }); return { data: { session }, error: null };
      },
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => { setSession(null); },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
    },
  };
}
