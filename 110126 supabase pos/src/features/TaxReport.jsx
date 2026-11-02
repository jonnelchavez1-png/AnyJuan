import { useMemo, useRef, useState } from 'react';
import { repo } from '../data/repo.js';
import { PRESETS, PRESET_LABELS, describeRange, isYmd, rangeFor, todayIn } from '../lib/dates.js';
import { toCents } from '../lib/money.js';
import { printHtml } from '../lib/print.js';
import { useApp } from '../ui/context.js';
import { ErrorBox, Loading, PageHead, downloadCsv, useLoad } from '../ui/kit.jsx';

const RANGES = PRESETS;

export default function TaxReport() {
  const { business, money } = useApp();
  const today = todayIn(business.timezone);
  const [preset, setPreset] = useState('month');
  const [custom, setCustom] = useState({ from: today, to: today });
  const printRef = useRef(null);
  const range = useMemo(() => rangeFor(preset, { today, weekStartsOn: business.week_starts_on, custom }), [preset, today, business.week_starts_on, custom]);
  const customOk = preset !== 'custom' || (isYmd(custom.from) && isYmd(custom.to));
  const { data, error, loading, reload } = useLoad(() => repo.getTaxReport(range), [range.from, range.to]);
  const m = (v) => money(toCents(v));
  const t = data?.totals;
  const label = describeRange(range, business.locale);

  const csv = () => downloadCsv(`tax-report-${range.from}-to-${range.to}.csv`,
    ['Date', 'Orders', 'Sales before tax', 'Tax', 'Total billed'],
    [...data.daily.map((d) => [d.date, d.orders, d.net_sales, d.tax, d.billed]),
      ['TOTAL', t.orders, t.net_sales, t.tax_collected, t.billed]]);
  const print = () => printHtml(printRef.current.outerHTML, { title: 'Tax report', css: '@page { margin: 12mm; } body { width: auto; font: 12px/1.4 system-ui, sans-serif; } h2 { text-align: left; margin-top: 12px; }' });

  return (
    <>
      <PageHead title="Tax report">
        <button className="btn secondary small" onClick={csv} disabled={!data}>Download CSV</button>
        <button className="btn secondary small" onClick={print} disabled={!data}>Print</button>
      </PageHead>
      <div className="range-bar" role="group" aria-label="Date range">
        {RANGES.map((r) => <button key={r} className="seg" aria-pressed={preset === r} onClick={() => setPreset(r)}>{PRESET_LABELS[r]}</button>)}
      </div>
      {preset === 'custom' && (
        <div className="row" style={{ marginBottom: '.75rem' }}>
          <label>From <input className="input" type="date" max={today} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
          <label>To <input className="input" type="date" max={today} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          {!customOk && <span className="notice bad">Choose both dates.</span>}
        </div>
      )}
      {!business.tax_enabled && <div className="notice">Tax is switched off in Settings, so new sales carry no tax. Sales made while it was on still appear below.</div>}
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && (
        <div ref={printRef}>
          <h2 style={{ marginBottom: '.2rem' }}>{business.name} · Tax report</h2>
          <p className="muted small" style={{ marginTop: 0 }}>{label} · {data.range.timezone} time zone. Voided sales are not included.</p>
          <div className="kpis">
            <div className="kpi"><div className="label">Tax collected</div><div className="value num">{m(t.tax_collected)}</div></div>
            <div className="kpi"><div className="label">Sales with tax (before tax)</div><div className="value num">{m(t.taxable_sales)}</div></div>
            <div className="kpi"><div className="label">Sales without tax</div><div className="value num">{m(t.not_taxable_sales)}</div></div>
            <div className="kpi"><div className="label">Total billed</div><div className="value num">{m(t.billed)}</div><div className="sub">{t.orders} sales · discounts {m(t.discounts)}</div></div>
          </div>
          <div className="card table-wrap"><h2>By tax</h2>
            {data.by_rate.length ? (
              <table><thead><tr><th>Tax</th><th>How</th><th className="right">Sales</th><th className="right">With tax</th><th className="right">Without tax</th><th className="right">Tax</th></tr></thead>
                <tbody>{data.by_rate.map((r, i) => (
                  <tr key={i}><td>{r.tax_name} {Number(r.tax_rate) > 0 ? `${Number(r.tax_rate)}%` : ''}</td><td>{r.tax_mode === 'inclusive' ? 'Included in price' : r.tax_mode === 'exclusive' ? 'Added on top' : 'None'}</td>
                    <td className="right num">{r.orders}</td><td className="right num">{m(r.taxable_sales)}</td><td className="right num">{m(r.not_taxable_sales)}</td><td className="right num">{m(r.tax)}</td></tr>))}</tbody></table>
            ) : <p className="muted">No sales in this period.</p>}
          </div>
          <div className="card table-wrap" style={{ marginTop: '.75rem' }}><h2>Day by day</h2>
            <table><thead><tr><th>Date</th><th className="right">Sales</th><th className="right">Before tax</th><th className="right">Tax</th><th className="right">Total billed</th></tr></thead>
              <tbody>{data.daily.filter((d) => d.orders > 0).map((d) => (
                <tr key={d.date}><td className="nowrap">{d.date}</td><td className="right num">{d.orders}</td><td className="right num">{m(d.net_sales)}</td><td className="right num">{m(d.tax)}</td><td className="right num">{m(d.billed)}</td></tr>))}
                <tr><th>Total</th><th className="right num">{t.orders}</th><th className="right num">{m(t.net_sales)}</th><th className="right num">{m(t.tax_collected)}</th><th className="right num">{m(t.billed)}</th></tr></tbody></table>
          </div>
          {data.voided.orders > 0 && <p className="muted small">Left out: {data.voided.orders} voided sale{data.voided.orders === 1 ? '' : 's'} ({m(data.voided.billed)}, tax {m(data.voided.tax)}).</p>}
          <p className="muted small">A summary of recorded sales to help with your tax filing. Ask your accountant which figures your local rules require.</p>
        </div>
      )}
    </>
  );
}
