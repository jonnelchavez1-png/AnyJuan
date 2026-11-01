import { repo } from '../data/repo.js';
import { useApp } from '../ui/context.js';
import { Badge, ErrorBox, Loading, PageHead, useLoad } from '../ui/kit.jsx';

const ROLES = [
  ['owner', 'Owner', 'Everything, including settings and team'],
  ['manager', 'Manager', 'Sell, products, stock, expenses, reports, void sales'],
  ['cashier', 'Cashier', 'Sell and take payments'],
  ['accountant', 'Accountant', 'Reports, sales and expenses (cannot sell)'],
];

export default function Team() {
  const { user, toast } = useApp();
  const { data, error, loading, reload } = useLoad(() => repo.listProfiles(), []);
  const change = async (p, patch) => {
    try { await repo.saveProfile(p.id, patch); toast('Saved', 'good'); reload(); } catch (e) { toast(e.message, 'bad'); reload(); }
  };
  return (
    <>
      <PageHead title="Team" />
      <p className="muted">New people create their own account on the sign-in page, then wait here until you switch them on and choose a role.</p>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : (
        <div className="card table-wrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>{(data || []).map((p) => (
            <tr key={p.id}>
              <td><strong>{p.name}</strong>{p.id === user.id && ' (you)'}<div className="small muted">{p.email}</div></td>
              <td><select className="input" aria-label={`Role of ${p.name}`} value={p.role} onChange={(e) => change(p, { role: e.target.value })} style={{ maxWidth: 180 }}>
                {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
              <td>{p.active ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Waiting</Badge>}</td>
              <td className="right"><button className={`btn small ${p.active ? 'secondary' : ''}`} onClick={() => change(p, { active: !p.active })}>{p.active ? 'Switch off' : 'Activate'}</button></td>
            </tr>))}</tbody></table></div>
      )}
      <div className="card" style={{ marginTop: '1rem' }}><h2>What each role can do</h2>
        {ROLES.map(([v, l, d]) => <p key={v} style={{ margin: '.3rem 0' }}><strong>{l}:</strong> {d}</p>)}</div>
    </>
  );
}
