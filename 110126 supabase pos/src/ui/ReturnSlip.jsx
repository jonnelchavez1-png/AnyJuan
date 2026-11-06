import { useState } from 'react';
import { Dialog } from './kit.jsx';
import { PAPERS, printHtml, remember } from '../lib/print.js';
import { formatQuantity, toMilli } from '../lib/money.js';
import { useApp } from './context.js';

/** The paper that goes with a return: what came back and what was given back. Prints like a receipt. */
export function ReturnSlipDialog({ slip, onClose }) {
  const { business, money } = useApp();
  const s = slip;
  const [paper, setPaper] = useState(() => (PAPERS[remember('pos.paper')] ? remember('pos.paper') : '80'));
  const print = () => { const node = document.getElementById('return-slip'); if (node) printHtml(node.outerHTML, { paper, title: s.return_number }); };
  return (
    <Dialog title="Return slip" onClose={onClose} actions={<>
      <label className="small paper-pick">Paper <select className="input" value={paper} aria-label="Paper size" onChange={(e) => { setPaper(e.target.value); remember('pos.paper', e.target.value); }}>{Object.entries(PAPERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      <button className="btn secondary" onClick={print}>Print slip</button>
      <button className="btn" onClick={onClose}>Done</button>
    </>}>
      <div className="receipt" id="return-slip">
        <h3>{business.name}</h3>
        {business.receipt_header && <div className="center">{business.receipt_header}</div>}
        <div className="center"><strong>RETURN SLIP</strong></div>
        <div className="center">{s.return_number} · for {s.invoice_number}</div>
        <div className="center">{new Date(s.occurred_at).toLocaleString(business.locale, { timeZone: business.timezone })}</div>
        <hr />
        {s.items.map((i, n) => (
          <div key={n}>
            <div>{i.name}{i.restocked === false ? ' (not put back in stock)' : ''}</div>
            <div className="line"><span>{formatQuantity(toMilli(i.quantity))}</span><span>{money(i.total)}</span></div>
          </div>
        ))}
        <hr />
        <div className="line"><span>Items before discount</span><span>{money(s.subtotal)}</span></div>
        {s.discount > 0 && <div className="line"><span>Discount</span><span>−{money(s.discount)}</span></div>}
        {s.taxMode !== 'none' && s.tax > 0 && <div className="line"><span>{s.taxName || 'Tax'}{s.taxMode === 'inclusive' ? ' (included)' : ''}</span><span>{money(s.tax)}</span></div>}
        <div className="line"><strong>TOTAL RETURNED</strong><strong>{money(s.total)}</strong></div>
        {s.refund > 0 ? <div className="line"><strong>REFUNDED{s.method ? ` · ${s.method}` : ''}</strong><strong>{money(s.refund)}</strong></div>
          : <div className="center">No money handed back{s.balanceAfter > 0 ? `. Balance still owed on the sale: ${money(s.balanceAfter)}` : ''}.</div>}
        <hr />
        <div className="center">Reason: {s.reason}</div>
      </div>
    </Dialog>
  );
}
