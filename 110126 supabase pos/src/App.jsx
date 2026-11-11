import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { configProblem } from './config.js';
import { repo } from './data/repo.js';
import { formatMoney } from './lib/money.js';
import { AppContext, CAN } from './ui/context.js';
import { ErrorBox, Loading } from './ui/kit.jsx';
import { Login, SetNewPassword, SetupNeeded, Waiting } from './features/Auth.jsx';
import Account from './features/Account.jsx';
import Sell from './features/Sell.jsx';
import Sales from './features/Sales.jsx';
import Products from './features/Products.jsx';
import Expenses from './features/Expenses.jsx';
import Dashboard from './features/Dashboard.jsx';
import TaxReport from './features/TaxReport.jsx';
import Settings from './features/Settings.jsx';
import Team from './features/Team.jsx';
import Drawer from './features/Drawer.jsx';
import Offline from './features/Offline.jsx';
import OfflineBar from './ui/OfflineBar.jsx';
import { Brand } from './ui/Brand.jsx';
import { offline } from './data/offline/manager.js';
import { TrialBanner, TrialEnded, TrialTeam } from './features/Trial.jsx';

const ROUTES = [
  { path: 'dashboard', label: 'Dashboard', icon: '▤', can: 'viewDashboard', view: Dashboard },
  { path: 'sell', label: 'Sell', icon: '＋', can: 'sell', view: Sell },
  { path: 'sales', label: 'Sales', icon: '☰', can: 'viewSales', view: Sales },
  { path: 'drawer', label: 'Cash drawer', icon: '▭', can: 'viewDrawer', view: Drawer },
  { path: 'offline', label: 'Offline and sync', icon: '⇅', can: 'syncOffline', view: Offline },
  { path: 'products', label: 'Products', icon: '▣', can: null, view: Products },
  { path: 'tax', label: 'Tax report', icon: '％', can: 'viewDashboard', view: TaxReport },
  { path: 'expenses', label: 'Expenses', icon: '−', can: 'viewExpenses', view: Expenses },
  { path: 'settings', label: 'Settings', icon: '⚙', can: 'editLists', view: Settings },
  { path: 'team', label: 'Team', icon: '☺', can: 'manageStaff', view: Team },
  { path: 'account', label: 'My account', icon: '●', can: null, view: Account },
];

