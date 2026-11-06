// OFFLINE MANAGER: one object per browser tab that knows whether we are online, keeps the outbox, uploads waiting sales,
// keeps a last-known copy of what the screens read, and registers the service worker (which lets the app OPEN with no internet).
// Nothing here changes how a sale is worked out: the server still does that when the sale is uploaded.

import { getClient } from '../client.js';
import { applyReserved, createOutbox, tempNumber } from '../../lib/outbox.js';
import { classifyError, createSync } from '../../lib/sync.js';
import { openStore } from './store.js';

const MIRROR_KEY = 'pos.queue.mirror';
const LAST_USER_KEY = 'pos.lastUser';
const BIG = 5000; // do not keep a copy of lists longer than this

const ls = {
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage blocked: fine */ } },
  del(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const withTimeout = (promise, ms, message = 'The request timed out.') => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(message)), ms);
  Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

let state = Object.freeze({
  ready: false, storage: 'none', online: true, syncing: false, waiting: 0, waitingCents: 0, others: 0, failed: 0, failedCents: 0,
  lastSyncAt: null, lastSynced: 0, needsSignIn: false, updateReady: false, staleAt: null, user: null,
});
const listeners = new Set();
const setState = (patch) => { state = Object.freeze({ ...state, ...patch }); listeners.forEach((f) => f()); };

let store = null; let outbox = null; let sync = null; let started = false; let skewMs = 0; let timer = null;
const syncedHandlers = new Set();

const isOffline = () => (typeof navigator !== 'undefined' && navigator.onLine === false) || !state.online;

async function refreshCounts() {
  if (!outbox) return;
  const s = await outbox.summary(state.user?.id);
  setState({ waiting: s.waiting, waitingCents: s.waitingCents, others: s.others, failed: s.failed, failedCents: s.failedCents });
  // a second copy of anything not yet uploaded, in a different place from IndexedDB, in case that one is ever wiped
  try {
    const open = (await outbox.all()).filter((e) => e.status !== 'done');
    if (open.length) ls.set(MIRROR_KEY, JSON.stringify(open)); else ls.del(MIRROR_KEY);
  } catch { /* ignore */ }
}

let recheck = null;
function noteNetwork(ok) {
  if (ok === state.online) return;
  setState({ online: ok, ...(ok ? { staleAt: null } : {}) });
  if (ok) { runSync(); return; }
  // a single failed request is often a blip: look again soon instead of waiting for the slow timer
  clearTimeout(recheck);
  recheck = setTimeout(() => { if (!state.online) probe(); }, 3000);
}

