import { useMemo, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { formatQuantity, fromCents, toCents, toMilli } from '../lib/money.js';
import { newId } from '../lib/ids.js';
import { planReturn } from '../lib/returns.js';
import { useApp } from '../ui/context.js';
import { Dialog, ErrorBox, Field, Loading, useLoad } from '../ui/kit.jsx';

const REASONS = ['Customer changed their mind', 'Damaged or defective', 'Wrong item', 'Expired', 'Price mistake'];

/** Take items of one sale back. Shows what it is worth and how much money goes back BEFORE anything is saved. */
export function ReturnDialog({ sale, items, onClose, onDone }) {
  const { methods, money, toast } = useApp();
  const { data: past, error, loading } = useLoad(() => repo.getSaleReturns(sale.id), [sale.id]);
  const [qty, setQty] = useState({});        // sale_item_id -> text typed
  const [restock, setRestock] = useState({}); // sale_item_id -> false when the goods are damaged
  const [reason, setReason] = useState('');
  const activeMethods = methods.filter((m) => m.active);
  const [methodId, setMethodId] = useState((activeMethods.find((m) => /cash/i.test(m.name)) || activeMethods[0] || {}).id || '');
  const [busy, setBusy] = useState(false); const [problem, setProblem] = useState('');
  const returnId = useRef(newId()); // the same id on a retry, so a return is never counted twice

  const lines = useMemo(() => items.map((i) => {
    const prior = { qtyMilli: 0, gross: 0, discount: 0, tax: 0, total: 0, basis: 0 };
    for (const r of past || []) for (const ri of r.items) if (ri.sale_item_id === i.id) {
      prior.qtyMilli += toMilli(ri.quantity); prior.gross += toCents(ri.gross); prior.discount += toCents(ri.discount_amount);
      prior.tax += toCents(ri.tax_amount); prior.total += toCents(ri.total); prior.basis += toCents(ri.cogs_basis);
    }
    return { id: i.id, name: i.name, qtyMilli: toMilli(i.quantity), gross: toCents(i.line_gross), discount: toCents(i.discount_amount),
      tax: toCents(i.tax_amount), total: toCents(i.line_total), unitCost: toCents(i.unit_cost), prior };
  }), [items, past]);

  const wanted = lines.map((l) => {
    const text = (qty[l.id] ?? '').toString().trim().replace(',', '.');
    if (!text) return null;
    const n = Number(text);
    return { id: l.id, text, qtyMilli: Math.round(n * 1000), valid: Number.isFinite(n) && n > 0 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, restock: restock[l.id] !== false };
  }).filter(Boolean);
  const invalid = wanted.find((w) => !w.valid);

  const plan = useMemo(() => {
    if (!past || !wanted.length || invalid) return null;
    try {
      return { ok: planReturn({ sale: { total: toCents(sale.total), taxMode: sale.tax_mode }, lines, items: wanted, money: { paid: toCents(sale.paid), returned: toCents(sale.returned), refunded: toCents(sale.refunded) } }) };
    } catch (e) { return { error: e.message }; }
  }, [past, qty, restock, lines]); // eslint-disable-line react-hooks/exhaustive-deps

  const left = (l) => (l.qtyMilli - l.prior.qtyMilli) / 1000;
  const allLeft = () => setQty(Object.fromEntries(lines.filter((l) => left(l) > 0).map((l) => [l.id, String(left(l))])));
  const p = plan?.ok;

  const submit = async () => {
    if (!reason.trim()) { setProblem('Please write why the items are coming back.'); return; }
    if (!p) { setProblem(plan?.error || 'Enter how many of each item are coming back.'); return; }
    if (p.refund > 0 && !methodId) { setProblem('Choose how the money is given back.'); return; }
    setBusy(true); setProblem('');
    try {
      const res = await repo.createReturn(
        { id: returnId.current, sale_id: sale.id, reason: reason.trim(), refund_method_id: p.refund > 0 ? methodId : null },
        wanted.map((w) => ({ sale_item_id: w.id, quantity: w.qtyMilli / 1000, restock: w.restock })));
      toast(`Return ${res.return_number} saved`, 'good');
      onDone({ return_number: res.return_number, invoice_number: sale.invoice_number, occurred_at: new Date().toISOString(), reason: reason.trim(),
        items: p.lines.map((l) => ({ name: l.name, quantity: l.qtyMilli / 1000, total: l.total, restocked: l.restocked })),
        subtotal: p.subtotal, discount: p.discount, tax: p.tax, taxMode: sale.tax_mode, taxName: sale.tax_name, total: p.total,
        refund: toCents(res.refund_amount), method: p.refund > 0 ? methods.find((m) => m.id === methodId)?.name : '', balanceAfter: p.balanceAfter });
    } catch (e) { setProblem(e.message); setBusy(false); }
  };

  return (
    <Dialog title={`Return items · ${sale.invoice_number}`} onClose={onClose} wide actions={<>
      <button className="btn secondary" onClick={onClose}>Cancel</button>
      <button className="btn" onClick={submit} disabled={busy || loading || !wanted.length}>{busy ? 'Saving…' : 'Process return'}</button>
    </>}>
      <ErrorBox error={error} />
      {loading ? <Loading /> : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>Type how many of each item the customer is bringing back. "Back" is what was already returned before. The stock goes back on the shelf unless you untick "Restock" (for damaged goods).</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th className="right">Sold</th><th className="right">Back</th><th className="right">Return</th><th>Restock</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td className="right num">{formatQuantity(l.qtyMilli)}</td>
                <td className="right num">{l.prior.qtyMilli ? formatQuantity(l.prior.qtyMilli) : '–'}</td>
                <td className="right">{left(l) > 0 ? <input className="input qty-input" inputMode="decimal" aria-label={`Return quantity for ${l.name}`} value={qty[l.id] ?? ''} placeholder="0" onChange={(e) => setQty((s) => ({ ...s, [l.id]: e.target.value }))} /> : <span className="muted">all returned</span>}</td>
                <td>{left(l) > 0 && <input type="checkbox" aria-label={`Put ${l.name} back in stock`} checked={restock[l.id] !== false} onChange={(e) => setRestock((s) => ({ ...s, [l.id]: e.target.checked }))} />}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="row" style={{ margin: '.5rem 0' }}><button type="button" className="btn ghost small" onClick={allLeft}>Return everything that is left</button></div>
          {invalid && <div className="notice bad">"{invalid.text}" is not a valid quantity (use numbers like 1 or 0.5).</div>}
          {plan?.error && <div className="notice bad">{plan.error}</div>}
          {p && (
            <div className="totals num">
              <div><span>Items before discount</span><span>{money(p.subtotal)}</span></div>
              {p.discount > 0 && <div><span>Discount</span><span>−{money(p.discount)}</span></div>}
              {p.tax > 0 && <div><span>{sale.tax_name || 'Tax'}{sale.tax_mode === 'inclusive' ? ' (included)' : ''}</span><span>{money(p.tax)}</span></div>}
              <div className="grand"><span>Value of items returned</span><span>{money(p.total)}</span></div>
              <div className="change"><span>{p.refund > 0 ? 'Give back to the customer' : 'Money to give back'}</span><span className="num">{money(p.refund)}</span></div>
              {p.refund === 0 && <p className="muted small" style={{ margin: '.3rem 0 0' }}>{p.balanceAfter > 0 ? `Nothing to hand back: the customer had not paid it all. What they still owe on this sale drops to ${money(p.balanceAfter)}.` : 'Nothing to hand back.'}</p>}
            </div>
          )}
          {p?.refund > 0 && (
            <Field label="Give the money back by" id="rmeth"><select id="rmeth" className="input" value={methodId} onChange={(e) => setMethodId(e.target.value)}>{activeMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
          )}
          <Field label="Reason (required)" id="rreason" hint="Kept with the return for your records."><input id="rreason" className="input" list="reasons" value={reason} onChange={(e) => setReason(e.target.value)} /><datalist id="reasons">{REASONS.map((r) => <option key={r} value={r} />)}</datalist></Field>
          {problem && <div className="notice bad" role="alert">{problem}</div>}
        </>
      )}
    </Dialog>
  );
}
