import { useEffect, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { describeDifference, differenceText, expectedFromFigures, isDrawerMissing } from '../lib/drawer.js';
import { newId } from '../lib/ids.js';
import { fromCents, parseAmount, toCents } from '../lib/money.js';
import { printHtml } from '../lib/print.js';
import { useApp } from '../ui/context.js';
import { Badge, Dialog, ErrorBox, Field, Loading, PageHead, Tip, useLoad } from '../ui/kit.jsx';

/** One place to say it: the drawer is not part of selling. Sales, returns, the dashboard and the tax report never read these figures. */
export default function Drawer() {
  const { can, business, money } = useApp();
  const [limit, setLimit] = useState(60);
  const current = useLoad(() => repo.currentShift(), []);
  const history = useLoad(() => repo.listShifts(limit), [limit]);
  const [dialog, setDialog] = useState(null); // 'open' | 'in' | 'out' | 'close'
  const [detail, setDetail] = useState(null);
  const canUse = can('useDrawer');
  const reloadAll = () => { current.reload(); history.reload(); };

  // Keep the numbers fresh: when the tab comes back into view and once a minute while a shift is open.
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible') current.reload(); };
    document.addEventListener('visibilitychange', on);
    const timer = setInterval(on, 60000);
    return () => { document.removeEventListener('visibilitychange', on); clearInterval(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString(business.locale, { timeZone: business.timezone, dateStyle: 'medium', timeStyle: 'short' }) : '');
  const m = (v) => money(toCents(v));

  if (current.error && isDrawerMissing(current.error)) {
    return (
      <>
        <PageHead title="Cash drawer" />
        <div className="notice">The cash drawer is not switched on yet. The owner needs to run the file <strong>update-drawer.sql</strong> once in Supabase (SQL Editor). Selling is not affected.</div>
      </>
    );
  }

  const cur = current.data;
  return (
    <>
      <PageHead title="Cash drawer">
        <button className="btn secondary small" onClick={reloadAll}>Refresh</button>
        {!cur && !current.loading && canUse && <button className="btn" onClick={() => setDialog('open')}>Open shift</button>}
      </PageHead>
      <p className="muted small" style={{ marginTop: 0 }}>Count the cash in the drawer when you start and when you finish. This page only keeps track of cash. It never changes your sales, returns, dashboard or tax report.</p>
      <ErrorBox error={current.error} onRetry={current.reload} />
      {current.loading && !cur && !current.error ? <Loading /> : null}

      {!cur && !current.loading && !current.error && (
        <div className="card"><h2>No shift is open</h2>
          <p className="muted">{canUse ? 'Press “Open shift” and type the cash you are starting with (what you counted in the drawer).' : 'Ask the owner, a manager or a cashier to open a shift.'}</p>
          <p className="muted small">You can keep selling without a shift. A shift only helps you check the cash at the end of the day.</p>
        </div>
      )}

      {cur && (
        <OpenShift cur={cur} m={m} fmt={fmt} canUse={canUse} onCashIn={() => setDialog('in')} onCashOut={() => setDialog('out')} onClose={() => setDialog('close')} />
      )}

      <div className="card table-wrap" style={{ marginTop: '.75rem' }}>
        <h2>Past shifts</h2>
        <ErrorBox error={history.error} onRetry={history.reload} />
        {history.loading && !history.data ? <Loading /> : !(history.data || []).filter((s) => s.closed_at).length ? <div className="empty">No closed shifts yet.</div> : (
          <table>
            <thead><tr><th>Shift</th><th>Opened</th><th>Closed</th><th className="right">Starting</th><th className="right">Expected</th><th className="right">Counted</th><th>Result</th><th></th></tr></thead>
            <tbody>{history.data.filter((s) => s.closed_at).map((s) => {
              const diff = describeDifference(toCents(s.expected_cash), toCents(s.counted_cash));
              return (
                <tr key={s.id}>
                  <td className="nowrap">{s.shift_number}</td><td className="nowrap">{fmt(s.opened_at)}</td><td className="nowrap">{fmt(s.closed_at)}</td>
                  <td className="right num">{m(s.opening_cash)}</td><td className="right num">{m(s.expected_cash)}</td><td className="right num">{m(s.counted_cash)}</td>
                  <td><Badge tone={diff.kind === 'balanced' ? 'good' : 'warn'}>{differenceText(diff, money)}</Badge></td>
                  <td className="right"><button className="btn ghost small" onClick={() => setDetail(s.id)}>Details</button></td>
                </tr>);
            })}</tbody>
          </table>
        )}
        {history.data?.length >= limit && <button className="btn secondary small" style={{ marginTop: '.5rem' }} onClick={() => setLimit((n) => n + 60)}>Show older shifts</button>}
      </div>

      {dialog === 'open' && <OpenDialog onClose={() => setDialog(null)} onDone={() => { setDialog(null); reloadAll(); }} />}
      {(dialog === 'in' || dialog === 'out') && <MoveDialog kind={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reloadAll(); }} />}
      {dialog === 'close' && cur && <CloseDialog cur={cur} onClose={() => setDialog(null)} onDone={(id) => { setDialog(null); reloadAll(); setDetail(id); }} />}
      {detail && <DetailDialog id={detail} fmt={fmt} onClose={() => setDetail(null)} />}
    </>
  );
}

/** The sum, line by line, so anyone can see where "expected cash" comes from. */
function FigureLines({ f, m, cur }) {
  const rows = [
    ['Starting cash', f.opening_cash, ''],
    [`Cash received${f.sales_paid ? ` (${f.sales_paid} sale${f.sales_paid === 1 ? '' : 's'})` : ''}`, f.cash_received, '+'],
    [`Cash refunded${f.returns ? ` (${f.returns} return${f.returns === 1 ? '' : 's'})` : ''}`, f.cash_refunded, '−'],
    ['Cash put in', f.cash_in, '+'],
    ['Cash taken out', f.cash_out, '−'],
  ];
  return (
    <div className="stack" style={{ gap: '.25rem' }}>
      {rows.map(([label, v, sign]) => (
        <div className="row between small" key={label}><span>{sign && <span aria-hidden="true">{sign} </span>}{label}</span><span className="num">{m(v)}</span></div>
      ))}
      <div className="row between" style={{ borderTop: '1px solid var(--line, #8884)', paddingTop: '.35rem' }}><strong>Should be in the drawer</strong><strong className="num" data-testid="expected-cash">{m(f.expected_cash)}</strong></div>
      {f.other_methods?.length > 0 && (
        <div className="muted small" style={{ marginTop: '.35rem' }}>Not cash (not in the drawer): {f.other_methods.map((o) => `${o.method} ${m(o.amount)}`).join(' · ')}</div>
      )}
      {toCents(f.voided_cash) > 0 && (
        <div className="notice small" style={{ marginTop: '.35rem' }}>{m(f.voided_cash)} of the cash received belongs to sales that were voided later. The money did come in, so it is still counted here. If you handed it back, record it as “Cash out”.</div>
      )}
      {cur && expectedFromFigures(f) !== toCents(f.expected_cash) && <div className="notice bad" role="alert">The lines above do not add up to the total. Please tell the owner.</div>}
    </div>
  );
}

function OpenShift({ cur, m, fmt, canUse, onCashIn, onCashOut, onClose }) {
  const s = cur.shift; const f = cur.figures;
  return (
    <div className="panels">
      <div className="card">
        <div className="row between"><h2 style={{ margin: 0 }}>Shift open <Badge tone="good">{s.shift_number}</Badge></h2></div>
        <p className="muted small">Opened by {cur.opened_by_name || 'someone'} · {fmt(s.opened_at)}{s.open_note ? ` · “${s.open_note}”` : ''}</p>
        <div className="num" style={{ fontSize: '1.8rem', fontWeight: 800 }}>{m(f.expected_cash)}</div>
        <div className="muted small" style={{ marginBottom: '.5rem' }}>should be in the drawer right now <Tip text="Starting cash, plus cash you received from customers, minus cash you gave back as refunds, plus cash you put in, minus cash you took out." /></div>
        <FigureLines f={f} m={m} cur />
        {canUse && (
          <div className="row" style={{ marginTop: '.75rem', flexWrap: 'wrap' }}>
            <button className="btn secondary" onClick={onCashIn}>＋ Cash in</button>
            <button className="btn secondary" onClick={onCashOut}>－ Cash out</button>
            <button className="btn" onClick={onClose}>Close shift</button>
          </div>
        )}
      </div>
      <div className="card table-wrap"><h2>Cash in and out</h2>
        {!cur.movements.length ? <p className="muted">Nothing yet. Use this for money you add to the drawer (change from the bank) or take out (paying a supplier, handing refunded cash back).</p> : (
          <table><thead><tr><th>Time</th><th>What for</th><th className="right">Amount</th></tr></thead>
            <tbody>{cur.movements.map((c) => (
              <tr key={c.id}><td className="nowrap">{fmt(c.created_at)}</td><td>{c.reason}</td><td className="right num nowrap">{c.kind === 'in' ? '+' : '−'} {m(c.amount)}</td></tr>))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function useForm(initial) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return { f, set, busy, setBusy, error, setError };
}

function OpenDialog({ onClose, onDone }) {
  const { toast } = useApp();
  const idRef = useRef(newId());
  const { f, set, busy, setBusy, error, setError } = useForm({ cash: '', note: '' });
  const save = async () => {
    const cents = parseAmount(f.cash);
    if (cents == null) return setError('Type the cash you are starting with, for example 500 or 0.');
    setBusy(true); setError('');
    try { await repo.openShift({ id: idRef.current, opening_cash: fromCents(cents), note: f.note.trim() || null }); toast('Shift opened', 'good'); onDone(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title="Open shift" onClose={onClose} actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Opening…' : 'Open shift'}</button></>}>
      <Field label="Cash in the drawer right now" id="oc" hint="Count the bills and coins, then type the total. Type 0 if the drawer is empty."><input id="oc" className="input" inputMode="decimal" value={f.cash} onChange={set('cash')} autoComplete="off" /></Field>
      <Field label="Note (optional)" id="on"><input id="on" className="input" value={f.note} onChange={set('note')} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}

function MoveDialog({ kind, onClose, onDone }) {
  const { toast, money } = useApp();
  const idRef = useRef(newId());
  const { f, set, busy, setBusy, error, setError } = useForm({ amount: '', reason: '' });
  const save = async () => {
    const cents = parseAmount(f.amount);
    if (!cents) return setError('Enter an amount above zero.');
    if (!f.reason.trim()) return setError('Please write what the cash was for.');
    setBusy(true); setError('');
    try { await repo.addCashMovement({ id: idRef.current, kind, amount: fromCents(cents), reason: f.reason.trim() }); toast(`${kind === 'in' ? 'Cash put in' : 'Cash taken out'}: ${money(cents)}`, 'good'); onDone(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title={kind === 'in' ? 'Put cash in the drawer' : 'Take cash out of the drawer'} onClose={onClose} actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <Field label="Amount" id="ma"><input id="ma" className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} autoComplete="off" /></Field>
      <Field label="What is it for?" id="mr" hint={kind === 'in' ? 'For example: change from the bank.' : 'For example: paid the ice supplier, or handed back cash for a voided sale.'}><input id="mr" className="input" value={f.reason} onChange={set('reason')} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}

function CloseDialog({ cur, onClose, onDone }) {
  const { toast, money } = useApp();
  const { f, set, busy, setBusy, error, setError } = useForm({ counted: '', note: '' });
  const expected = toCents(cur.figures.expected_cash);
  const counted = parseAmount(f.counted);
  const diff = counted == null ? null : describeDifference(expected, counted);
  const save = async () => {
    if (counted == null) return setError('Count the cash in the drawer and type the total (0 if empty).');
    if (diff.kind !== 'balanced' && !f.note.trim()) return setError(`The count is ${differenceText(diff, money).toLowerCase()}. Please write a note that explains it.`);
    setBusy(true); setError('');
    try { const r = await repo.closeShift(cur.shift.id, fromCents(counted), f.note.trim() || null); toast('Shift closed', 'good'); onDone(r.shift_id || cur.shift.id); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title="Close shift" onClose={onClose} actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Closing…' : 'Close shift'}</button></>}>
      <p>The drawer should have <strong className="num">{money(expected)}</strong>. Count the cash and type what you really have.</p>
      <Field label="Cash counted" id="cc"><input id="cc" className="input" inputMode="decimal" value={f.counted} onChange={set('counted')} autoComplete="off" /></Field>
      {diff && <div className={`notice ${diff.kind === 'balanced' ? '' : 'bad'}`} role="status" data-testid="diff-text">{diff.kind === 'balanced' ? 'Balanced. The drawer matches.' : `${differenceText(diff, money)}. Please explain below.`}</div>}
      <Field label={diff && diff.kind !== 'balanced' ? 'Note (required)' : 'Note (optional)'} id="cn"><input id="cn" className="input" value={f.note} onChange={set('note')} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}

function DetailDialog({ id, fmt, onClose }) {
  const { business, money } = useApp();
  const ref = useRef(null);
  const { data, error, loading } = useLoad(() => repo.getShift(id), [id]);
  const m = (v) => money(toCents(v));
  const s = data?.shift; const f = data?.figures;
  const diff = s?.closed_at ? describeDifference(toCents(s.expected_cash), toCents(s.counted_cash)) : null;
  const print = () => printHtml(ref.current.outerHTML, { title: 'Cash drawer report', css: '@page { margin: 12mm; } body { width: auto; font: 12px/1.45 system-ui, sans-serif; } h2, h3 { text-align: left; } .line { padding: 1px 0; }' });
  return (
    <Dialog title="Cash drawer report" onClose={onClose} wide actions={<><button className="btn secondary" onClick={print} disabled={!data}>Print</button><button className="btn" onClick={onClose}>Close</button></>}>
      <ErrorBox error={error} />
      {loading && !data ? <Loading /> : data && (
        <div ref={ref}>
          <h3 style={{ margin: 0 }}>{business.name} · Cash drawer report</h3>
          <p className="muted small" style={{ marginTop: '.2rem' }}>{s.shift_number} · opened {fmt(s.opened_at)} by {data.opened_by_name || '—'}{s.closed_at ? ` · closed ${fmt(s.closed_at)} by ${data.closed_by_name || '—'}` : ' · still open'}</p>
          <div className="stack" style={{ gap: '.25rem' }}>
            <div className="line"><span>Starting cash</span><span className="num">{m(f.opening_cash)}</span></div>
            <div className="line"><span>+ Cash received{f.sales_paid ? ` (${f.sales_paid} sale${f.sales_paid === 1 ? '' : 's'})` : ''}</span><span className="num">{m(f.cash_received)}</span></div>
            <div className="line"><span>− Cash refunded{f.returns ? ` (${f.returns} return${f.returns === 1 ? '' : 's'})` : ''}</span><span className="num">{m(f.cash_refunded)}</span></div>
            <div className="line"><span>+ Cash put in</span><span className="num">{m(f.cash_in)}</span></div>
            <div className="line"><span>− Cash taken out</span><span className="num">{m(f.cash_out)}</span></div>
            <div className="line"><strong>Should be in the drawer</strong><strong className="num">{m(f.expected_cash)}</strong></div>
            {s.closed_at && <div className="line"><strong>Cash counted</strong><strong className="num">{m(s.counted_cash)}</strong></div>}
            {diff && <div className="line"><strong>Result</strong><strong>{differenceText(diff, money)}</strong></div>}
          </div>
          {f.other_methods?.length > 0 && <p className="small">Not cash: {f.other_methods.map((o) => `${o.method} ${m(o.amount)}`).join(' · ')}{toCents(f.other_refunded) > 0 ? ` · refunded by other methods ${m(f.other_refunded)}` : ''}</p>}
          {toCents(f.voided_cash) > 0 && <p className="small">Includes {m(f.voided_cash)} cash from sales voided later (the money did come in).</p>}
          {s.open_note && <p className="small">Opening note: {s.open_note}</p>}
          {s.close_note && <p className="small">Closing note: {s.close_note}</p>}
          {data.movements.length > 0 && (
            <table><thead><tr><th>Time</th><th>Cash in / out</th><th className="right">Amount</th></tr></thead>
              <tbody>{data.movements.map((c) => <tr key={c.id}><td>{fmt(c.created_at)}</td><td>{c.reason}</td><td className="right num nowrap">{c.kind === 'in' ? '+' : '−'} {m(c.amount)}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
    </Dialog>
  );
}
