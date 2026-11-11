import { useMemo, useState } from 'react';

/** Round a maximum up to a tidy axis number (e.g. 8,730 -> 10,000). */
export function niceMax(max) {
  if (!(max > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** The three trend lines. Each differs by colour AND line style AND marker shape, so colour is never the only clue. */
export const TREND_SERIES = [
  { key: 'net_sales', label: 'Net sales', color: '#14679F', dash: undefined, shape: 'circle' },
  { key: 'gross_profit', label: 'Gross profit', color: '#0B9A8D', dash: '7 4', shape: 'square' },
  { key: 'expenses', label: 'Expenses', color: '#D9642F', dash: '2 4', shape: 'triangle' },
];

function Marker({ shape, x, y, r, fill, stroke, sw = 0 }) {
  if (shape === 'square') return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill={fill} stroke={stroke} strokeWidth={sw} />;
  if (shape === 'triangle') return <polygon points={`${x},${y - r * 1.2} ${x + r * 1.15},${y + r * 0.9} ${x - r * 1.15},${y + r * 0.9}`} fill={fill} stroke={stroke} strokeWidth={sw} />;
  return <circle cx={x} cy={y} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />;
}

const W = 680, H = 280, M = { t: 14, r: 14, b: 30, l: 64 };

/**
 * Line chart with a hover/keyboard tooltip. series: [{key, label, color, dash?}]; points: [{label, ...values in cents}]
 * Never relies on colour alone: each line has its own dash style and a direct legend.
 */
export function LineChart({ points, series, money, ariaLabel }) {
  const [hover, setHover] = useState(null);
  const geo = useMemo(() => {
    const max = niceMax(Math.max(0, ...points.flatMap((p) => series.map((s) => p[s.key] || 0))));
    const min = Math.min(0, ...points.flatMap((p) => series.map((s) => p[s.key] || 0)));
    const lo = min < 0 ? -niceMax(-min) : 0;
    const x = (i) => M.l + (points.length <= 1 ? (W - M.l - M.r) / 2 : (i * (W - M.l - M.r)) / (points.length - 1));
    const y = (v) => M.t + ((max - v) / (max - lo)) * (H - M.t - M.b);
    const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((max - lo) * i) / 4);
    return { max, lo, x, y, ticks };
  }, [points, series]);
  const compact = (c) => { const v = Math.abs(c) / 100; const s = v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v)); return c < 0 ? `−${s}` : s; };
  const every = Math.max(1, Math.ceil(points.length / 7));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0, d = Infinity;
    points.forEach((_, i) => { const dd = Math.abs(geo.x(i) - px); if (dd < d) { d = dd; best = i; } });
    setHover(best);
  };
  const h = hover != null ? points[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {geo.ticks.map((t) => (
          <g key={t}><line x1={M.l} x2={W - M.r} y1={geo.y(t)} y2={geo.y(t)} stroke="#cfdde8" strokeWidth="1" /><text x={M.l - 8} y={geo.y(t) + 4} textAnchor="end">{compact(t)}</text></g>
        ))}
        {points.map((p, i) => i % every === 0 && <text key={p.key || i} x={geo.x(i)} y={H - 8} textAnchor="middle">{p.label}</text>)}
        {series.map((s) => (
          <g key={s.key}>
            <polyline fill="none" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round"
              points={points.map((p, i) => `${geo.x(i)},${geo.y(p[s.key] || 0)}`).join(' ')} />
            {points.length <= 31 && points.map((p, i) => <Marker key={i} shape={s.shape} x={geo.x(i)} y={geo.y(p[s.key] || 0)} r={3.2} fill={s.color} />)}
          </g>
        ))}
        {h && <line x1={geo.x(hover)} x2={geo.x(hover)} y1={M.t} y2={H - M.b} stroke="#3d5870" strokeDasharray="3 3" />}
        {h && series.map((s) => <Marker key={s.key} shape={s.shape} x={geo.x(hover)} y={geo.y(h[s.key] || 0)} r={5} fill="#fff" stroke={s.color} sw={2.5} />)}
      </svg>
      {h && (
        <div className="toast" role="status" style={{ position: 'absolute', top: 6, left: hover > points.length / 2 ? 70 : 'auto', right: hover > points.length / 2 ? 'auto' : 14, fontSize: '.82rem', padding: '.5rem .7rem' }}>
          <strong>{h.label}</strong>
          {series.map((s) => <div key={s.key}><i style={{ display: 'inline-block', width: 9, height: 9, background: s.color, borderRadius: 2, marginRight: 6 }} />{s.label}: {money(h[s.key] || 0)}</div>)}
          {h.orders != null && <div>Orders: {h.orders}</div>}
        </div>
      )}
      <div className="legend">{series.map((s) => (
        <span key={s.key}><svg width="30" height="12" aria-hidden="true" style={{ marginRight: 6 }}><line x1="0" x2="30" y1="6" y2="6" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash} /><Marker shape={s.shape} x={15} y={6} r={3.6} fill={s.color} /></svg>{s.label}</span>
      ))}</div>
    </div>
  );
}

