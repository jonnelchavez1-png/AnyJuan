import { useEffect, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { Field, PasswordInput } from '../ui/kit.jsx';
import { checkPassword } from '../lib/password.js';
import { config } from '../config.js';
import { Brand } from '../ui/Brand.jsx';

export function SetupNeeded({ problem }) {
  return (
    <div className="auth"><div className="card stack">
      <Brand size="md" />
      <div className="notice bad" role="alert">{problem}</div>
      <p>To fix this, add these two settings where the app is hosted (for Netlify: Site configuration → Environment variables), then publish again:</p>
      <pre style={{ whiteSpace: 'pre-wrap', background: '#edf4f9', padding: '.6rem', borderRadius: 8 }}>
VITE_SUPABASE_URL{'\n'}VITE_SUPABASE_PUBLISHABLE_KEY</pre>
      <p className="muted small">Both are on your Supabase project under Project Settings → API. The step-by-step guide is in docs/SETUP.md.</p>
    </div></div>
  );
}

export function Login() {
  const [mode, setMode] = useState('in'); // in | up | reset
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'in') {
        await repo.signIn(email, password);
      } else if (mode === 'up') {
        if (!name.trim()) throw new Error('Please enter your name.');
        const weak = checkPassword(password, email);
        if (weak) throw new Error(weak);
        const res = await repo.signUp(email, password, name);
        setInfo(res?.session
          ? 'Account created. The owner must approve it before you can use the app.'
          : 'Account created. Check your email to confirm it, then sign in. The owner must approve it before you can use the app.');
        setMode('in');
      } else {
        await repo.resetPassword(email);
        setInfo('If that email has an account, a reset link is on its way.');
        setMode('in');
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  // The form lives on the laptop screen in the photo. It is designed 600px wide and scaled to whatever size that screen has on this device.
  const screenRef = useRef(null);
  const vsRef = useRef(null);
  useEffect(() => {
    const screen = screenRef.current; const vs = vsRef.current;
    if (!screen || !vs) return undefined;
    const fit = () => {
      if (getComputedStyle(vs).position === 'absolute') {
        const s = screen.clientWidth / 600;
        vs.style.setProperty('--s', s);
        vs.style.height = `${screen.clientHeight / s}px`;
      } else { vs.style.removeProperty('--s'); vs.style.height = ''; }
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(screen);
    return () => { window.removeEventListener('resize', fit); ro?.disconnect(); };
  }, []);

  return (
    <div className="login-stage">
      <div className="login-scene">
        <div className="login-photo" role="presentation" />
        <main className="login-screen" ref={screenRef}>
          <div className="login-vs" ref={vsRef}>
            <form className={`lcard${mode !== 'in' || error || info ? ' compact' : ''}`} onSubmit={submit} aria-label="Sign in">
              <Brand size="lg" as="h1" />
              <p className="lsub">{mode === 'in' ? 'Sign in to your business. Accounts are created by the owner.' : mode === 'up' ? 'Create an account' : 'Reset your password'}</p>
              {info && <div className="notice good" role="status">{info}</div>}
              {error && <div className="notice bad" role="alert">{error}</div>}
              {mode === 'up' && <Field label="Your name" id="name"><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></Field>}
              <Field label="Email" id="email"><input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
              {mode !== 'reset' && <Field label="Password" id="password" hint={mode === 'up' ? 'At least 8 characters.' : undefined}>
                <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required />
              </Field>}
              <button className="btn block" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create account' : 'Send reset link'}</button>
              <div className="lrow">
                {mode === 'in' ? <button type="button" className="btn ghost small" onClick={() => { setMode('reset'); setError(''); }}>Forgot password?</button> : <button type="button" className="btn ghost small" onClick={() => { setMode('in'); setError(''); }}>Back to sign in</button>}
                {mode === 'in' && config.allowSignup && <button type="button" className="btn ghost small" onClick={() => { setMode('up'); setError(''); }}>New staff account</button>}
              </div>
            </form>
          </div>
        </main>
        <aside className="login-info" aria-label="About AnyJuanPOS">
          <h2>Your business,<br />{' '}made <em>simpler.</em></h2>
          <p>Manage sales, expenses, and inventory with ease. Track discounts, taxes, and daily cash flow while keeping everything organized and documented. Your business keeps moving, even offline — all in one place.</p>
        </aside>
      </div>
    </div>
  );
}

export function Waiting({ email, onCheck, onSignOut, checking }) {
  return (
    <div className="auth"><div className="card stack">
      <Brand size="md" />
      <h1>Waiting for approval</h1>
      <p>You are signed in as <strong>{email}</strong>, but the owner has not switched your account on yet.</p>
      <p className="muted">Ask the owner to open <em>Team</em> and activate you, then press the button below.</p>
      <div className="row">
        <button className="btn" onClick={onCheck} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
        <button className="btn secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </div></div>
  );
}

/** Shown after someone clicks the reset link in their email: they choose a new password here. */
export function SetNewPassword({ onDone, onSignOut }) {
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async (e) => {
    e.preventDefault(); setError('');
    const weak = checkPassword(pw);
    if (weak) return setError(weak);
    if (pw !== pw2) return setError('The two passwords are not the same.');
    setBusy(true);
    try { await repo.updatePassword(pw); onDone(); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <div className="auth"><form className="card stack" onSubmit={save}>
      <Brand size="md" />
      <h1>Choose a new password</h1>
      <p className="muted">Pick a password only you know. At least 8 characters, with letters.</p>
      {error && <div className="notice bad" role="alert">{error}</div>}
      <Field label="New password" id="np1"><PasswordInput id="np1" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
      <Field label="Type it again" id="np2"><PasswordInput id="np2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required /></Field>
      <button className="btn block" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</button>
      <button type="button" className="btn ghost small" onClick={onSignOut}>Cancel and sign out</button>
    </form></div>
  );
}
