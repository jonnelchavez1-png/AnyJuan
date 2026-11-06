// THE DATA LAYER. Screens never talk to Supabase directly: they call these functions.
// That is what makes a future offline mode possible. To add it, you change what createSale() (and the other
// writes) do inside this one file - queue the request on the device and send it later - and no screen changes.
// The pieces that make that safe are already in place: sales and payments get their id on the device, the
// create_sale function accepts the same id twice without double counting, and `occurred_at` records when the
// sale really happened. See docs/OFFLINE-READINESS.md.

import { getClient } from './client.js';
import { offline, withTimeout } from './offline/manager.js';
import { classifyError } from '../lib/sync.js';

/** Turn a technical error into a sentence a shop owner can act on. */
export function friendlyError(error) {
  const raw = String(error?.message || error || 'Something went wrong.');
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return 'Cannot reach the server. Check the internet connection and try again.';
  }
  if (/rate limit/i.test(raw)) return 'Too many emails were sent just now. Please wait an hour, or ask the owner to create or fix your account.';
  if (/signups? (are |is )?(not allowed|disabled)/i.test(raw)) return 'New accounts are switched off. Ask the owner to create your account.';
  if (/jwt expired|invalid jwt|not authenticated/i.test(raw)) return 'Your sign-in has expired. Please sign in again.';
  if (/duplicate key value.*(name_key|sku_key|barcode_key)/i.test(raw)) return 'That name, SKU or barcode is already used.';
  if (/violates row-level security|permission denied/i.test(raw)) return 'You do not have permission to do that.';
  return raw.replace(/^error:\s*/i, '');
}

async function run(promise) {
  let res;
  try {
    res = await promise;
  } catch (e) {
    const msg = friendlyError(e);
    if (classifyError(new Error(msg)) === 'network') offline.noteNetwork(false);
    throw new Error(msg);
  }
  if (res?.error) throw new Error(friendlyError(res.error));
  offline.noteNetwork(true);
  return res?.data ?? null;
}

const sb = () => getClient();

/**
 * Read EVERY row of a query, one page at a time (the server hands out at most 1000 rows per request).
 * Totals on screen are added up from all of them, never from a cut-off list. `build()` must return a fresh,
 * ordered query each time. Stops at `max` rows and marks the array `.truncated` so the screen can say so.
 */
async function fetchAll(build, { page = 1000, max = 20000 } = {}) {
  const out = [];
  for (let from = 0; from < max; from += page) {
    const rows = (await run(build().range(from, from + page - 1))) || [];
    out.push(...rows);
    if (rows.length < page) return out;
  }
  out.truncated = true;
  return out;
}

