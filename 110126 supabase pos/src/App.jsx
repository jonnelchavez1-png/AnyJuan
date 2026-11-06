import { useCallback, useEffect, useMemo, useState } from 'react';
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

const ROUTES = [
  { path: 'dashboard', label: 'Dashboard', icon: '▤', can: 'viewDashboard', view: Dashboard },
  { path: 'sell', label: 'Sell', icon: '＋', can: 'sell', view: Sell },
  { path: 'sales', label: 'Sales', icon: '☰', can: 'viewSales', view: Sales },
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
  return <Shell user={session.user} profile={profile} />;
}

function Shell({ user, profile }) {
  const [base, setBase] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [period, setPeriod] = useState({ preset: 'month', custom: null }); // shared by Dashboard, Sales, Expenses, Tax report
  const hash = useHash();

  const loadBase = useCallback(async () => {
    try {
      const [business, categories, expenseCategories, channels, methods, products, customers] = await Promise.all([
        repo.getBusiness(), repo.listLookup('categories'), repo.listLookup('expense_categories'),
        repo.listLookup('sales_channels'), repo.listLookup('payment_methods'), repo.listProducts(), repo.listCustomers(),
      ]);
      if (!business) throw new Error('The business record is missing. Run supabase/setup.sql first.');
      setBase({ business, categories, expenseCategories, channels, methods, products, customers });
      setLoadError('');
    } catch (e) { setLoadError(e.message); }
  }, []);
  useEffect(() => { loadBase(); }, [loadBase]);

  const toast = useCallback((message, tone = '') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);

  const role = profile.role;
  const can = useCallback((action) => (CAN[action] || []).includes(role), [role]);
  const allowed = ROUTES.filter((r) => !r.can || can(r.can));
  const route = allowed.find((r) => r.path === hash) || allowed[0];

  useEffect(() => { setMenuOpen(false); }, [hash]);
  useEffect(() => {
    document.title = base ? `${route?.label || 'App'} · ${base.business.name}` : 'Retailer POS';
  }, [route, base]);

  const business = base?.business;
  const money = useCallback(
    (cents) => formatMoney(cents, { currency: business?.currency || 'PHP', locale: business?.locale || 'en-PH' }),
    [business?.currency, business?.locale],
  );

  const ctx = useMemo(() => base && ({ ...base, user, profile, role, can, toast, money, period, setPeriod, reload: loadBase }), [base, user, profile, role, can, toast, money, period, loadBase]);

  if (loadError) return <div className="auth"><div className="card stack"><ErrorBox error={loadError} onRetry={loadBase} /><button className="btn secondary" onClick={() => repo.signOut()}>Sign out</button></div></div>;
  if (!ctx) return <Loading label="Loading your business…" />;

  const View = route.view;
  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <button className="btn small" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-controls="sidebar">☰ Menu</button>
          <strong>{business.name}</strong>
        </header>
        <aside id="sidebar" className={`sidebar ${menuOpen ? 'open' : ''}`}>
          <div className="brand">{business.name}<small>Retailer POS</small></div>
          <nav className="nav" aria-label="Main">
            {allowed.map((r) => (
              <a key={r.path} href={`#/${r.path}`} aria-current={r === route ? 'page' : undefined}><span aria-hidden="true">{r.icon}</span>{r.label}</a>
            ))}
          </nav>
          <div className="who">{profile.name}<br /><span style={{ textTransform: 'capitalize' }}>{role}</span></div>
          <button className="btn ghost small" onClick={() => repo.signOut()}>Sign out</button>
        </aside>
        <main className="main" id="main"><View key={route.path} /></main>
      </div>
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.message}</div>)}</div>
    </AppContext.Provider>
  );
}