async function rpcCreateSale(entry) {
  const { data, error } = await getClient().rpc('create_sale', { p_sale: entry.sale, p_items: entry.items, p_payments: entry.payments });
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function runSync() {
  if (!sync || state.syncing || !state.user) return null;
  setState({ syncing: true });
  let result = null;
  try {
    const run = async () => sync.run();
    // only one tab at a time uploads (two tabs would just do the same work twice; the server would ignore the repeat)
    result = (typeof navigator !== 'undefined' && navigator.locks)
      ? await navigator.locks.request('pos-sync', { ifAvailable: true }, async (lock) => (lock ? run() : { skipped: true, sent: 0 }))
      : await run();
    if (result?.stopped === 'network') setState({ online: false });
    else if (result && !result.skipped && result.stopped !== 'signed-out') setState({ online: true });
    setState({ needsSignIn: result?.stopped === 'auth' });
    if (result?.sent) { setState({ lastSyncAt: Date.now(), lastSynced: result.sent }); syncedHandlers.forEach((f) => { try { f(result); } catch { /* ignore */ } }); }
    await outbox.prune();
  } catch { /* the next run will try again */ } finally {
    setState({ syncing: false });
    await refreshCounts();
  }
  return result;
}

/** Ask the server for its time: proves we are really online, and tells us how far this device's clock is off. */
async function probe() {
  if (!state.ready) return;
  const t0 = Date.now();
  try {
    const { data, error } = await withTimeout(getClient().rpc('server_time'), 6000);
    if (error) throw new Error(error.message);
    const t1 = Date.now();
    const server = Date.parse(data);
    if (Number.isFinite(server)) { skewMs = Math.round(server - (t0 + t1) / 2); await store.put('meta', skewMs, 'skewMs'); }
    noteNetwork(true);
  } catch (e) {
    if (classifyError(e) === 'network') noteNetwork(false);
    else noteNetwork(true); // the server answered (even with an error): we are online
  }
  if (state.waiting > 0 && state.online) runSync();
}

export const offline = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  getState: () => state,
  isOffline,
  onSynced(fn) { syncedHandlers.add(fn); return () => syncedHandlers.delete(fn); },
  get skewMs() { return skewMs; },

  async init() {
    if (started) return;
    started = true;
    store = await openStore();
    outbox = createOutbox(store);
    sync = createSync({ outbox, getUserId: () => state.user?.id || null, send: rpcCreateSale });
    skewMs = Number(await store.get('meta', 'skewMs')) || 0;
    // restore from the second copy if the main one lost sales (never overwrites a sale that is still in the main copy)
    try {
      const mirror = JSON.parse(ls.get(MIRROR_KEY) || '[]');
      for (const e of mirror) if (!(await store.get('queue', e.id))) await store.put('queue', e);
    } catch { /* unreadable copy: ignore */ }
    outbox.subscribe(refreshCounts);
    setState({ ready: true, storage: store.kind });
    await refreshCounts();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { setState({ online: true }); probe(); });
      window.addEventListener('offline', () => setState({ online: false }));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probe(); });
      timer = setInterval(() => { if (document.visibilityState !== 'hidden' && (!state.online || state.waiting > 0 || state.needsSignIn)) probe(); }, 15000);
      try { navigator.storage?.persist?.(); } catch { /* ask the browser not to throw our data away: best effort */ }
      registerWorker();
      if (navigator.onLine === false) setState({ online: false }); else probe();
    }
  },

  /** Tell the manager who is signed in (their waiting sales upload automatically). */
  setUser(user) {
    const same = state.user?.id === user?.id;
    setState({ user: user ? { id: user.id, name: user.name || user.email || '', role: user.role || '' } : null });
    if (user) ls.set(LAST_USER_KEY, JSON.stringify({ id: user.id, email: user.email || '' }));
    if (!same) refreshCounts().then(() => { if (state.online) runSync(); });
  },
  rememberedUser() { try { return JSON.parse(ls.get(LAST_USER_KEY) || 'null'); } catch { return null; } },
  /** Signing out wipes the saved reports (they hold money figures) but NEVER the sales still waiting to upload. */
  async onSignOut() {
    ls.del(LAST_USER_KEY);
    setState({ user: null });
    if (!store) return;
    for (const row of await store.getAll('cache')) if (row.key.includes('|')) await store.del('cache', row.key);
  },

  noteNetwork,
  probe,
  syncNow: runSync,

  /** Save a sale on this device. `info` = what the Sell screen worked out (prices and tax as the customer saw them). */
  async queueSale({ sale, items, payments, info }) {
    if (!outbox || state.storage !== 'indexeddb') {
      throw new Error('This browser cannot keep sales on the device, so selling offline is switched off. Reconnect to the internet, or open the app in a normal (not private) window.');
    }
    const user = state.user;
    if (!user) throw new Error('Sign in first.');
    const when = Date.parse(sale.occurred_at);
    const corrected = Number.isFinite(when) && Math.abs(skewMs) < 7 * 86400000 ? new Date(when + skewMs).toISOString() : sale.occurred_at;
    const cleanItems = items.map((it) => ({ product_id: it.product_id, quantity: it.quantity, unit_price: it.unit_price }));
    const payload = { ...sale, offline: true, occurred_at: corrected, tax_mode: info.taxMode, tax_rate: info.taxRate };
    const entry = await outbox.add({
      id: sale.id, userId: user.id, userName: user.name, sale: payload, items: cleanItems, payments,
      totalCents: info.totalCents, customerName: info.customerName || '', lines: info.lines || [], tempNumber: tempNumber(sale.id),
      occurredAt: corrected, paymentLabel: info.paymentLabel || '',
    });
    await refreshCounts();
    if (state.online) runSync(); // (only reached when online-but-failing: the next probe decides)
    return { ok: true, offline: true, duplicate: false, sale_id: entry.id, invoice_number: entry.tempNumber, total: info.totalCents / 100 };
  },

  /** Last known copy of something the screens read: used when the internet is down or slow. */
  async cachedRead(key, fn, { scope = 'shared', timeout = 10000 } = {}) {
    const k = scope === 'private' ? `${state.user?.id || 'anon'}|${key}` : key;
    let cached;
    try { cached = store ? await store.get('cache', k) : undefined; } catch { cached = undefined; }
    if (cached && isOffline()) { setState({ staleAt: Math.min(state.staleAt || Infinity, cached.at) }); return cached.value; }
    try {
      const value = await withTimeout(fn(), timeout, 'Cannot reach the server. The request timed out.');
      noteNetwork(true);
      if (store && !(Array.isArray(value) && value.length > BIG)) { try { await store.put('cache', { key: k, value, at: Date.now() }); } catch { /* storage full: skip */ } }
      return value;
    } catch (e) {
      if (classifyError(e) === 'network') {
        noteNetwork(false);
        if (cached) { setState({ staleAt: Math.min(state.staleAt || Infinity, cached.at) }); return cached.value; }
      }
      throw e;
    }
  },
  /** Take the sales still waiting on this device off the stock figures shown (display only). */
  async applyPendingStock(products) { return outbox ? applyReserved(products, await outbox.reservedMilli()) : products; },

  // ---- for the "Offline and sync" screen ----
  async entries() { return outbox ? outbox.all() : []; },
  retry: async (id) => { await outbox.retry(id); runSync(); },
  async takeOver(id, note) { const u = state.user; await outbox.reassign(id, u.id, u.name, note); runSync(); },
  async remove(id) { await outbox.remove(id); },
  async exportBackup() { return { exportedAt: new Date().toISOString(), user: state.user, entries: outbox ? await outbox.all() : [] }; },
  async markSeenSignIn() { setState({ needsSignIn: false }); },
  reloadForUpdate() { window.location.reload(); },
};

function registerWorker() {
  if (!('serviceWorker' in navigator) || !/^https:|^http:\/\/(localhost|127\.0\.0\.1)/.test(window.location.href)) return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* the app still works online without it */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) setState({ updateReady: true }); });
}
