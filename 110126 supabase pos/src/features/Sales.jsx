import { useMemo, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { PRESET_LABELS, addDays, rangeFor, startOfDayInstant, todayIn } from '../lib/dates.js';
import { fromCents, parseAmount, toCents } from '../lib/money.js';
import { newId } from '../lib/ids.js';
import { useApp } from '../ui/context.js';
import { Badge, ConfirmDialog, Dialog, ErrorBox, Field, Loading, PageHead, downloadCsv, useLoad } from '../ui/kit.jsx';
import { ReceiptDialog } from '../ui/Receipt.jsx';

const RANGES = ['today', 'week', 'month', 'year', 'custom'];

export default function Sales() {
  const { business, customers, can, money } = useApp();
  const [preset, setPreset] = useState('week');
  const [custom, setCustom] = useState({ from: todayIn(business.timezone), to: todayIn(business.timezone) });
  const [filter, setFilter] = useState('all'); // all | unpaid | voided
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [openMode, setOpenMode] = useState('');
  const range = useMemo(() => rangeFor(preset, { today: todayIn(business.timezone), weekStartsOn: business.week_starts_on, custom }), [preset, business, custom]);
  const { data, error, loading, reload } = useLoad(() => repo.listSales({
    fromInstant: startOfDayInstant(range.from, business.timezone).toISOString(),
    toInstant: startOfDayInstant(addDays(range.to, 1), business.timezone).toISOString(),
  }), [range.from, range.to]);

  const custName = (id) => customers.find((c) => c.id === id)?.name || '';
  const rows = useMemo(() => (data || []).filter((s) => {
    if (filter === 'unpaid' && !(s.status === 'completed' && toCents(s.balance) > 0)) return false;
    if (filter === 'voided' && s.status !== 'voided') return false;
    const t = q.trim().toLowerCase();
    return !t || s.invoice_number.toLowerCase().includes(t) || custName(s.customer_id).toLowerCase().includes(t);
  }), [data, filter, q, customers]);

  const live = rows.filter((s) => s.status === 'completed');
  const totalBilled = live.reduce((n, s) => n + toCents(s.total), 0);
  const totalOwed = live.reduce((n, s) => n + toCents(s.balance), 0);
  const fmtDate = (iso) => new Date(iso).toLocaleString(business.locale, { timeZone: business.timezone, dateStyle: 'medium', timeStyle: 'short' });

  const exportCsv = () => downloadCsv(`sales-${range.from}-to-${range.to}.csv`,
    ['Invoice', 'Date', 'Customer', 'Status', 'Subtotal', 'Discount', 'Tax', 'Total', 'Net sales', 'Paid', 'Balance'],
    rows.map((s) => [s.invoice_number, s.occurred_at, custName(s.customer_id), s.status, s.subtotal, s.discount_amount, s.tax_amount, s.total, s.net_sales, s.paid, s.balance]));

  return (
    <>
      <PageHead title="Sales"><button className="btn secondary small" onClick={exportCsv} disabled={!rows.length}>Download CSV</button></PageHead>
      <div className="range-bar" role="group" aria-label="Period">
        {RANGES.map((r) => <button key={r} className="seg" aria-pressed={preset === r} onClick={() => setPreset(r)}>{PRESET_LABELS[r]}</button>)}
      </div>
      {preset === 'custom' && (
        <div className="row" style={{ marginBottom: '.75rem' }}>
          <label>From <input className="input" type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
          <label>To <input className="input" type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
        </div>
      )}
      <div className="row" style={{ marginBottom: '.75rem' }}>
        <input className="input" style={{ maxWidth: 280 }} type="search" aria-label="Search sales" placeholder="Invoice or customer" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ maxWidth: 200 }} aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All sales</option><option value="unpaid">Not fully paid</option><option value="voided">Voided</option>
        </select>
        <span className="muted small num">{live.length} sales · billed {money(totalBilled)} · still owed {money(totalOwed)}</span>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : !rows.length ? <div className="card empty">No sales found for this period.</div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th className="right">Total</th><th className="right">Balance</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id} className={s.status === 'voided' ? 'dim' : ''}>
              <td><button className="btn ghost small" onClick={() => { setOpenMode(''); setOpen(s); }}>{s.invoice_number}</button></td>
              <td className="nowrap">{fmtDate(s.occurred_at)}</td><td>{custName(s.customer_id) || 'Walk-in'}</td>
              <td className="right num">{money(toCents(s.total))}</td>
              <td className="right num">{s.status === 'completed' && toCents(s.balance) > 0 ? money(toCents(s.balance)) : '–'}</td>
              <td>{s.status === 'voided' ? <Badge tone="bad">Voided</Badge> : toCents(s.balance) > 0 ? <Badge tone="warn">Unpaid</Badge> : <Badge tone="good">Paid</Badge>}</td>
              <td className="nowrap">
                <button className="btn secondary small" onClick={() => { setOpenMode(''); setOpen(s); }}>Open</button>{' '}
                {s.status === 'completed' && can('voidSale') && <button className="btn danger small" aria-label={`Void ${s.invoice_number}`} onClick={() => { setOpenMode('void'); setOpen(s); }}>Void</button>}
              </td>
            </tr>))}</tbody>
        </table></div>
      )}
      {open && <SaleDetail key={open.id + openMode} startMode={openMode} sale={open} onClose={() => setOpen(null)} onChanged={() => { reload(); setOpen(null); }} can={can} />}
    </>
  );
}