/** Horizontal bars with the value written next to each bar (so nothing depends on hovering). */
export function BarList({ rows, money, valueKey = 'value', format, empty = 'No data for this period.' }) {
  const max = Math.max(0, ...rows.map((r) => r[valueKey]));
  if (!rows.length || max <= 0) return <p className="muted">{empty}</p>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar-row" key={r.name}>
          <span className="name" title={r.name}>{r.name}</span>
          <span className="track" aria-hidden="true"><span className="fill" style={{ width: `${Math.max(2, (r[valueKey] / max) * 100)}%` }} /></span>
          <span className="num">{format ? format(r[valueKey]) : money(r[valueKey])}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Donut chart for "how a total is split" (sales by category, channel, payment method, expenses by category).
// It only DRAWS the rows it is given: every amount stays written out in the legend, so the donut is never the only
// place a figure appears. Colours come in a fixed order (never cycled). A pie can't show negative amounts (for example a
// category with more returns than sales), so those rows are listed under "View all as a table" instead of being drawn.
// ---------------------------------------------------------------------------------------------------------------
export const DONUT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
const DONUT_OTHER = '#8a9aa8';
const MAX_NAMED = DONUT_COLORS.length;

export function formatShare(p) {
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 0.1) return `${p.toFixed(1)}%`;
  return '<0.1%';
}

function arcPath(cx, cy, R, r, a0, a1) {
  const pt = (rad, a) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
  return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
}

/** rows: [{name, value}] with value in cents. */
export function DonutChart({ rows, money, ariaLabel, empty = 'No data for this period.' }) {
  const [hover, setHover] = useState(null);
  const model = useMemo(() => {
    const positive = rows.filter((r) => r.value > 0).map((r, i) => ({ ...r, i })).sort((a, b) => b.value - a.value || a.i - b.i);
    const positiveTotal = positive.reduce((s, r) => s + r.value, 0);
    const grandTotal = rows.reduce((s, r) => s + r.value, 0);
    let slices = positive.map((r, i) => ({ name: r.name, value: r.value, color: DONUT_COLORS[i] }));
    const grouped = positive.length > MAX_NAMED + 1;
    if (grouped) {
      const rest = positive.slice(MAX_NAMED);
      slices = [...slices.slice(0, MAX_NAMED), { name: `Other (${rest.length} more)`, value: rest.reduce((s, r) => s + r.value, 0), color: DONUT_OTHER }];
    }
    let acc = 0;
    slices.forEach((s) => { s.share = (s.value / positiveTotal) * 100; s.from = (acc / positiveTotal) * 2 * Math.PI; acc += s.value; s.to = (acc / positiveTotal) * 2 * Math.PI; });
    return { slices, positiveTotal, grandTotal, grouped, hasHidden: rows.length !== positive.length };
  }, [rows]);
  if (!model.slices.length) return <p className="muted">{empty}</p>;

  const { slices, grandTotal } = model;
  const C = 110, R = 102, r = 64;
  const h = hover != null ? slices[hover] : null;
  const centerAmount = money(h ? h.value : grandTotal);
  const fs = centerAmount.length > 13 ? 12 : centerAmount.length > 10 ? 14 : 17;
  const summary = `${ariaLabel}: ${slices.map((s) => `${s.name} ${money(s.value)} (${formatShare(s.share)})`).join(', ')}`;
  return (
    <div className="donut">
      <svg className="donut-svg" viewBox="0 0 220 220" role="img" aria-label={summary} onPointerLeave={() => setHover(null)}>
        {slices.length === 1
          ? <circle cx={C} cy={C} r={(R + r) / 2} fill="none" stroke={slices[0].color} strokeWidth={R - r} onPointerEnter={() => setHover(0)} />
          : slices.map((s, i) => (
            <path key={s.name} d={arcPath(C, C, R, r, s.from, s.to)} fill={s.color} stroke="#fff" strokeWidth="2" strokeLinejoin="round"
              opacity={hover == null || hover === i ? 1 : 0.4} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} />))}
        <text x={C} y={C - 6} textAnchor="middle" className="donut-c1" style={{ fontSize: fs }}>{centerAmount}</text>
        <text x={C} y={C + 14} textAnchor="middle" className="donut-c2">{h ? `${formatShare(h.share)} · ${h.name.length > 18 ? `${h.name.slice(0, 17)}…` : h.name}` : 'Total'}</text>
      </svg>
      <ul className="donut-legend">
        {slices.map((s, i) => (
          <li key={s.name} className={hover === i ? 'on' : undefined} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <i style={{ background: s.color }} aria-hidden="true" />
            <span className="n" title={s.name}>{s.name}</span>
            <span className="v num">{money(s.value)}</span>
            <span className="p num">{formatShare(s.share)}</span>
          </li>
        ))}
      </ul>
      {(model.grouped || model.hasHidden) && (
        <details className="donut-all">
          <summary>View all {rows.length} as a table</summary>
          <div className="table-wrap"><table><thead><tr><th>Name</th><th className="right">Amount</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="right num">{money(r.value)}</td></tr>)}</tbody></table></div>
          {model.hasHidden && <p className="muted small">Zero or negative amounts (for example returns bigger than sales) are listed here but not drawn in the donut.</p>}
        </details>
      )}
    </div>
  );
}
