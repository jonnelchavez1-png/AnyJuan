import { useState } from 'react';
import { Dialog } from './kit.jsx';
import { PAPERS, printHtml, remember } from '../lib/print.js';
import { formatQuantity, toMilli } from '../lib/money.js';
import { useApp } from './context.js';

/** Turn a receipt into plain text (for copying into a message or email). */
export function receiptText(r, business, money) {
  const L = [];
  L.push(business.name);
  if (business.receipt_header) L.push(business.receipt_header);
  L.push(`${r.invoice_number}  ${new Date(r.occurred_at).toLocaleString(business.locale, { timeZone: business.timezone })}`);
  if (r.customer) L.push(`Customer: ${r.customer}`);
  L.push('--------------------------------');
  for (const i of r.items) L.push(`${i.name}\n  ${formatQuantity(toMilli(i.quantity))} x ${money(i.unitPrice)} = ${money(i.gross)}`);
  L.push('--------------------------------');
  L.push(`Subtotal: ${money(r.subtotal)}`);
  if (r.discount > 0) L.push(`Discount: -${money(r.discount)}`);
  if (r.taxMode !== 'none') L.push(`${r.taxName || 'Tax'} ${r.taxRate}%${r.taxMode === 'inclusive' ? ' (included)' : ''}: ${money(r.tax)}`);
  L.push(`TOTAL: ${money(r.total)}`);
  for (const p of r.payments) L.push(`Paid (${p.method}): ${money(p.amount)}`);
  if (r.received != null) L.push(`Cash received: ${money(r.received)}`);
  if (r.change != null) L.push(`Change: ${money(r.change)}`);
  if (r.balance > 0) L.push(`BALANCE DUE: ${money(r.balance)}`);
  if (business.receipt_footer) L.push('', business.receipt_footer);
  return L.join('\n');
}

export function ReceiptDialog({ receipt, onClose }) {
  const { business, money, toast } = useApp();
  const r = receipt;
  const [paper, setPaper] = useState(() => (PAPERS[remember('pos.paper')] ? remember('pos.paper') : '80'));
  const print = () => {
    const node = document.getElementById('receipt');
    if (node) printHtml(node.outerHTML, { paper, title: r.invoice_number });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(receiptText(r, business, money)); toast('Receipt copied', 'good'); }
    catch { toast('Could not copy. Use Print instead.', 'bad'); }
  };
  return (
    <Dialog title="Receipt" onClose={onClose} actions={<>
      <button className="btn secondary" onClick={copy}>Copy text</button>
      <label className="small paper-pick">Paper <select className="input" value={paper} aria-label="Paper size" onChange={(e) => { setPaper(e.target.value); remember('pos.paper', e.target.value); }}>{Object.entries(PAPERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      <button className="btn secondary" onClick={print}>Print receipt</button>
      <button className="btn" onClick={onClose}>Done</button>
    </>}>
      <div className="receipt" id="receipt">
        <h3>{business.name}</h3>
        {business.receipt_header && <div className="center">{business.receipt_header}</div>}
        <div className="center">{r.invoice_number}</div>
        <div className="center">{new Date(r.occurred_at).toLocaleString(business.locale, { timeZone: business.timezone })}</div>
        {r.customer && <div className="center">Customer: {r.customer}</div>}
        {r.status === 'voided' && <div className="center"><strong>*** VOIDED ***</strong></div>}
        <hr />
        {r.items.map((i, n) => (
          <div key={n}>
            <div>{i.name}</div>
            <div className="line"><span>{formatQuantity(toMilli(i.quantity))} × {money(i.unitPrice)}</span><span>{money(i.gross)}</span></div>
          </div>
        ))}
        <hr />
        <div className="line"><span>Subtotal</span><span>{money(r.subtotal)}</span></div>
        {r.discount > 0 && <div className="line"><span>Discount</span><span>−{money(r.discount)}</span></div>}
        {r.taxMode !== 'none' && <div className="line"><span>{r.taxName || 'Tax'} {r.taxRate}%{r.taxMode === 'inclusive' ? ' (included)' : ''}</span><span>{money(r.tax)}</span></div>}
        <div className="line"><strong>TOTAL</strong><strong>{money(r.total)}</strong></div>
        {r.payments.map((p, n) => <div className="line" key={n}><span>Paid · {p.method}</span><span>{money(p.amount)}</span></div>)}
        {r.received != null && <div className="line"><span>Cash received</span><span>{money(r.received)}</span></div>}
        {r.change != null && <div className="line"><strong>Change</strong><strong>{money(r.change)}</strong></div>}
        {r.balance > 0 && <div className="line"><strong>BALANCE DUE</strong><strong>{money(r.balance)}</strong></div>}
        {business.receipt_footer && <><hr /><div className="center">{business.receipt_footer}</div></>}
      </div>
    </Dialog>
  );
}
