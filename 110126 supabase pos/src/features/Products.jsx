import { useMemo, useState } from 'react';
import { repo } from '../data/repo.js';
import { fromCents, fromMilli, formatQuantity, parseAmount, parseQuantity, toCents } from '../lib/money.js';
import { useApp } from '../ui/context.js';
import { Badge, Dialog, ErrorBox, Field, Loading, PageHead, downloadCsv, useLoad } from '../ui/kit.jsx';

export default function Products() {
  const { products, categories, can, money, reload } = useApp();
  const [q, setQ] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [edit, setEdit] = useState(null); // product | {} (new)
  const [adjust, setAdjust] = useState(null);
  const catName = (id) => categories.find((c) => c.id === id)?.name || '–';
  const rows = useMemo(() => products.filter((p) => (showOff || p.active)
    && (!q.trim() || [p.name, p.sku, p.barcode].some((v) => (v || '').toLowerCase().includes(q.trim().toLowerCase())))), [products, q, showOff]);
  const low = (p) => p.active && p.track_stock && Number(p.reorder_level) > 0 && Number(p.quantity) <= Number(p.reorder_level);
  const stockValue = products.filter((p) => p.active && p.track_stock).reduce((n, p) => n + Math.round(Number(p.quantity) * toCents(p.cost_price)), 0);
  const edits = can('editProducts');

  return (
    <>
      <PageHead title="Products">
        <button className="btn secondary small" onClick={() => downloadCsv('products.csv', ['Name', 'SKU', 'Barcode', 'Category', 'Price', 'Cost', 'Stock', 'Active'],
          products.map((p) => [p.name, p.sku, p.barcode, catName(p.category_id), p.price, p.cost_price, p.track_stock ? p.quantity : '', p.active ? 'yes' : 'no']))}>Download CSV</button>
        {edits && <button className="btn" onClick={() => setEdit({})}>＋ Add product</button>}
      </PageHead>
      <div className="row" style={{ marginBottom: '.75rem' }}>
        <input className="input" style={{ maxWidth: 300 }} type="search" aria-label="Search products" placeholder="Name, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />Show switched-off</label>
        {edits && <span className="muted small num">Stock value at cost: {money(stockValue)}</span>}
      </div>
      {!rows.length ? <div className="card empty">{products.length ? 'No products match.' : 'No products yet. Add your first product.'}</div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Product</th><th>Category</th><th className="right">Price</th>{edits && <th className="right">Cost</th>}<th className="right">Stock</th><th></th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id} className={p.active ? '' : 'dim'}>
              <td><strong>{p.name}</strong><div className="small muted">{[p.sku, p.barcode].filter(Boolean).join(' · ')}{p.tax_exempt ? ' · tax exempt' : ''}</div></td>
              <td>{catName(p.category_id)}</td>
              <td className="right num">{money(toCents(p.price))}</td>
              {edits && <td className="right num">{money(toCents(p.cost_price))}</td>}
              <td className="right num">{p.track_stock ? <>{formatQuantity(Math.round(Number(p.quantity) * 1000))} {low(p) && <Badge tone="warn">Low</Badge>}</> : <span className="muted">Service</span>}</td>
              <td className="right">
                {can('adjustStock') && p.track_stock && <button className="btn ghost small" onClick={() => setAdjust(p)}>Stock</button>}
                {edits && <button className="btn ghost small" onClick={() => setEdit(p)}>Edit</button>}
                {!p.active && <Badge>Off</Badge>}
              </td>
            </tr>))}</tbody>
        </table></div>
      )}
      {edit && <ProductDialog product={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {adjust && <StockDialog product={adjust} onClose={() => setAdjust(null)} onSaved={() => { setAdjust(null); reload(); }} />}
    </>
  );
}

