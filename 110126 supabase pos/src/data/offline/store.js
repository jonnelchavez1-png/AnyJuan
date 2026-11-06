// A tiny async key-value store on IndexedDB (the browser's built-in database; it survives closing the browser
// and restarting the tablet). Three shelves: queue (sales waiting), cache (last copy of what the screens read), meta (small facts).
// If the browser does not allow IndexedDB (some private windows) we fall back to memory and say so: offline selling is then OFF.

const SHELVES = ['queue', 'cache', 'meta'];

export function memoryStore() {
  const data = Object.fromEntries(SHELVES.map((s) => [s, new Map()]));
  return {
    kind: 'memory',
    async getAll(s) { return [...data[s].values()].map((v) => structuredClone(v.value)); },
    async get(s, k) { const v = data[s].get(k); return v ? structuredClone(v.value) : undefined; },
    async put(s, value, key) { data[s].set(key ?? value.id ?? value.key, { value: structuredClone(value) }); },
    async del(s, k) { data[s].delete(k); },
  };
}

function wrap(db) {
  const tx = (shelf, mode, fn) => new Promise((resolve, reject) => {
    const t = db.transaction(shelf, mode);
    const req = fn(t.objectStore(shelf));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error || new Error('Could not save on this device.'));
    t.onabort = () => reject(t.error || new Error('Could not save on this device (storage may be full).'));
  });
  return {
    kind: 'indexeddb',
    getAll: (s) => tx(s, 'readonly', (o) => o.getAll()).then((r) => r || []),
    get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
    put: (s, value, key) => tx(s, 'readwrite', (o) => (s === 'meta' ? o.put(value, key) : o.put(value))),
    del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
  };
}

export async function openStore(name = 'pos-offline') {
  if (typeof indexedDB === 'undefined') return memoryStore();
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('queue', { keyPath: 'id' });
        d.createObjectStore('cache', { keyPath: 'key' });
        d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
    return wrap(db);
  } catch { return memoryStore(); }
}
