import { useState } from 'react';
import { useApp } from '../ui/context.js';
import { Badge, Dialog, ErrorBox, Field, PageHead } from '../ui/kit.jsx';

// Everything in this file is only used by accounts marked as "trial" (see supabase/update-trial.sql).
// Normal accounts never see any of it.

/** The bar at the top of every screen: says this is a trial, and holds the Start Fresh button. */
export function TrialBanner() {
  const { trial } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="trialbar" role="note">
        <div><strong>Trial mode.</strong> Everything you do here is temporary. It is deleted when you sign out, and the real business is never touched.</div>
        <button className="btn small" onClick={() => setOpen(true)}>Start Fresh</button>
      </div>
      {open && <StartFreshDialog onClose={() => setOpen(false)} onConfirm={trial.startFresh} />}
    </>
  );
}

export function StartFreshDialog({ onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await onConfirm(); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title="Start fresh?" onClose={busy ? undefined : onClose}
      actions={<>
        <button className="btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={go} disabled={busy}>{busy ? 'Working…' : 'Confirm and Start Fresh'}</button>
      </>}>
      <p>Are you sure you want to start fresh? Your current trial environment will be reset. All original sample business records will remain safe and unchanged.</p>
      <p className="muted small">You will get a clean, empty POS to try things out in: no products, customers or sales.</p>
      <ErrorBox error={error} />
    </Dialog>
  );
}

/** Shown when the temporary session ran out (about 4 hours without use, or the 24 hour limit). */
export function TrialEnded({ onSignOut }) {
  return (
    <div className="auth">
      <div className="card stack">
        <h2>Your trial session has ended</h2>
        <p>The temporary shop was deleted, as planned. Sign in again to start a new one.</p>
        <button className="btn" onClick={onSignOut}>Sign in again</button>
      </div>
    </div>
  );
}

/** Trial accounts cannot change the real business, but they can name THEIR trial shop. */
export function TrialNameCard() {
  const { business, trial, toast } = useApp();
  const [name, setName] = useState(business.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await trial.setName(name); toast('Saved', 'good'); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={save}>
      <h2>Business name</h2>
      <p className="muted small">This is the name shown on the screen and on receipts in your trial. It is only kept until you sign out.</p>
      <ErrorBox error={error} />
      <Field label="Business name" id="trial-name"><input id="trial-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
      <button className="btn" disabled={busy || !name.trim() || name.trim() === business.name}>{busy ? 'Saving…' : 'Save name'}</button>
    </form>
  );
}

// A made-up team so a trial user can see what the page looks like. It is not read from the database.
const SAMPLE_TEAM = [
  { name: 'Maria Santos', email: 'maria@example.com', role: 'Manager', active: true },
  { name: 'Juan Dela Cruz', email: 'juan@example.com', role: 'Cashier', active: true },
  { name: 'Ana Reyes', email: 'ana@example.com', role: 'Accountant', active: false },
];

/** The Team page for a trial account: you can look, but every control is switched off. */
export function TrialTeam() {
  const { profile } = useApp();
  return (
    <>
      <PageHead title="Team" />
      <div className="notice">You can look around this page, but trial accounts cannot add, change or switch off people. The people below are examples.</div>
      <div className="card table-wrap"><table>
        <thead><tr><th>Person</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          <tr>
            <td><strong>{profile.name}</strong> (you)<div className="small muted">{profile.email}</div></td>
            <td>Owner</td><td><Badge tone="good">Active</Badge></td><td className="right"><button className="btn small secondary" disabled>Switch off</button></td>
          </tr>
          {SAMPLE_TEAM.map((p) => (
            <tr key={p.email}>
              <td><strong>{p.name}</strong><div className="small muted">{p.email}</div></td>
              <td>{p.role}</td>
              <td>{p.active ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Waiting</Badge>}</td>
              <td className="right"><button className="btn small secondary" disabled>{p.active ? 'Switch off' : 'Activate'}</button></td>
            </tr>))}
        </tbody></table></div>
    </>
  );
}