function ProductDialog({ product, onClose, onSaved }) {
  const { categories, toast, business } = useApp();
  const isNew = !product.id;
  const [f, setF] = useState({
    name: product.name || '', sku: product.sku || '', barcode: product.barcode || '', category_id: product.category_id || '',
    price: product.price != null ? String(product.price) : '', cost: product.cost_price != null ? String(product.cost_price) : '',
    track_stock: product.track_stock ?? true, quantity: '0', reorder: product.reorder_level != null ? String(Number(product.reorder_level)) : '0',
    tax_exempt: product.tax_exempt ?? false, active: product.active ?? true,
  });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    const price = parseAmount(f.price); const cost = f.cost.trim() ? parseAmount(f.cost) : 0;
    const qty = parseQuantity(f.quantity || '0'); const reorder = parseQuantity(f.reorder || '0');
    if (!f.name.trim()) return setError('Please enter a name.');
    if (price == null) return setError('The price must be a number such as 25 or 25.50.');
    if (cost == null) return setError('The cost must be a number such as 18 or 18.50.');
    if (isNew && f.track_stock && qty == null) return setError('The opening stock must be a number.');
    if (reorder == null) return setError('The reorder level must be a number.');
    setBusy(true); setError('');
    try {
      await repo.saveProduct({
        id: product.id, name: f.name.trim(), sku: f.sku.trim() || null, barcode: f.barcode.trim() || null, category_id: f.category_id || null,
        price: fromCents(price), cost_price: fromCents(cost), track_stock: f.track_stock, reorder_level: fromMilli(reorder),
        tax_exempt: f.tax_exempt, active: f.active, ...(isNew ? { quantity: f.track_stock ? fromMilli(qty) : 0 } : {}),
      });
      toast(isNew ? 'Product added' : 'Product saved', 'good'); onSaved();
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title={isNew ? 'Add product' : 'Edit product'} onClose={onClose} wide actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <Field label="Name" id="pn"><input id="pn" className="input" value={f.name} onChange={set('name')} /></Field>
      <div className="grid2">
        <Field label="Price" id="pp"><input id="pp" className="input" inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
        <Field label="Cost (what it costs you)" id="pc" hint="Needed for profit figures."><input id="pc" className="input" inputMode="decimal" value={f.cost} onChange={set('cost')} /></Field>
        <Field label="SKU (optional)" id="ps"><input id="ps" className="input" value={f.sku} onChange={set('sku')} /></Field>
        <Field label="Barcode (optional)" id="pb"><input id="pb" className="input" value={f.barcode} onChange={set('barcode')} /></Field>
      </div>
      <Field label="Category" id="pcat"><select id="pcat" className="input" value={f.category_id} onChange={set('category_id')}><option value="">None</option>{categories.filter((c) => c.active || c.id === f.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <label className="check"><input type="checkbox" checked={f.track_stock} onChange={set('track_stock')} />Track stock (turn off for services)</label>
      {f.track_stock && <div className="grid2" style={{ marginTop: '.5rem' }}>
        {isNew && <Field label="Opening stock" id="pq"><input id="pq" className="input" inputMode="decimal" value={f.quantity} onChange={set('quantity')} /></Field>}
        <Field label="Warn me when stock is at or below" id="pr"><input id="pr" className="input" inputMode="decimal" value={f.reorder} onChange={set('reorder')} /></Field>
      </div>}
      {!isNew && f.track_stock && <p className="muted small">To change the amount in stock, use the Stock button on the list so the change is recorded.</p>}
      {business.tax_enabled && <label className="check"><input type="checkbox" checked={f.tax_exempt} onChange={set('tax_exempt')} />Tax exempt (no {business.tax_name} on this product)</label>}
      <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} />Active (appears on the Sell screen)</label>
      {error && <div className="notice bad" role="alert" style={{ marginTop: '.6rem' }}>{error}</div>}
    </Dialog>
  );
}

function StockDialog({ product, onClose, onSaved }) {
  const { toast } = useApp();
  const [change, setChange] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const history = useLoad(() => repo.listStockMovements(product.id), [product.id]);
  const save = async () => {
    const neg = change.trim().startsWith('-');
    const mag = parseQuantity(change.trim().replace(/^[-+]/, ''));
    if (mag == null || mag === 0) return setError('Enter how many to add (e.g. 12) or remove (e.g. -3).');
    setBusy(true); setError('');
    try { await repo.adjustStock(product.id, fromMilli(neg ? -mag : mag), note); toast('Stock updated', 'good'); onSaved(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title={`Stock: ${product.name}`} onClose={onClose} wide actions={<><button className="btn secondary" onClick={onClose}>Close</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save change'}</button></>}>
      <p>In stock now: <strong>{formatQuantity(Math.round(Number(product.quantity) * 1000))}</strong></p>
      <div className="grid2">
        <Field label="Change (+ add, − remove)" id="sc"><input id="sc" className="input" inputMode="decimal" value={change} onChange={(e) => setChange(e.target.value)} placeholder="e.g. 24 or -2" /></Field>
        <Field label="Reason" id="sn"><input id="sn" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery, damaged, count…" /></Field>
      </div>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <h3 style={{ marginTop: '1rem' }}>Recent changes</h3>
      <ErrorBox error={history.error} />
      {history.loading ? <Loading /> : !history.data?.length ? <p className="muted">No changes yet.</p> : (
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th className="right">Change</th><th className="right">After</th><th>Note</th></tr></thead>
          <tbody>{history.data.map((m) => <tr key={m.id}><td>{new Date(m.created_at).toLocaleString()}</td><td>{m.type}</td><td className="right num">{Number(m.quantity_change) > 0 ? '+' : ''}{Number(m.quantity_change)}</td><td className="right num">{Number(m.quantity_after)}</td><td>{m.note || ''}</td></tr>)}</tbody></table></div>
      )}
    </Dialog>
  );
}
