import { offline } from '../data/offline/manager.js';
import { useApp } from './context.js';
import { useOffline } from './useOffline.js';

/** One calm strip at the top of every screen that says what is going on with the internet and with waiting sales. */
export default function OfflineBar() {
  const s = useOffline();
  const { money, business } = useApp();
  const at = (t) => new Date(t).toLocaleTimeString(business.locale, { timeZone: business.timezone, hour: 'numeric', minute: '2-digit' });
  const n = (c, one, many) => `${c} ${c === 1 ? one : many}`;
  const rows = [];

  if (s.updateReady) rows.push({ key: 'upd', tone: '', text: 'A new version of the app is ready.', action: <button className="btn small" onClick={() => offline.reloadForUpdate()}>Reload now</button>, hint: 'Do this when you are not in the middle of a sale.' });
  if (s.ready && s.storage !== 'indexeddb') rows.push({ key: 'mem', tone: 'bad', text: 'This browser cannot keep sales on the device, so selling without internet is OFF here. Use a normal (not private) browser window.' });
  if (!s.online) {
    rows.push({
      key: 'off', tone: 'warn',
      text: 'No internet. You can keep selling: each sale is saved on this device and uploads by itself when the internet is back.',
      hint: s.staleAt ? `Reports and lists show what was saved at ${at(s.staleAt)}${s.waiting ? ` and do not include the ${n(s.waiting, 'sale', 'sales')} (${money(s.waitingCents)}) waiting on this device` : ''}.` : null,
    });
  }
  if (s.needsSignIn) rows.push({ key: 'auth', tone: 'bad', text: `Your sign-in has expired, so ${n(s.waiting, 'sale', 'sales')} could not upload. Sign out and sign in again. Nothing is lost.`, action: <button className="btn small" onClick={() => { window.location.hash = '#/account'; }}>Open My account</button> });
  else if (s.online && s.waiting > 0) rows.push({ key: 'up', tone: '', text: s.syncing ? `Uploading ${n(s.waiting, 'sale', 'sales')}…` : `${n(s.waiting, 'sale', 'sales')} (${money(s.waitingCents)}) waiting to upload.`, action: s.syncing ? null : <button className="btn small" onClick={() => offline.syncNow()}>Upload now</button> });
  if (s.failed > 0) rows.push({ key: 'fail', tone: 'bad', text: `${n(s.failed, 'sale', 'sales')} (${money(s.failedCents)}) could not be uploaded and need a person to look.`, action: <a className="btn small" href="#/offline">Look at them</a> });
  if (s.others > 0) rows.push({ key: 'oth', tone: 'warn', text: `${n(s.others, 'sale', 'sales')} made by someone else are waiting on this device. They upload when that person signs in here.`, action: <a className="btn small" href="#/offline">See them</a> });
  if (!rows.length) return null;
  return (
    <div className="offbar" role="status" aria-live="polite" data-testid="offline-bar">
      {rows.map((r) => (
        <div key={r.key} className={`offrow ${r.tone}`}>
          <div><span>{r.text}</span>{r.hint && <div className="small">{r.hint}</div>}</div>
          {r.action}
        </div>
      ))}
    </div>
  );
}
