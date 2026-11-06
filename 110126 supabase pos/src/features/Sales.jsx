import { useMemo, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { addDays, startOfDayInstant } from '../lib/dates.js';
import { fromCents, parseAmount, toCents } from '../lib/money.js';
import { newId } from '../lib/ids.js';
import { useApp } from '../ui/context.js';
import { Badge, ConfirmDialog, Dialog, ErrorBox, Field, Loading, PageHead, downloadCsv, useLoad } from '../ui/kit.jsx';
import { ReceiptDialog } from '../ui/Receipt.jsx';
import { ReturnSlipDialog } from '../ui/ReturnSlip.jsx';
import { ReturnDialog } from './ReturnDialog.jsx';
import { PeriodBar, usePeriod } from '../ui/period.jsx';

const SHOW_MAX = 500; // rows drawn on screen; totals and the CSV always use every sale

export default function Sales() {
  const { business, customers, can, money } = useApp();
  const [filter, setFilter] = useState('all'); // all | unpaid | voided
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [openMode, setOpenMode] = useState('');
  const { range, customOk } = usePeriod();
  const { data, error, loading, reload } = useLoad(() => (!customOk ? Promise.resolve([]) : repo.listSales({
    fromInstant: startOfDayInstant(range.from, business.timezone).toISOString(),
    toInstant: startOfDayInstant(addDays(range.to, 1), business.timezone).toISOString(),
  })), [range.from, range.to, customOk]);
  const rets = useLoad(() => (!customOk ? Promise.resolve([]) : repo.listReturns({
    fromInstant: startOfDayInstant(range.from, business.timezone).toISOString(),
    toInstant: startOfDayInstant(addDays(range.to, 1), business.timezone).toISOString(),
  })), [range.from, range.to, customOk]);
  const returnRows = rets.data || [];
  const returnsTotal = returnRows.reduce((n, r) => n + toCents(r.total), 0);

  const custName = (id) => customers.find((c) => c.id === id)?.name || '';
  const rows = useMemo(() => (data || []).filter((s) => {
    if (filter === 'unpaid' && !(s.status === 'completed' && toCents(s.balance) > 0)) return false;
    if (filter === 'voided' && s.status !== 'voided') return false;
    const t = q.trim().toLowerCase();
    return !t || s.invoice_number.toLowerCase().includes(t) || custName(s.customer_id).toLowerCase().includes(t);
  }), [data, filter, q, customers]);

  const live = rows.filter((s) => s.status === 'completed');
  const reloadAll = () => { reload(); rets.reload(); };
  const totalBilled = live.reduce((n, s) => n + toCents(s.total), 0);
  const totalOwed = live.reduce((n, s) => n + toCents(s.balance), 0);
  const fmtDate = (iso) => new Date(iso).toLocaleString(business.locale, { timeZone: business.timezone, dateStyle: 'medium', timeStyle: 'short' });

  const exportCsv = () => downloadCsv(`sales-${range.from}-to-${range.to}.csv`,
    ['Invoice', 'Date', 'Customer', 'Status', 'Subtotal', 'Discount', 'Tax', 'Total', 'Net sales', 'Paid', 'Balance'],
    [...rows.map((s) => [s.invoice_number, s.occurred_at, custName(s.customer_id), s.status, s.subtotal, s.discount_amount, s.tax_amount, s.total, s.net_sales, s.paid, s.balance]),
      ...returnRows.map((r) => [r.return_number, r.occurred_at, `Return of ${r.invoice_number}`, 'return', -r.subtotal, -r.discount_amount, -r.tax_amount, -r.total, -r.net_amount, -r.refund_amount, ''])]);

  return (
    <>
      <PageHead title="Sales"><button className="btn secondary small" onClick={exportCsv} disabled={!rows.length && !returnRows.length}>Download CSV</button></PageHead>
      <PeriodBar />
      <div className="row" style={{ marginBottom: '.75rem' }}>
        <input className="input" style={{ maxWidth: 280 }} type="search" aria-label="Search sales" placeholder="Invoice or customer" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ maxWidth: 200 }} aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All sales</option><option value="unpaid">Not fully paid</option><option value="voided">Voided</option>
        </select>
        <span className="muted small num" data-testid="sales-summary">{live.length} sales · billed {money(totalBilled)}{returnRows.length ? ` · returned ${money(returnsTotal)} · net ${money(totalBilled - returnsTotal)}` : ''} · still owed {money(totalOwed)}</span>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : !rows.length ? <div className="card empty">No sales found for this period.</div> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th className="right">Total</th><th className="right">Balance</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{rows.slice(0, SHOW_MAX).map((s) => (
            <tr key={s.id} className={s.status === 'voided' ? 'dim' : ''}>
              <td><button className="btn ghost small" onClick={() => { setOpenMode(''); setOpen(s); }}>{s.invoice_number}</button></td>
              <td className="nowrap">{fmtDate(s.occurred_at)}</td><td>{custName(s.customer_id) || 'Walk-in'}</td>
              <td className="right num">{money(toCents(s.total))}</td>
              <td className="right num">{s.status === 'completed' && toCents(s.balance) > 0 ? money(toCents(s.balance)) : '–'}</td>
              <td>{s.status === 'voided' ? <Badge tone="bad">Voided</Badge> : toCents(s.balance) > 0 ? <Badge tone="warn">Unpaid</Badge> : <Badge tone="good">Paid</Badge>}{toCents(s.returned) > 0 && <> <Badge tone="warn">{toCents(s.returned) >= toCents(s.total) ? 'Returned' : 'Part returned'}</Badge></>}</td>
              <td className="nowrap">
                <button className="btn secondary small" onClick={() => { setOpenMode(''); setOpen(s); }}>Open</button>{' '}
                {s.status === 'completed' && can('voidSale') && toCents(s.returned) === 0 && <button className="btn danger small" aria-label={`Void ${s.invoice_number}`} onClick={() => { setOpenMode('void'); setOpen(s); }}>Void</button>}
                {s.status === 'completed' && can('returnItems') && toCents(s.returned) < toCents(s.total) && <> <button className="btn secondary small" aria-label={`Return items from ${s.invoice_number}`} onClick={() => { setOpenMode('return'); setOpen(s); }}>Return</button></>}
              </td>
            </tr>))}</tbody>
        </table></div>
      )}
      {returnRows.length > 0 && (
        <section className="card table-wrap" style={{ marginTop: '1rem' }} aria-label="Returns in this period">
          <h2>Returns in this period <span className="muted small">({returnRows.length} · {money(returnsTotal)} · counted on the day the goods came back)</span></h2>
          <table><thead><tr><th>Return</th><th>Date</th><th>Sale</th><th>Reason</th><th className="right">Value returned</th><th className="right">Money given back</th></tr></thead>
            <tbody>{returnRows.slice(0, SHOW_MAX).map((r) => (
              <tr key={r.id}><td>{r.return_number}</td><td className="nowrap">{fmtDate(r.occurred_at)}</td><td>{r.invoice_number}</td><td>{r.reason}</td>
                <td className="right num">{money(toCents(r.total))}</td><td className="right num">{toCents(r.refund_amount) > 0 ? money(toCents(r.refund_amount)) : '–'}</td></tr>))}</tbody></table>
        </section>)}
      {rows.length > SHOW_MAX && <p className="notice">Showing the newest {SHOW_MAX} of {rows.length} sales. The totals above count all {rows.length}. Download the CSV to get every sale.</p>}
      {data?.truncated && <p className="notice bad">This period has more than 20,000 sales, so some are left out. Choose a shorter period.</p>}
      {open && <SaleDetail key={open.id + openMode} startMode={openMode} sale={open} onClose={() => setOpen(null)} onChanged={() => { reloadAll(); setOpen(null); }} can={can} />}
    </>
  );
}

