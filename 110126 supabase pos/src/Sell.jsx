import { useMemo, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { computeSale } from '../lib/tax.js';
import { fromCents, fromMilli, formatQuantity, parseAmount, parseQuantity, toCents } from '../lib/money.js';
import { newId } from '../lib/ids.js';
import { useApp } from '../ui/context.js';
import { useOffline } from '../ui/useOffline.js';
import { offline } from '../data/offline/manager.js';
import { Dialog, Field, PageHead } from '../ui/kit.jsx';
import { ReceiptDialog } from '../ui/Receipt.jsx';

export default function Sell() {
  const { business, products, categories, customers, channels, methods, money, toast, reload, can } = useApp();
  const net = useOffline();
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [cart, setCart] = useState([]); // [{productId, qty (milli), text}]
  const [discType, setDiscType] = useState('percent');
  const [discText, setDiscText] = useState('');
  const [customerId, setCustomerId] = useState('');
  // the channel called In-store (or In store) is chosen for every new sale; staff can still pick another one
  const defaultChannelId = channels.find((c) => c.active && /^in[\s-]*store$/i.test(String(c.name).trim()))?.id || '';
  const [channelId, setChannelId] = useState(defaultChannelId);
  const [payMode, setPayMode] = useState('full'); // full | partial | later
  const [methodId, setMethodId] = useState(methods.find((m) => m.active)?.id || '');
  const [partialText, setPartialText] = useState('');
  const [received, setReceived] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [newCustomer, setNewCustomer] = useState(false);
  // One id per sale attempt: if the network drops and the cashier presses Charge again, the SAME id is sent,
  // so the sale cannot be recorded twice.
  const attempt = useRef({ saleId: newId(), paymentId: newId() });

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const active = useMemo(() => products.filter((p) => p.active), [products]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return active.filter((p) => (cat === 'all' || p.category_id === cat)
      && (!q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode || '') === search.trim()));
  }, [active, search, cat]);

  const stockLeft = (p) => (p.track_stock ? Math.round(Number(p.quantity) * 1000) : Infinity);
  const inCart = (id) => cart.find((l) => l.productId === id)?.qty || 0;

  const add = (p, amountMilli = 1000) => {
    setError('');
    if (inCart(p.id) + amountMilli > stockLeft(p)) { toast(`Only ${formatQuantity(stockLeft(p))} of ${p.name} in stock`, 'bad'); return; }
    setCart((c) => c.some((l) => l.productId === p.id)
      ? c.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + amountMilli, text: formatQuantity(l.qty + amountMilli) } : l))
      : [...c, { productId: p.id, qty: amountMilli, text: formatQuantity(amountMilli) }]);
  };
  const setQtyText = (id, text) => setCart((c) => c.map((l) => {
    if (l.productId !== id) return l;
    const q = parseQuantity(text);
    return { ...l, text, qty: q != null && q > 0 ? q : l.qty, invalid: q == null || q <= 0 };
  }));
  const remove = (id) => setCart((c) => c.filter((l) => l.productId !== id));

  const onSearchKey = (e) => {
    if (e.key !== 'Enter') return;
    const q = search.trim().toLowerCase();
    if (!q) return;
    const exact = active.find((p) => (p.barcode && p.barcode === search.trim()) || (p.sku && p.sku.toLowerCase() === q));
    if (exact) { add(exact); setSearch(''); } else if (shown.length === 1) { add(shown[0]); setSearch(''); }
  };

  const discount = useMemo(() => {
    if (!discText.trim()) return null;
    if (discType === 'percent') { const v = Number(discText); return Number.isFinite(v) && v > 0 ? { type: 'percent', value: Math.min(v, 100) } : null; }
    const c = parseAmount(discText);
    return c ? { type: 'amount', value: c } : null;
  }, [discText, discType]);

  const calc = useMemo(() => computeSale({
    lines: cart.map((l) => { const p = byId.get(l.productId); return { qty: fromMilli(l.qty), priceCents: toCents(p.price), costCents: toCents(p.cost_price), taxExempt: p.tax_exempt }; }),
    discount,
    tax: { enabled: business.tax_enabled, rate: Number(business.tax_rate), mode: business.tax_mode },
  }), [cart, byId, discount, business]);

  const partial = parseAmount(partialText);
  const payNow = payMode === 'full' ? calc.total : payMode === 'later' ? 0 : (partial ?? 0);
  const balance = calc.total - payNow;
  const customer = customers.find((c) => c.id === customerId);
  // The "cash received / change" box appears when the chosen payment method is a cash one (its name contains "cash").
  const methodName = methods.find((m) => m.id === methodId)?.name || '';
  const showCash = payNow > 0 && /cash/i.test(methodName);
  const receivedCents = received.trim() ? parseAmount(received) : null;
  const changeDue = showCash && receivedCents != null && receivedCents >= payNow ? receivedCents - payNow : null;
  const quick = showCash && payNow > 0
    ? [...new Set([payNow, ...[5000, 10000, 50000, 100000].map((step) => Math.ceil(payNow / step) * step)])].filter((v) => v >= payNow).slice(0, 4)
    : [];
  const cartInvalid = cart.some((l) => l.invalid);

  const charge = async () => {
    setError('');
    if (!cart.length) return;
    if (cartInvalid) { setError('Fix the quantities that are marked in red.'); return; }
    if (discText.trim() && !discount) { setError('The discount is not a valid number.'); return; }
    if (payMode === 'partial' && (partial == null || partial <= 0 || partial >= calc.total)) { setError('Part payment must be more than 0 and less than the total.'); return; }
    if (payNow > 0 && !methodId) { setError('Choose how the customer paid.'); return; }
    if (showCash && received.trim()) {
      if (receivedCents == null) { setError('The cash received is not a valid amount.'); return; }
      if (receivedCents < payNow) { setError(`Cash received (${money(receivedCents)}) is less than the amount to pay now (${money(payNow)}). Choose Part payment or enter more.`); return; }
    }
    // no internet: keep the cashier's discount limit at the till too (the server would only be able to flag it afterwards)
    if (offline.isOffline() && calc.discount > 0 && !can('voidSale') && calc.discount > Math.round(calc.subtotal * Number(business.cashier_max_discount_pct || 0) / 100)) {
      setError(`This discount needs a manager (cashiers may give up to ${Number(business.cashier_max_discount_pct || 0)} percent).`); return;
    }
    if (balance > 0 && !customerId) { setError('Choose a customer for a sale that is not fully paid, so you know who owes the balance.'); return; }
    setBusy(true);
    const { saleId, paymentId } = attempt.current;
    try {
      const sale = { id: saleId, channel_id: channelId || null, customer_id: customerId || null, note: note.trim() || null, occurred_at: new Date().toISOString() };
      if (discount) { sale.discount_type = discount.type; sale.discount_value = discount.type === 'amount' ? fromCents(discount.value) : discount.value; }
      const items = cart.map((l) => ({ product_id: l.productId, quantity: fromMilli(l.qty) }));
      const payments = payNow > 0 ? [{ id: paymentId, method_id: methodId, amount: fromCents(payNow) }] : [];
      const offlineInfo = {
        unitPrices: Object.fromEntries(cart.map((l) => [l.productId, Number(byId.get(l.productId).price)])),
        taxMode: calc.mode, taxRate: calc.mode === 'none' ? 0 : Number(business.tax_rate), totalCents: calc.total,
        customerName: customer?.name || '', paymentLabel: payNow > 0 ? methods.find((m) => m.id === methodId)?.name || '' : 'Pay later',
        lines: cart.map((l) => ({ name: byId.get(l.productId).name, quantity: fromMilli(l.qty) })),
      };
      const res = await repo.createSale(sale, items, payments, offlineInfo);
      const serverTotal = toCents(res.total);
      if (serverTotal !== calc.total) toast(`Note: the server total (${money(serverTotal)}) differs from the screen (${money(calc.total)}). The server amount is the real one.`, 'bad');
      const method = methods.find((m) => m.id === methodId)?.name || 'Payment';
      setReceipt({
        invoice_number: res.invoice_number, occurred_at: sale.occurred_at, customer: customer?.name || '', status: 'completed',
        items: cart.map((l, i) => { const p = byId.get(l.productId); return { name: p.name, quantity: fromMilli(l.qty), unitPrice: toCents(p.price), gross: calc.lines[i].gross }; }),
        subtotal: calc.subtotal, discount: calc.discount, tax: calc.tax, taxMode: calc.mode, taxName: business.tax_name, taxRate: Number(business.tax_rate),
        total: serverTotal, payments: payNow > 0 ? [{ method, amount: payNow }] : [], balance: Math.max(serverTotal - payNow, 0),
        received: showCash && receivedCents != null ? receivedCents : null, change: changeDue, pendingUpload: !!res.offline,
      });
      toast(res.offline ? 'Saved on this device (no internet). It uploads by itself.' : res.duplicate ? 'This sale was already recorded.' : 'Sale recorded', 'good');
      setCart([]); setDiscText(''); setCustomerId(''); setChannelId(defaultChannelId); setPartialText(''); setReceived(''); setNote(''); setPayMode('full');
      attempt.current = { saleId: newId(), paymentId: newId() };
      reload();
    } catch (e) {
      setError(`${e.message} Nothing was lost: you can press Charge again safely.`);
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Sell" />
      <div className="sell">
        <section aria-label="Products">
          <input className="input" type="search" placeholder="Search or scan a barcode, press Enter to add" aria-label="Search products" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} />
          <div className="chips" role="group" aria-label="Categories">
            <button className="chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All</button>
            {categories.filter((c) => c.active).map((c) => <button key={c.id} className="chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{c.name}</button>)}
          </div>
          {!active.length ? <div className="empty card">No products yet. Add some in <a href="#/products">Products</a>.</div>
            : !shown.length ? <div className="empty card">Nothing matches “{search}”.</div>
            : <div className="catalog">{shown.map((p) => {
              const out = p.track_stock && Number(p.quantity) <= 0;
              return (
                <button key={p.id} className="tile" onClick={() => add(p)} disabled={out}>
                  <span className="name">{p.name}</span>
                  <span className="price num">{money(toCents(p.price))}</span>
                  <span className="stock">{p.track_stock ? (out ? 'Out of stock' : `${formatQuantity(stockLeft(p))} left`) : 'Service'}</span>
                </button>
              );
            })}</div>}
        </section>

        <aside className="card cart" aria-label="Current sale">
          <h2>Current sale</h2>
          {!cart.length ? <div className="empty">Tap a product to add it.</div> : cart.map((l, i) => {
            const p = byId.get(l.productId);
            return (
              <div className="cart-line" key={l.productId}>
                <div><div style={{ fontWeight: 600 }}>{p.name}</div><div className="small muted num">{money(toCents(p.price))} each{p.tax_exempt && business.tax_enabled ? ' · tax exempt' : ''}</div></div>
                <div className="right num" style={{ fontWeight: 700 }}>{money(calc.lines[i].gross)}</div>
                <div className="qty">
                  <button className="btn secondary small" aria-label={`Less ${p.name}`} onClick={() => { const q = l.qty - 1000; q > 0 ? setCart((c) => c.map((x) => x.productId === l.productId ? { ...x, qty: q, text: formatQuantity(q), invalid: false } : x)) : remove(l.productId); }}>−</button>
                  <input className="input" inputMode="decimal" aria-label={`Quantity of ${p.name}`} value={l.text} onChange={(e) => setQtyText(l.productId, e.target.value)} style={l.invalid ? { borderColor: '#b3261e' } : undefined} />
                  <button className="btn secondary small" aria-label={`More ${p.name}`} onClick={() => add(p)}>＋</button>
                </div>
                <div className="right"><button className="btn ghost small" onClick={() => remove(l.productId)}>Remove</button></div>
              </div>
            );
          })}

          {cart.length > 0 && <>
            <div className="grid2" style={{ marginTop: '.75rem' }}>
              <Field label="Discount" id="disc"><input id="disc" className="input" inputMode="decimal" value={discText} onChange={(e) => setDiscText(e.target.value)} placeholder="0" /></Field>
              <Field label="Type" id="dtype"><select id="dtype" className="input" value={discType} onChange={(e) => setDiscType(e.target.value)}><option value="percent">Percent %</option><option value="amount">Amount</option></select></Field>
            </div>
            <div className="totals num" aria-live="polite">
              <div><span>Subtotal</span><span>{money(calc.subtotal)}</span></div>
              {calc.discount > 0 && <div><span>Discount</span><span>−{money(calc.discount)}</span></div>}
              {calc.mode !== 'none' && <div><span>{business.tax_name} {Number(business.tax_rate)}%{calc.mode === 'inclusive' ? ' (included)' : ''}</span><span>{money(calc.tax)}</span></div>}
              <div className="grand"><span>Total</span><span>{money(calc.total)}</span></div>
            </div>

            <div className="grid2" style={{ marginTop: '.75rem' }}>
              <Field label="Customer" id="cust"><select id="cust" className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Walk-in</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Channel" id="chan"><select id="chan" className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)}><option value="">—</option>{channels.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            </div>
            {net.online ? <button className="btn ghost small" onClick={() => setNewCustomer(true)}>＋ New customer</button> : <span className="small muted">New customers need the internet. Use Walk-in for now.</span>}

            <div className="grid2" style={{ marginTop: '.5rem' }}>
              <Field label="Payment" id="pm"><select id="pm" className="input" value={payMode} onChange={(e) => setPayMode(e.target.value)}><option value="full">Paid in full</option><option value="partial">Part payment</option><option value="later">Pay later</option></select></Field>
              {payMode !== 'later' && <Field label="Method" id="meth"><select id="meth" className="input" value={methodId} onChange={(e) => setMethodId(e.target.value)}>{methods.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>}
            </div>
            {payMode === 'partial' && <Field label="Amount paid now" id="part"><input id="part" className="input" inputMode="decimal" value={partialText} onChange={(e) => setPartialText(e.target.value)} /></Field>}
            {showCash && (
              <div className="cashbox">
                <Field label="Cash received" id="recv"><input id="recv" className="input" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={`Amount handed over`} /></Field>
                <div className="quick" role="group" aria-label="Quick amounts">
                  {quick.map((v, i) => <button key={v} type="button" className="chip" onClick={() => setReceived(String(fromCents(v)))}>{i === 0 ? `Exact ${money(v)}` : money(v)}</button>)}
                </div>
                <div className="change" aria-live="polite"><span>Change</span><span className="num">{changeDue != null ? money(changeDue) : receivedCents != null ? `Short ${money(payNow - receivedCents)}` : '–'}</span></div>
              </div>
            )}
            {balance > 0 && <div className="notice">Balance to collect later: <strong>{money(balance)}</strong></div>}
            <Field label="Note (optional)" id="note"><input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            {error && <div className="notice bad" role="alert">{error}</div>}
            <button className="btn block" onClick={charge} disabled={busy}>{busy ? 'Saving…' : `Charge ${money(calc.total)}`}</button>
            <button className="btn ghost block" style={{ marginTop: '.4rem' }} onClick={() => { setCart([]); setError(''); }} disabled={busy}>Clear sale</button>
          </>}
        </aside>
      </div>
      {receipt && <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />}
      {newCustomer && <CustomerDialog onClose={() => setNewCustomer(false)} onSaved={(c) => { setCustomerId(c.id); reload(); }} />}
    </>
  );
}

export function CustomerDialog({ onClose, onSaved }) {
  const { toast } = useApp();
  const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async () => {
    if (!name.trim()) { setError('Please enter a name.'); return; }
    setBusy(true);
    try { const c = await repo.saveCustomer({ name: name.trim(), phone: phone.trim() || null }); toast('Customer added', 'good'); onSaved(c); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title="New customer" onClose={onClose} actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>Save</button></>}>
      <Field label="Name" id="cname"><input id="cname" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Phone (optional)" id="cphone"><input id="cphone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}
