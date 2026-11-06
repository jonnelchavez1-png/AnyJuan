import { useEffect, useState } from 'react';
import { offline } from '../data/offline/manager.js';
import { repo } from '../data/repo.js';
import { toCents } from '../lib/money.js';
import { Badge, Dialog, ErrorBox, Field, Loading, PageHead, useLoad } from '../ui/kit.jsx';
import { useApp } from '../ui/context.js';
import { useOffline } from '../ui/useOffline.js';

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export default function Offline() {
  const { business, money, can, profile, toast } = useApp();
  const s = useOffline();
  const [entries, setEntries] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const fmt = (t) => new Date(t).toLocaleString(business.locale, { timeZone: business.timezone, dateStyle: 'medium', timeStyle: 'short' });
  const load = () => offline.entries().then(setEntries);
  useEffect(() => { load(); }, [s.waiting, s.failed, s.others, s.lastSyncAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const reviews = useLoad(() => (can('reviewOffline') ? repo.getSaleReviews(false) : Promise.resolve([])), [s.lastSyncAt]);

  const open = (entries || []).filter((e) => e.status !== 'done');
  const done = (entries || []).filter((e) => e.status === 'done').sort((a, b) => b.doneAt - a.doneAt);
  const backup = async () => { download(`pos-unsent-sales-${new Date().toISOString().slice(0, 10)}.json`, await offline.exportBackup()); toast('Backup file downloaded', 'good'); };
  const remove = async (e) => { download(`pos-removed-sale-${e.tempNumber}.json`, e); await offline.remove(e.id); setConfirm(null); toast('Removed (a backup file was downloaded first)', 'good'); };
  const kindLabel = { stock: 'Stock', price: 'Price', tax: 'Tax', discount: 'Discount', old: 'Late', inactive: 'Product off' };

  return (
    <>
      <PageHead title="Offline and sync">
        <button className="btn secondary small" onClick={() => offline.probe()}>Check connection</button>
        <button className="btn small" onClick={() => offline.syncNow()} disabled={!s.online || s.syncing || !s.waiting}>{s.syncing ? 'Uploading…' : 'Upload now'}</button>
      </PageHead>
      <div className="card">
        <p style={{ marginTop: 0 }}><strong>{s.online ? 'Online' : 'No internet'}.</strong> {s.waiting ? `${s.waiting} sale${s.waiting === 1 ? '' : 's'} (${money(s.waitingCents)}) waiting to upload.` : 'Nothing is waiting to upload.'} {s.lastSyncAt ? `Last upload: ${fmt(s.lastSyncAt)}.` : ''}</p>
        <p className="muted small" style={{ marginBottom: 0 }}>Without internet you can still open the app and sell. Each sale is saved on this device and uploads by itself, oldest first. Nothing is ever uploaded twice. Voids, returns, expenses, stock changes, new customers and the cash drawer need the internet.</p>
      </div>

      <div className="card table-wrap" style={{ marginTop: '.75rem' }}>
        <div className="row between"><h2>Saved on this device, not yet in the books</h2><button className="btn secondary small" onClick={backup} disabled={!open.length}>Download backup</button></div>
        {entries === null ? <Loading /> : !open.length ? <div className="empty">Nothing waiting. All sales from this device are uploaded.</div> : (
          <table>
            <thead><tr><th>Time</th><th>Receipt no.</th><th>Customer</th><th>Sold by</th><th className="right">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>{open.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmt(e.occurredAt)}</td><td className="nowrap">{e.tempNumber}</td><td>{e.customerName || 'Walk-in'}</td><td>{e.userName}</td>
                <td className="right num">{money(e.totalCents)}</td>
                <td>{e.status === 'failed' ? <><Badge tone="bad">Needs attention</Badge><div className="small">{e.message}</div></> : e.userId !== profile.id ? <Badge tone="warn">Waiting for {e.userName}</Badge> : <Badge tone="warn">Waiting to upload</Badge>}</td>
                <td className="right nowrap">
                  {e.status === 'failed' && <button className="btn secondary small" onClick={() => offline.retry(e.id)}>Try again</button>}{' '}
                  {e.userId !== profile.id && can('reviewOffline') && <button className="btn secondary small" onClick={() => offline.takeOver(e.id, `Sold by ${e.userName}, uploaded by ${profile.name}`)}>Upload under my name</button>}{' '}
                  {e.status === 'failed' && <button className="btn ghost small" onClick={() => setConfirm(e)}>Remove…</button>}
                </td>
              </tr>))}</tbody>
          </table>
        )}
      </div>

      {can('reviewOffline') && (
        <div className="card table-wrap" style={{ marginTop: '.75rem' }}>
          <h2>Offline sales to check</h2>
          <p className="muted small">These sales were uploaded, and they are in your books exactly as the customer was charged. Something differed from today&apos;s setting (price, tax, stock...) so a person should look once.</p>
          <ErrorBox error={reviews.error} onRetry={reviews.reload} />
          {reviews.loading && !reviews.data ? <Loading /> : !(reviews.data || []).length ? <div className="empty">Nothing to check.</div> : (
            <table>
              <thead><tr><th>Invoice</th><th>Sold</th><th>By</th><th className="right">Total</th><th>Why</th><th></th></tr></thead>
              <tbody>{reviews.data.map((r) => (
                <ReviewRow key={r.id} r={r} fmt={fmt} money={money} label={kindLabel[r.kind] || r.kind} onDone={() => { reviews.reload(); }} />))}</tbody>
            </table>
          )}
        </div>
      )}

      <div className="card table-wrap" style={{ marginTop: '.75rem' }}>
        <h2>Uploaded from this device (last 14 days)</h2>
        {!done.length ? <div className="empty">None yet.</div> : (
          <table>
            <thead><tr><th>Time</th><th>Receipt no.</th><th>Invoice no.</th><th className="right">Total</th><th>Uploaded</th></tr></thead>
            <tbody>{done.slice(0, 100).map((e) => (
              <tr key={e.id}><td className="nowrap">{fmt(e.occurredAt)}</td><td>{e.tempNumber}</td><td className="nowrap"><strong>{e.invoiceNumber}</strong></td><td className="right num">{money(e.totalCents)}</td><td className="nowrap">{fmt(e.doneAt)}{e.flagged ? ' · to check' : ''}</td></tr>))}</tbody>
          </table>
        )}
      </div>
      {confirm && (
        <Dialog title="Remove this sale from the device?" onClose={() => setConfirm(null)} actions={<><button className="btn secondary" onClick={() => setConfirm(null)}>Keep it</button><button className="btn" onClick={() => remove(confirm)}>Download backup and remove</button></>}>
          <p>This sale ({confirm.tempNumber}, {money(confirm.totalCents)}) was <strong>not</strong> uploaded: {confirm.message}</p>
          <p>If you remove it, it will not be in your sales. A backup file with all its details is downloaded first so it can be entered by hand if needed.</p>
        </Dialog>
      )}
    </>
  );
}

function ReviewRow({ r, fmt, money, label, onDone }) {
  const { toast } = useApp();
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const resolve = async () => { setBusy(true); try { await repo.resolveSaleReview(r.id, note); toast('Marked as checked', 'good'); onDone(); } catch (e) { toast(e.message, 'bad'); setBusy(false); } };
  return (
    <tr>
      <td className="nowrap"><strong>{r.invoice_number}</strong></td><td className="nowrap">{fmt(r.occurred_at)}</td><td>{r.cashier || ''}</td><td className="right num">{money(toCents(r.total))}</td>
      <td><Badge tone="warn">{label}</Badge><div className="small">{r.note}</div></td>
      <td className="nowrap"><input className="input" aria-label={`Note for ${r.invoice_number}`} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '9rem' }} /> <button className="btn secondary small" onClick={resolve} disabled={busy}>Mark checked</button></td>
    </tr>
  );
}
