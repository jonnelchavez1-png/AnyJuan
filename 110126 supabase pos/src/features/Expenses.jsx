import { useMemo, useState } from 'react';
import { repo } from '../data/repo.js';
import { todayIn } from '../lib/dates.js';
import { fromCents, parseAmount, toCents } from '../lib/money.js';
import { useApp } from '../ui/context.js';
import { PeriodBar, usePeriod } from '../ui/period.jsx';
import { Badge, ConfirmDialog, Dialog, ErrorBox, Field, Loading, PageHead, downloadCsv, useLoad } from '../ui/kit.jsx';

const SHOW_MAX = 500; // rows drawn on screen; the total always counts every expense

export default function Expenses() {
  const { business, expenseCategories, can, money, user, toast } = useApp();
  const [edit, setEdit] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const { range, customOk } = usePeriod();
  const { data, error, loading, reload } = useLoad(() => (customOk ? repo.listExpenses(range) : Promise.resolve([])), [range.from, range.to, customOk]);
  const catName = (id) => expenseCategories.find((c) => c.id === id)?.name || 'No category';
  const live = (data || []).filter((e) => !e.voided_at);
  const total = live.reduce((n, e) => n + toCents(e.amount), 0);
  const byCat = useMemo(() => {
    const m = new Map();
    live.forEach((e) => m.set(catName(e.category_id), (m.get(catName(e.category_id)) || 0) + toCents(e.amount)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);
  const canEdit = can('editExpenses');

  return (
    <>
      <PageHead title="Expenses">
        <button className="btn secondary small" disabled={!live.length} onClick={() => downloadCsv(`expenses-${range.from}-to-${range.to}.csv`, ['Date', 'Category', 'Payee', 'Amount', 'Note'], live.map((e) => [e.expense_date, catName(e.category_id), e.payee, e.amount, e.note]))}>Download CSV</button>
        {canEdit && <button className="btn" onClick={() => setEdit({})}>＋ Add expense</button>}
      </PageHead>
      <PeriodBar />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="panels">
          <div className="card">
            <h2>Total spent <span className="muted small">(same as the Expenses figure on the Dashboard)</span></h2><div className="num" style={{ fontSize: '1.8rem', fontWeight: 800 }}>{money(total)}</div>
            {byCat.map(([name, amt]) => <div className="row between small" key={name}><span>{name}</span><span className="num">{money(amt)}</span></div>)}
            {!byCat.length && <p className="muted">Nothing recorded for this period.</p>}
          </div>
          <div className="card table-wrap">
            {!data?.length ? <div className="empty">No expenses in this period.</div> : <table>
              <thead><tr><th>Date</th><th>What</th><th className="right">Amount</th><th></th></tr></thead>
              <tbody>{data.slice(0, SHOW_MAX).map((e) => (
                <tr key={e.id} className={e.voided_at ? 'dim' : ''}>
                  <td>{e.expense_date}</td><td>{catName(e.category_id)}<div className="small muted">{[e.payee, e.note].filter(Boolean).join(' · ')}</div></td>
                  <td className="right num">{e.voided_at ? <s>{money(toCents(e.amount))}</s> : money(toCents(e.amount))}</td>
                  <td className="right">{e.voided_at ? <Badge tone="bad">Voided</Badge> : canEdit && <><button className="btn ghost small" onClick={() => setEdit(e)}>Edit</button><button className="btn ghost small" onClick={() => setVoiding(e)}>Void</button></>}</td>
                </tr>))}</tbody></table>}
          </div>
        </div>
      )}
      {data?.length > SHOW_MAX && <p className="notice">Showing the newest {SHOW_MAX} of {data.length} expenses. The total above counts all {data.length}.</p>}
      {edit && <ExpenseDialog expense={edit} onClose={() => setEdit(null)} onSaved={(date) => { setEdit(null); reload(); if (date && (date < range.from || date > range.to)) toast(`Saved. It is dated ${date}, which is outside the dates shown, so change the dates to see it.`); }} />}
      {voiding && <ConfirmDialog title="Void this expense?" danger confirmLabel="Void expense" message="It will no longer count in your totals. It stays in the list marked as voided."
        onConfirm={async () => { await repo.voidExpense(voiding.id, user.id); toast('Expense voided', 'good'); reload(); }} onClose={() => setVoiding(null)} />}
    </>
  );
}

function ExpenseDialog({ expense, onClose, onSaved }) {
  const { business, expenseCategories, user, toast } = useApp();
  const isNew = !expense.id;
  const [f, setF] = useState({ amount: expense.amount != null ? String(expense.amount) : '', date: expense.expense_date || todayIn(business.timezone),
    category_id: expense.category_id || '', payee: expense.payee || '', note: expense.note || '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    const amt = parseAmount(f.amount);
    if (!amt || amt <= 0) return setError('Enter an amount above zero.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return setError('Choose a date.');
    setBusy(true); setError('');
    try {
      await repo.saveExpense({ id: expense.id, amount: fromCents(amt), expense_date: f.date, category_id: f.category_id || null, payee: f.payee.trim() || null, note: f.note.trim() || null }, user.id);
      toast(isNew ? 'Expense added' : 'Expense saved', 'good'); onSaved(f.date);
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Dialog title={isNew ? 'Add expense' : 'Edit expense'} onClose={onClose} actions={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="grid2">
        <Field label="Amount" id="ea"><input id="ea" className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Date" id="ed"><input id="ed" className="input" type="date" value={f.date} onChange={set('date')} /></Field>
      </div>
      <Field label="Category" id="ec"><select id="ec" className="input" value={f.category_id} onChange={set('category_id')}><option value="">None</option>{expenseCategories.filter((c) => c.active || c.id === f.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Paid to (optional)" id="ep"><input id="ep" className="input" value={f.payee} onChange={set('payee')} /></Field>
      <Field label="Note (optional)" id="en"><input id="en" className="input" value={f.note} onChange={set('note')} /></Field>
      {error && <div className="notice bad" role="alert">{error}</div>}
    </Dialog>
  );
}
