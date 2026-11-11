import { useState } from 'react';
import { repo } from '../data/repo.js';
import { checkPassword } from '../lib/password.js';
import { useApp } from '../ui/context.js';
import { Badge, Field, PageHead, PasswordInput } from '../ui/kit.jsx';

export default function Account() {
  const { profile, user, toast, trial } = useApp();
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault(); setError('');
    const weak = checkPassword(pw, user.email);
    if (weak) return setError(weak);
    if (pw !== pw2) return setError('The two passwords are not the same.');
    setBusy(true);
    try { await repo.updatePassword(pw); setPw(''); setPw2(''); toast('Password changed', 'good'); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHead title="My account" />
      <div className="panels">
        <section className="card"><h2>You</h2>
          <p style={{ marginTop: '.6rem' }}><strong>{profile.name}</strong></p>
          <p className="muted">{user.email}</p>
          <p><Badge tone="good">{profile.role}</Badge></p>
        </section>
        {trial ? (
          <section className="card"><h2>Change my password</h2>
            <p className="muted">The password is locked on trial accounts, so the same trial login keeps working for the next person. Real accounts can change their password here.</p>
          </section>
        ) : (
        <form className="card" onSubmit={save}><h2>Change my password</h2>
          <p className="muted small">Use at least 8 characters with letters. Do not reuse a password from another website.</p>
          {error && <div className="notice bad" role="alert">{error}</div>}
          <Field label="New password" id="acc1"><PasswordInput id="acc1" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="Type it again" id="acc2"><PasswordInput id="acc2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
          <button className="btn" disabled={busy || !pw}>{busy ? 'Saving…' : 'Save new password'}</button>
        </form>
        )}
      </div>
    </>
  );
}
