// The OUTBOX: sales made while the internet is down wait here, on the device, until they are uploaded.
// Pure logic on top of a tiny storage object (IndexedDB in the app, a Map in the tests), so it can be tested in Node.
// States: waiting (will upload by itself) -> done (uploaded, kept 14 days so the real invoice number can be looked up)
//         or failed (the server said no for a business reason: a person must look at it, nothing is thrown away).

const DAY = 86400000;
export const KEEP_DONE_DAYS = 14;

/** Quantities are kept as whole thousandths so adding them up never drifts. */
const milli = (q) => Math.round(Number(q) * 1000);

export function tempNumber(saleId) {
  return `OFFLINE-${String(saleId).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

export function createOutbox(store, { now = () => Date.now() } = {}) {
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch { /* a screen failing must not stop saving */ } });

  const all = async () => (await store.getAll('queue')).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const patch = async (id, fields) => {
    const e = await store.get('queue', id);
    if (!e) return null;
    const next = { ...e, ...fields };
    await store.put('queue', next);
    emit();
    return next;
  };

  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    all,
    /** Save a sale. Saving the same sale id twice keeps the first one (pressing Charge twice cannot make two sales). */
    async add(entry) {
      const existing = await store.get('queue', entry.id);
      if (existing) return existing;
      const e = { attempts: 0, message: '', ...entry, status: 'waiting', createdAt: now() };
      await store.put('queue', e);
      emit();
      return e;
    },
    async markDone(id, result) { return patch(id, { status: 'done', invoiceNumber: result?.invoice_number || '', flagged: result?.flagged || 0, doneAt: now(), message: '' }); },
    async markFailed(id, message) { return patch(id, { status: 'failed', message: String(message || 'The server did not accept this sale.') }); },
    async noteAttempt(id, message) { const e = await store.get('queue', id); return e ? patch(id, { attempts: (e.attempts || 0) + 1, message: String(message || '') }) : null; },
    async retry(id) { return patch(id, { status: 'waiting', message: '' }); },
    async reassign(id, userId, userName, note) { const e = await store.get('queue', id); return e ? patch(id, { userId, userName, sale: { ...e.sale, note: [note, e.sale.note].filter(Boolean).join(' · ') } }) : null; },
    async remove(id) { await store.del('queue', id); emit(); },
    /** Forget uploaded sales older than 14 days. Never touches waiting or failed ones. */
    async prune() {
      for (const e of await all()) if (e.status === 'done' && now() - (e.doneAt || 0) > KEEP_DONE_DAYS * DAY) await store.del('queue', e.id);
      emit();
    },
    /** Numbers for the status bar. `userId` = who is signed in: only their sales upload automatically. */
    async summary(userId) {
      const list = await all();
      const open = list.filter((e) => e.status === 'waiting');
      const mine = open.filter((e) => e.userId === userId);
      const failed = list.filter((e) => e.status === 'failed');
      return {
        waiting: mine.length, waitingCents: mine.reduce((n, e) => n + (e.totalCents || 0), 0),
        others: open.length - mine.length, failed: failed.length,
        failedCents: failed.reduce((n, e) => n + (e.totalCents || 0), 0), done: list.filter((e) => e.status === 'done').length,
      };
    },
    /** Goods already sold on this device but not yet taken off the shared stock: used to show the stock that is really left. */
    async reservedMilli() {
      const map = new Map();
      for (const e of await all()) {
        if (e.status === 'done') continue;
        for (const it of e.items) map.set(it.product_id, (map.get(it.product_id) || 0) + milli(it.quantity));
      }
      return map;
    },
  };
}

/** Show the stock that is really left: the server's number minus sales still waiting on this device (never below zero). */
export function applyReserved(products, reserved) {
  if (!reserved || !reserved.size) return products;
  return products.map((p) => {
    const r = reserved.get(p.id);
    if (!r || !p.track_stock) return p;
    return { ...p, quantity: Math.max(0, Math.round(Number(p.quantity) * 1000) - r) / 1000 };
  });
}