function SaleDetail({ sale, onClose, onChanged, can, startMode = '' }) {
  const { methods, customers, money, toast, reload: reloadBase } = useApp();
  const { data, error, loading } = useLoad(() => repo.getSaleDetail(sale.id), [sale.id]);
  const [mode, setMode] = useState(startMode); // '' | receipt | pay | void
  const balance = toCents(sale.balance);
  const methodName = (id) => methods.find((m) => m.id === id)?.name || 'Payment';

  const receipt = data && {
    invoice_number: sale.invoice_number, occurred_at: sale.occurred_at, status: sale.status,
    customer: customers.find((c) => c.id === sale.customer_id)?.name || '',
    items: data.items.map((i) => ({ name: i.name, quantity: Number(i.quantity), unitPrice: toCents(i.unit_price), gross: toCents(i.line_gross) })),
    subtotal: toCents(sale.subtotal), discount: toCents(sale.discount_amount), tax: toCents(sale.tax_amount),
    taxMode: sale.tax_mode, taxName: sale.tax_name, taxRate: Number(sale.tax_rate), total: toCents(sale.total),
    payments: data.payments.map((p) => ({ method: methodName(p.method_id), amount: toCents(p.amount) })), balance: sale.status === 'completed' ? balance : 0,
  };

  if (mode === 'receipt' && receipt) return <ReceiptDialog receipt={receipt} onClose={() => setMode('')} />;
  if (mode === 'void') return <ConfirmDialog title={`Void ${sale.invoice_number}?`} danger askReason confirmLabel="Void sale"
    message="This cancels the whole sale and puts the items back in stock. It cannot be undone, but it stays in the history."
    onConfirm={async (reason) => { await repo.voidSale(sale.id, reason); toast('Sale voided', 'good'); reloadBase(); onChanged(); }} onClose={() => (startMode ? onClose() : setMode(''))} />;
  if (mode === 'pay') return <PaymentDialog sale={sale} balance={balance} onClose={() => setMode('')} onDone={() => { reloadBase(); onChanged(); }} />;

  return (
    <Dialog title={sale.invoice_number} onClose={onClose} wide actions={<>
      {sale.status === 'completed' && balance > 0 && can('takePayment') && <button className="btn" onClick={() => setMode('pay')}>Record payment</button>}
      <button className="btn secondary" onClick={() => setMode('receipt')} disabled={!receipt}>Receipt</button>
      {sale.status === 'completed' && can('voidSale') && <button className="btn danger" onClick={() => setMode('void')}>Void</button>}
    </>}>
      <ErrorBox error={error} />
      {loading ? <Loading /> : data && <>
        {sale.status === 'voided' && <div className="notice bad">Voided: {sale.void_reason}</div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Item</th><th className="right">Qty</th><th className="right">Price</th><th className="right">Line</th></tr></thead>
          <tbody>{data.items.map((i) => <tr key={i.id}><td>{i.name}</td><td className="right num">{Number(i.quantity)}</td><td className="right num">{money(toCents(i.unit_price))}</td><td className="right num">{money(toCents(i.line_gross))}</td></tr>)}</tbody>
        </table></div>
        <div className="totals num">
          <div><span>Subtotal</span><span>{money(toCents(sale.subtotal))}</span></div>
          {toCents(sale.discount_amount) > 0 && <div><span>Discount</span><span>−{money(toCents(sale.discount_amount))}</span></div>}
          {sale.tax_mode !== 'none' && <div><span>{sale.tax_name} {Number(sale.tax_rate)}%{sale.tax_mode === 'inclusive' ? ' (included)' : ''}</span><span>{money(toCents(sale.tax_amount))}</span></div>}
          <div className="grand"><span>Total</span><span>{money(toCents(sale.total))}</span></div>
          <div><span>Net sales (without tax)</span><span>{money(toCents(sale.net_sales))}</span></div>
        </div>
        <h3 style={{ marginTop: '1rem' }}>Payments</h3>
        {!data.payments.length ? <p className="muted">No payments yet.</p> : data.payments.map((p) => (
          <div className="row between" key={p.id}><span>{methodName(p.method_id)} · {new Date(p.paid_at).toLocaleDateString()}</span><span className="num">{money(toCents(p.amount))}</span></div>))}
        {sale.status === 'completed' && balance > 0 && <div className="notice" style={{ marginTop: '.6rem' }}>Balance due: <strong>{money(balance)}</strong></div>}
      </>}
    </Dialog>
  );
}

function PaymentDialog({ sale, balance, onClose, onDone }) {
  const { methods, money, toast } = useApp();
  const [text, setText] = useState(String(fromCents(balance)));
  const [methodId, setMethodId] = useState(methods.find((m) => m.active)?.id || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const paymentId = useRef(newId()); // the same id on a retry, so a payment is never counted twice
  const save = async () => {
    const cents = parseAmount(text);
    if (!cents || cents <= 0) { setError('Enter an amount above zero.'); return; }
    if (cents > balance) { setError(`That is more than the balance (${money(balance)}).`); return; }
    if (!methodId) { setError('Choose a method.'); return; }
    setBusy(true);
    try { await repo.recordPayment(paymentId.current, sale.id, methodId, fromCents(cents), note); toast('Payment recorded', 'good'); onDone(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title={`Payment for ${sale.invoice_number}`} onClose={onClose} actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save payment'}</button></>}>
      <p>Balance due: <strong>{money(balance)}</strong></p>
      <Field label="Amount" id="pamt"><input id="pamt" className="input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label="Method" id="pmeth"><select id="pmeth" className="input" value={methodId} onChange={(e) => setMethodId(e.target.value)}>{methods.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      <Field label="Note (optional)" id="pnote"><input id="pnote" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}