function useHash() {
  const read = () => (window.location.hash.replace(/^#\/?/, '') || '').split('?')[0];
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const on = () => setHash(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export default function App() {
  const problem = configProblem();
  if (problem) return <SetupNeeded problem={problem} />;
  return <Gate />;
}

/** Decides what to show: sign-in, waiting for approval, or the app. */
function Gate() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [profile, setProfile] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(false); // true after clicking a password-reset link

  useEffect(() => {
    let live = true;
    repo.getSession().then((s) => live && setSession(s)).catch((e) => { if (live) { setError(e.message); setSession(null); } });
    const off = repo.onAuthChange((s, event) => {
      if (!live) return;
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
    });
    return () => { live = false; off(); };
  }, []);

  const userId = session?.user?.id;
  useEffect(() => { if (userId) offline.setUser({ id: userId, email: session.user.email, name: profile?.name, role: profile?.role }); }, [userId, profile?.name, profile?.role]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadProfile = useCallback(async () => {
    if (!userId) { setProfile(null); return; }
    setChecking(true);
    try { setProfile(await repo.getProfile(userId)); setError(''); } catch (e) { setError(e.message); } finally { setChecking(false); }
  }, [userId]);
  useEffect(() => { loadProfile(); }, [loadProfile]);

  // Pick up a role or "active" change the owner made on the Team page, without the person having to sign in again.
  useEffect(() => {
    if (!userId) return undefined;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const p = await repo.getProfile(userId);
        setProfile((old) => (old && p && old.role === p.role && old.active === p.active && old.name === p.name ? old : p));
      } catch { /* offline for a moment: keep what we have */ }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 5 * 60 * 1000);
    return () => { document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); clearInterval(timer); };
  }, [userId]);

  if (session === undefined) return <Loading label="Starting…" />;
  if (session && recovery) return <SetNewPassword onDone={() => setRecovery(false)} onSignOut={() => { setRecovery(false); repo.signOut(); }} />;
  if (!session) return <><Login />{error && <div className="toasts"><div className="toast bad">{error}</div></div>}</>;
  if (error && !profile) return <div className="auth"><div className="card stack"><ErrorBox error={error} onRetry={loadProfile} /><button className="btn secondary" onClick={() => repo.signOut()}>Sign out</button></div></div>;
  if (!profile) return checking ? <Loading label="Checking your account…" /> : <Waiting email={session.user.email} onCheck={loadProfile} onSignOut={() => repo.signOut()} checking={checking} />;
  if (!profile.active) return <Waiting email={profile.email} onCheck={loadProfile} onSignOut={() => repo.signOut()} checking={checking} />;
  if (profile.account_type === 'trial') return <TrialGate user={session.user} profile={profile} />;
  return <Shell user={session.user} profile={profile} />;
}

/** Trial accounts: get (or make) this person's temporary shop before showing the app, and keep it alive while they use it. */
function TrialGate({ user, profile }) {
  const [trial, setTrial] = useState(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const begin = useCallback(async () => {
    setError('');
    try { repo.setTrialMode(true); await offline.clearCache(); setTrial(await repo.trialBegin()); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { begin(); }, [begin]);
  useEffect(() => {
    if (!trial) return undefined;
    const beat = async () => {
      if (document.visibilityState === 'hidden') return;
      try { setTrial(await repo.trialHeartbeat()); } catch (e) { if (/session has ended/i.test(e.message)) setEnded(true); /* offline for a moment: try again later */ }
    };
    document.addEventListener('visibilitychange', beat); window.addEventListener('focus', beat);
    const id = setInterval(beat, 5 * 60 * 1000);
    return () => { document.removeEventListener('visibilitychange', beat); window.removeEventListener('focus', beat); clearInterval(id); };
  }, [!!trial]); // eslint-disable-line react-hooks/exhaustive-deps
  if (ended) return <TrialEnded onSignOut={() => repo.signOut()} />;
  if (error && !trial) return <div className="auth"><div className="card stack"><ErrorBox error={error} onRetry={begin} /><button className="btn secondary" onClick={() => repo.signOut()}>Sign out</button></div></div>;
  if (!trial) return <Loading label="Getting your trial shop ready…" />;
  return <Shell user={user} profile={profile} trial={trial} onTrialChange={setTrial} />;
}

function Shell({ user, profile, trial, onTrialChange }) {
  const [base, setBase] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [period, setPeriod] = useState({ preset: 'month', custom: null }); // shared by Dashboard, Sales, Expenses, Tax report
  const [tick, setTick] = useState(0); // bumped after an upload so the open screen re-reads its numbers
  const hash = useHash();
  const trialRef = useRef(trial);
  trialRef.current = trial;

  const loadBase = useCallback(async () => {
    try {
      const [business, categories, expenseCategories, channels, methods, products, customers] = await Promise.all([
        repo.getBusiness(), repo.listLookup('categories'), repo.listLookup('expense_categories'),
        repo.listLookup('sales_channels'), repo.listLookup('payment_methods'), repo.listProducts(), repo.listCustomers(),
      ]);
      if (!business) throw new Error('The business record is missing. Run supabase/setup.sql first.');
      const shownName = trialRef.current?.business_name; // a trial shop shows the name its user typed (the real record is never changed)
      setBase({ business: shownName ? { ...business, name: shownName } : business, categories, expenseCategories, channels, methods, products, customers });
      setLoadError('');
    } catch (e) { setLoadError(e.message); }
  }, []);
  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => offline.onSynced((r) => {
    loadBase();
    if (window.location.hash.replace(/^#\/?/, '') !== 'sell') setTick((t) => t + 1); // never rebuild the Sell screen: it may hold a sale in progress
    toastRef.current?.(`${r.sent} offline sale${r.sent === 1 ? '' : 's'} uploaded`, 'good');
  }), [loadBase]);

  // Keep every device in step with the others: when the window comes back into view, and every 90 seconds while it is open,
  // read the shared lists again (products, stock, customers...). Read-only screens (Dashboard, Sales, Tax report) are redrawn too,
  // but never while a window is open or a box is being typed in, and never the Sell screen.
  useEffect(() => {
    let last = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || offline.isOffline() || Date.now() - last < 5000) return;
      last = Date.now();
      loadBase();
      const route = window.location.hash.replace(/^#\/?/, '');
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (['dashboard', 'sales', 'tax'].includes(route) && !typing && !document.querySelector('[role="dialog"]')) setTick((t) => t + 1);
    };
    const id = setInterval(refresh, 90000);
    document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); };
  }, [loadBase]);

  const toastRef = useRef(null);
  const toast = useCallback((message, tone = '') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);

  useEffect(() => { toastRef.current = toast; }, [toast]);

  const role = profile.role;
  const can = useCallback((action) => (CAN[action] || []).includes(role), [role]);
  const allowed = ROUTES.filter((r) => !r.can || can(r.can));
  const route = allowed.find((r) => r.path === hash) || allowed[0];

  useEffect(() => { setMenuOpen(false); }, [hash]);
  useEffect(() => {
    document.title = base ? `${route?.label || 'App'} · ${base.business.name}` : 'AnyJuanPOS';
  }, [route, base]);

  const business = base?.business;
  const money = useCallback(
    (cents) => formatMoney(cents, { currency: business?.currency || 'PHP', locale: business?.locale || 'en-PH' }),
    [business?.currency, business?.locale],
  );

  // Trial accounts only: the Start Fresh button and the trial shop's own business name.
  const trialCtx = useMemo(() => (trial ? {
    session: trial,
    startFresh: async () => {
      const t = await repo.trialStartFresh();
      trialRef.current = t; onTrialChange(t);
      await offline.clearCache();
      window.location.hash = '#/dashboard';
      await loadBase(); setTick((x) => x + 1);
      toast('Fresh start: your trial shop is now empty.', 'good');
    },
    setName: async (name) => { const t = await repo.trialSetBusinessName(name); trialRef.current = t; onTrialChange(t); await loadBase(); },
  } : null), [trial, onTrialChange, loadBase, toast]);

  const ctx = useMemo(() => base && ({ ...base, user, profile, role, can, toast, money, period, setPeriod, reload: loadBase, trial: trialCtx }), [base, user, profile, role, can, toast, money, period, loadBase, trialCtx]);

  if (loadError) return <div className="auth"><div className="card stack"><ErrorBox error={loadError} onRetry={loadBase} /><button className="btn secondary" onClick={() => repo.signOut()}>Sign out</button></div></div>;
  if (!ctx) return <Loading label="Loading your business…" />;

  const View = trial && route.path === 'team' ? TrialTeam : route.view; // trial accounts may look at the Team page but not change anything
  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <button className="btn small" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-controls="sidebar">☰ Menu</button>
          <Brand size="sm" tone="dark" byline={false} />
          <strong className="bm-biz">{business.name}</strong>
        </header>
        <aside id="sidebar" className={`sidebar ${menuOpen ? 'open' : ''}`}>
          <div className="side-brand"><Brand size="md" tone="dark" /><div className="biz">{business.name}</div></div>
          <nav className="nav" aria-label="Main">
            {allowed.map((r) => (
              <a key={r.path} href={`#/${r.path}`} aria-current={r === route ? 'page' : undefined}><span aria-hidden="true">{r.icon}</span>{r.label}</a>
            ))}
          </nav>
          <div className="who">{profile.name}<br /><span style={{ textTransform: 'capitalize' }}>{trial ? 'Trial account' : role}</span></div>
          <button className="btn ghost small" onClick={() => repo.signOut()}>Sign out</button>
        </aside>
        <main className="main" id="main">{trial && <TrialBanner />}<OfflineBar /><View key={`${route.path}-${tick}`} /></main>
      </div>
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.message}</div>)}</div>
    </AppContext.Provider>
  );
}
