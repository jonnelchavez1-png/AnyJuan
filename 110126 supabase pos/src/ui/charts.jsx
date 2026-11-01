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