export const repo = {
  // ---------- sign in ----------
  async getSession() {
    let data; let error;
    try { ({ data, error } = await sb().auth.getSession()); } catch (e) { error = e; }
    if (data?.session) return data.session;
    // No internet and the saved sign-in could not be renewed: keep the same person working with the saved copy of the shop.
    // (Sales are saved on the device; when the internet is back the real sign-in is renewed automatically.)
    const soft = offline.rememberedUser();
    if (soft && (offline.isOffline() || (error && classifyError(error) === 'network'))) return { user: { id: soft.id, email: soft.email }, soft: true };
    return null;
  },
  onAuthChange(callback) {
    const { data } = sb().auth.onAuthStateChange((event, session) => callback(session, event));
    return () => data?.subscription?.unsubscribe?.();
  },
  async signIn(email, password) {
    return run(sb().auth.signInWithPassword({ email: email.trim(), password }));
  },
  async signUp(email, password, name) {
    return run(sb().auth.signUp({ email: email.trim(), password, options: { data: { name: name.trim() } } }));
  },
  async signOut() {
    await offline.onSignOut();
    await sb().auth.signOut();
  },
  /** Change the signed-in person's own password (also used after clicking an email reset link). */
  async updatePassword(password) {
    return run(sb().auth.updateUser({ password }));
  },
  async resetPassword(email) {
    return run(sb().auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin }));
  },
  async getProfile(userId) {
    return offline.cachedRead(`profile:${userId}`, () => run(sb().from('profiles').select('*').eq('id', userId).maybeSingle()), { scope: 'private' });
  },

  // ---------- business and lists ----------
  async getBusiness() {
    return offline.cachedRead('business', () => run(sb().from('businesses').select('*').limit(1).maybeSingle()));
  },
  async saveBusiness(id, patch) {
    return run(sb().from('businesses').update(patch).eq('id', id).select().single());
  },
  async listLookup(table) {
    return offline.cachedRead(`lookup:${table}`, () => run(sb().from(table).select('*').order('sort_order').order('name')));
  },
  async saveLookup(table, row) {
    const { id, ...fields } = row;
    return id
      ? run(sb().from(table).update(fields).eq('id', id).select().single())
      : run(sb().from(table).insert(fields).select().single());
  },

  // ---------- products and customers ----------
  async listProducts() {
    // the shared stock minus anything sold on this device that has not been uploaded yet
    const rows = await offline.cachedRead('products', () => run(sb().from('products').select('*').order('name')));
    return offline.applyPendingStock(rows || []);
  },
  /** Stock is never written here: it changes only through createSale, voidSale and adjustStock. */
  async saveProduct(row) {
    const { id, quantity, ...fields } = row;
    if (id) return run(sb().from('products').update(fields).eq('id', id).select().single());
    return run(sb().from('products').insert({ ...fields, quantity: quantity ?? 0 }).select().single());
  },
  async adjustStock(productId, change, note) {
    return run(sb().rpc('adjust_stock', { p_product_id: productId, p_change: change, p_note: note || null }));
  },
  async listStockMovements(productId) {
    return run(sb().from('inventory_movements').select('*').eq('product_id', productId)
      .order('created_at', { ascending: false }).limit(50));
  },
  async listCustomers() {
    return offline.cachedRead('customers', () => run(sb().from('customers').select('*').order('name')));
  },
  async saveCustomer(row) {
    const { id, ...fields } = row;
    return id
      ? run(sb().from('customers').update(fields).eq('id', id).select().single())
      : run(sb().from('customers').insert(fields).select().single());
  },

  // ---------- sales ----------
  /**
   * sale: {id, channel_id?, customer_id?, discount_type?, discount_value?, note?, occurred_at?}
   * items: [{product_id, quantity}]   payments: [{id, method_id, amount}]
   * The server prices everything itself. Safe to call twice with the same sale.id.
   */
  async createSale(sale, items, payments, offlineInfo) {
    const send = () => run(sb().rpc('create_sale', { p_sale: sale, p_items: items, p_payments: payments }));
    if (!offlineInfo) return send();
    // `offlineInfo` (from the Sell screen) says what the customer was shown, so a sale can be kept on the device
    // when there is no internet. The same sale id is used later, so it can never be recorded twice.
    const keep = () => offline.queueSale({ sale, items: items.map((it) => ({ ...it, unit_price: offlineInfo.unitPrices[it.product_id] })), payments, info: offlineInfo });
    if (offline.isOffline()) return keep();
    try {
      return await withTimeout(send(), 12000, 'Cannot reach the server. The request timed out.');
    } catch (e) {
      const kind = classifyError(e);
      if (kind === 'network' || kind === 'auth') { if (kind === 'network') offline.noteNetwork(false); return keep(); }
      throw e;
    }
  },
  async voidSale(saleId, reason) {
    return run(sb().rpc('void_sale', { p_sale_id: saleId, p_reason: reason }));
  },
  async recordPayment(paymentId, saleId, methodId, amount, note) {
    return run(sb().rpc('record_payment', {
      p_payment_id: paymentId, p_sale_id: saleId, p_method_id: methodId, p_amount: amount, p_note: note || null,
    }));
  },
  async listSales({ fromInstant, toInstant } = {}) {
    return offline.cachedRead(`sales:${fromInstant || ''}:${toInstant || ''}`, () => fetchAll(() => {
      let q = sb().from('sales_overview').select('*').order('occurred_at', { ascending: false }).order('id');
      if (fromInstant) q = q.gte('occurred_at', fromInstant);
      if (toInstant) q = q.lt('occurred_at', toInstant);
      return q;
    }), { scope: 'private', timeout: 30000 });
  },
  /** Money back to a customer: some or all items of one sale. return: {id, sale_id, reason, refund_method_id?}; items: [{sale_item_id, quantity, restock}] */
  async createReturn(ret, items) {
    return run(sb().rpc('create_return', { p_return: ret, p_items: items }));
  },
  async listReturns({ fromInstant, toInstant } = {}) {
    return offline.cachedRead(`returns:${fromInstant || ''}:${toInstant || ''}`, () => fetchAll(() => {
      let q = sb().from('returns').select('*').order('occurred_at', { ascending: false }).order('id');
      if (fromInstant) q = q.gte('occurred_at', fromInstant);
      if (toInstant) q = q.lt('occurred_at', toInstant);
      return q;
    }), { scope: 'private', timeout: 30000 });
  },
  /** Every return of one sale, each with its lines. */
  async getSaleReturns(saleId) {
    const rets = await run(sb().from('returns').select('*').eq('sale_id', saleId).order('occurred_at'));
    return Promise.all((rets || []).map(async (r) => ({ ...r, items: await run(sb().from('return_items').select('*').eq('return_id', r.id)) })));
  },
  async getSaleDetail(saleId) {
    const [items, payments] = await Promise.all([
      run(sb().from('sale_items').select('*').eq('sale_id', saleId).order('line_no')),
      run(sb().from('payments').select('*').eq('sale_id', saleId).order('paid_at')),
    ]);
    return { items, payments };
  },

  // ---------- expenses ----------
  async listExpenses({ from, to } = {}) {
    return offline.cachedRead(`expenses:${from || ''}:${to || ''}`, () => fetchAll(() => {
      let q = sb().from('expenses').select('*').order('expense_date', { ascending: false }).order('created_at', { ascending: false }).order('id');
      if (from) q = q.gte('expense_date', from);
      if (to) q = q.lte('expense_date', to);
      return q;
    }), { scope: 'private', timeout: 30000 });
  },
  async saveExpense(row, userId) {
    const { id, ...fields } = row;
    return id
      ? run(sb().from('expenses').update(fields).eq('id', id).select().single())
      : run(sb().from('expenses').insert({ ...fields, created_by: userId }).select().single());
  },
  async voidExpense(id, userId) {
    return run(sb().from('expenses').update({ voided_at: new Date().toISOString(), voided_by: userId }).eq('id', id).select().single());
  },

  // ---------- reports ----------
  async getDashboard(range, previous) {
    return offline.cachedRead(`dashboard:${range.from}:${range.to}:${previous.from}:${previous.to}`, () => run(sb().rpc('get_dashboard', {
      p_from: range.from, p_to: range.to, p_prev_from: previous.from, p_prev_to: previous.to,
    })), { scope: 'private', timeout: 30000 });
  },

  // ---------- cash drawer shifts (separate from selling: nothing here changes a sale) ----------
  /** The open shift with its live figures, or null when none is open. */
  async currentShift() {
    return run(sb().rpc('current_shift'));
  },
  async getShift(id) {
    return run(sb().rpc('get_shift', { p_shift_id: id }));
  },
  async listShifts(limit = 60) {
    return run(sb().from('shifts').select('*').order('opened_at', { ascending: false }).limit(limit));
  },
  /** shift: {id, opening_cash, note}. Sending the same id twice is safe. */
  async openShift(shift) {
    return run(sb().rpc('open_shift', { p_shift: shift }));
  },
  /** movement: {id, kind: 'in' | 'out', amount, reason} */
  async addCashMovement(movement) {
    return run(sb().rpc('add_cash_movement', { p_move: movement }));
  },
  async closeShift(shiftId, counted, note) {
    return run(sb().rpc('close_shift', { p_shift_id: shiftId, p_counted: counted, p_note: note || null }));
  },

  async getTaxReport(range) {
    return offline.cachedRead(`tax:${range.from}:${range.to}`, () => run(sb().rpc('get_tax_report', { p_from: range.from, p_to: range.to })), { scope: 'private', timeout: 30000 });
  },

  // ---------- offline sales that need a person to look at them ----------
  async getSaleReviews(includeResolved = false) {
    return run(sb().rpc('get_sale_reviews', { p_include_resolved: includeResolved }));
  },
  async resolveSaleReview(id, note) {
    return run(sb().rpc('resolve_sale_review', { p_id: id, p_note: note || null }));
  },

  // ---------- team ----------
  async listProfiles() {
    return run(sb().from('profiles').select('*').order('created_at'));
  },
  async saveProfile(id, patch) {
    return run(sb().from('profiles').update(patch).eq('id', id).select().single());
  },
};