function SaleDetail({ sale, onClose, onChanged, can, startMode = '' }) {
  const [slip, setSlip] = useState(null);
  const { methods, customers, money, toast, reload: reloadBase } = useApp();
  const { data, error, loading } = useLoad(async () => ({ ...(await repo.getSaleDetail(sale.id)), returns: await repo.getSaleReturns(sale.id) }), [sale.id]);
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
  if (slip) return <ReturnSlipDialog slip={slip} onClose={() => { setSlip(null); reloadBase(); onChanged(); }} />;
  if (mode === 'return') return data ? <ReturnDialog sale={sale} items={data.items} onClose={() => (startMode ? onClose() : setMode(''))} onDone={(s) => { setMode(''); setSlip(s); }} /> : null;
  if (mode === 'pay') return <PaymentDialog sale={sale} balance={balance} onClose={() => setMode('')} onDone={() => { reloadBase(); onChanged(); }} />;

  return (
    <Dialog title={sale.invoice_number} onClose={onClose} wide actions={<>
      {sale.status === 'completed' && balance > 0 && can('takePayment') && <button className="btn" onClick={() => setMode('pay')}>Record payment</button>}
      <button className="btn secondary" onClick={() => setMode('receipt')} disabled={!receipt}>Receipt</button>
      {sale.status === 'completed' && can('returnItems') && toCents(sale.returned) < toCents(sale.total) && <button className="btn secondary" onClick={() => setMode('return')} disabled={!data}>Return items</button>}
      {sale.status === 'completed' && can('voidSale') && toCents(sale.returned) === 0 && <button className="btn danger" onClick={() => setMode('void')}>Void</button>}
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
        {data.returns.length > 0 && <>
          <h3 style={{ marginTop: '1rem' }}>Returns</h3>
          {data.returns.map((r) => (
            <div className="row between" key={r.id}><span>{r.return_number} · {new Date(r.occurred_at).toLocaleDateString()} · {r.reason}</span>
              <span className="num">−{money(toCents(r.total))}{toCents(r.refund_amount) > 0 ? ` (refunded ${money(toCents(r.refund_amount))})` : ''}</span></div>))}
          <p className="muted small">A sale that has a return cannot be voided.</p>
        </>}
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
