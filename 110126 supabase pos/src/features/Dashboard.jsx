import { useMemo } from 'react';
import { repo } from '../data/repo.js';
import { bucketSeries, describeRange } from '../lib/dates.js';
import { dashboardFigures } from '../lib/metrics.js';
import { formatPercent, toCents } from '../lib/money.js';
import { useApp } from '../ui/context.js';
import { BarList, DonutChart, LineChart, TREND_SERIES } from '../ui/charts.jsx';
import { ErrorBox, Loading, PageHead, Tip, useLoad } from '../ui/kit.jsx';
import { COMPARE_NAME, PeriodBar, periodSentence, usePeriod } from '../ui/period.jsx';


const DEFINITIONS = {
  netSales: 'Money earned from sales after discounts and without tax, minus returns. Voided sales are not counted.',
  tax: 'Tax included in sales. It is held for the tax office, so it is NOT part of net sales or profit.',
  collected: 'Payments actually received in this period (cash, card, e-wallet), including payments for older sales, minus money given back for returns.',
  receivables: 'Money customers still owe you today for sales that were not fully paid. This is a current balance, not limited to the period.',
  cogs: 'What the goods you sold cost you (cost price × quantity). Needs a cost price on each product.',
  grossProfit: 'Net sales minus cost of goods sold.',
  expenses: 'Everything recorded under Expenses in this period (voided ones are left out).',
  netProfit: 'Gross profit minus expenses.',
  orders: 'Number of completed sales.',
  discounts: 'Total discount given before tax.',
  returns: 'Items customers brought back in this period, counted on the day they came back. They are already taken off net sales, tax and profit above.',
};

export default function Dashboard() {
  const { business, money } = useApp();
  const { preset, range, prev, today } = usePeriod();
  const { data, error, loading, reload } = useLoad(() => repo.getDashboard(range, prev), [range.from, range.to, prev.from, prev.to]);
  const fig = useMemo(() => (data ? dashboardFigures(data) : null), [data]);
  const chart = useMemo(() => {
    if (!data) return null;
    const b = bucketSeries(data.series.map((s) => ({ ...s, net_sales: toCents(s.net_sales), gross_profit: toCents(s.gross_profit), expenses: toCents(s.expenses) })), business.week_starts_on);
    return b;
  }, [data, business.week_starts_on]);

  return (
    <>
      <PageHead title="Dashboard" />
      <PeriodBar />
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : fig && <Body fig={fig} data={data} chart={chart} range={range} prev={prev} preset={preset} today={today} money={money} locale={business.locale} />}
    </>
  );
}

function Delta({ ch, money, invert, asCount, show }) {
  if (!ch || !show) return null;
  if (ch.pct == null) return <span className="sub">{ch.diff === 0 ? 'No change' : 'Nothing to compare with'}</span>;
  const good = invert ? ch.diff < 0 : ch.diff > 0;
  const tone = ch.diff === 0 ? '' : good ? 'up' : 'down';
  return <span className={`sub ${tone}`}>{ch.diff > 0 ? '▲' : ch.diff < 0 ? '▼' : '■'} {formatPercent(Math.abs(ch.pct))} ({ch.diff > 0 ? '+' : ch.diff < 0 ? '−' : ''}{asCount ? Math.abs(ch.diff) : money(Math.abs(ch.diff))})</span>;
}

function Kpi({ label, tip, value, sub, children }) {
  return (
    <div className="kpi">
      <div className="label">{label}<Tip text={tip} /></div>
      <div className="value num">{value}</div>
      {children}{sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function Body({ fig, data, chart, range, prev, preset, today, money, locale }) {
  const c = fig.current;
  const hero = fig.compare.netSales;
  const prevText = describeRange(prev, locale);
  const vs = `${COMPARE_NAME[preset]} (${prevText})`;
  const nothing = c.orders === 0 && c.expenses === 0;
  return (
    <>
      <section className="hero" aria-label="Net sales">
        <div className="label">Net sales <Tip text={DEFINITIONS.netSales} /></div>
        <div className="big num">{money(c.netSales)}</div>
        <div className="delta">
          {!fig.hasPreviousData ? <span>Nothing to compare with: no sales were recorded for {vs}.</span>
            : hero.pct == null ? <span>Compared with {vs}: {money(fig.previous.netSales)}</span>
            : <span className={hero.diff >= 0 ? 'delta up' : 'delta down'}>{hero.diff >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(hero.pct))} vs {vs}: {money(fig.previous.netSales)}</span>}
        </div>
      </section>

      {nothing && <div className="notice" style={{ marginTop: '1rem' }}>No sales or expenses in this period yet. Figures will appear as you record them.</div>}

      <div className="kpis">
        <Kpi label="Orders" tip={DEFINITIONS.orders} value={c.orders}><Delta show={fig.hasPreviousData} ch={fig.compare.orders} asCount money={money} /></Kpi>
        <Kpi label="Average order" tip="Net sales divided by the number of orders." value={c.averageOrder == null ? '–' : money(c.averageOrder)} />
        <Kpi label="Tax collected" tip={DEFINITIONS.tax} value={money(c.taxCollected)}><Delta show={fig.hasPreviousData} ch={fig.compare.taxCollected} money={money} /></Kpi>
        <Kpi label="Payments collected" tip={DEFINITIONS.collected} value={money(c.collected)}><Delta show={fig.hasPreviousData} ch={fig.compare.collected} money={money} /></Kpi>
        <Kpi label="Receivables (owed to you)" tip={DEFINITIONS.receivables} value={money(fig.receivables.amount)} sub={`${fig.receivables.count} unpaid ${fig.receivables.count === 1 ? 'sale' : 'sales'} · as of today`} />
        <Kpi label="Cost of goods sold" tip={DEFINITIONS.cogs} value={money(c.cogs)} />
        <Kpi label="Gross profit" tip={DEFINITIONS.grossProfit} value={money(c.grossProfit)} sub={`Margin ${formatPercent(c.grossMargin)}`}><Delta show={fig.hasPreviousData} ch={fig.compare.grossProfit} money={money} /></Kpi>
        <Kpi label="Expenses" tip={DEFINITIONS.expenses} value={money(c.expenses)}><Delta show={fig.hasPreviousData} ch={fig.compare.expenses} invert money={money} /></Kpi>
        <Kpi label="Net profit" tip={DEFINITIONS.netProfit} value={money(c.netProfit)} sub={`Margin ${formatPercent(c.netMargin)}`}><Delta show={fig.hasPreviousData} ch={fig.compare.netProfit} money={money} /></Kpi>
        <Kpi label="Discounts given" tip={DEFINITIONS.discounts} value={money(c.discounts)} />
        <Kpi label="Returns" tip={DEFINITIONS.returns} value={money(c.returnsTotal)} sub={`${c.returnsCount} ${c.returnsCount === 1 ? 'return' : 'returns'} · refunded ${money(c.refunded)}`} />
      </div>
      {c.orders > 0 && c.cogs === 0 && <div className="notice">Cost of goods is 0, so gross profit equals net sales. Enter a cost price on your products (Products → Edit) for real profit figures.</div>}

      <section className="card" aria-label="Trend" style={{ marginTop: '1rem' }}>
        <h2>Trend by {chart.unit}</h2>
        {chart.points.length ? (
          <>
            <LineChart points={chart.points} series={TREND_SERIES} money={money} ariaLabel={`Net sales, gross profit and expenses by ${chart.unit}`} />
            <details style={{ marginTop: '.6rem' }}><summary>View as table</summary>
              <div className="table-wrap"><table><thead><tr><th>{chart.unit}</th><th className="right">Orders</th><th className="right">Net sales</th><th className="right">Gross profit</th><th className="right">Expenses</th></tr></thead>
                <tbody>{chart.points.map((p) => <tr key={p.key}><td>{p.label}</td><td className="right num">{p.orders}</td><td className="right num">{money(p.net_sales)}</td><td className="right num">{money(p.gross_profit)}</td><td className="right num">{money(p.expenses)}</td></tr>)}</tbody></table></div>
            </details>
          </>
        ) : <p className="muted">No data.</p>}
      </section>

      <div className="panels" style={{ marginTop: '1rem' }}>
        <section className="card"><h2>Top items by quantity</h2>
          <BarList rows={data.top_by_quantity.map((r) => ({ name: r.name, value: Number(r.qty) }))} format={(v) => String(Number(v.toFixed(3)))} empty="No items sold in this period." /></section>
        <section className="card"><h2>Top items by net sales</h2>
          <BarList rows={data.top_by_net_sales.map((r) => ({ name: r.name, value: toCents(r.net_sales) }))} money={money} empty="No items sold in this period." /></section>
        <section className="card"><h2>Net sales by category</h2>
          <DonutChart rows={data.by_category.map((r) => ({ name: r.name, value: toCents(r.net_sales) }))} money={money} ariaLabel="Net sales by category" /></section>
        <section className="card"><h2>Sales channels</h2>
          <DonutChart rows={data.by_channel.map((r) => ({ name: r.name, value: toCents(r.net_sales) }))} money={money} ariaLabel="Sales by channel" /></section>
        <section className="card"><h2>Payments by method</h2>
          <DonutChart rows={data.by_payment_method.map((r) => ({ name: r.name, value: toCents(r.amount) }))} money={money} ariaLabel="Payments by method" /></section>
        <section className="card"><h2>Expenses by category</h2>
          <DonutChart rows={data.expenses_by_category.map((r) => ({ name: r.name, value: toCents(r.amount) }))} money={money} ariaLabel="Expenses by category" empty="No expenses in this period." /></section>
      </div>

      {data.low_stock.length > 0 && (
        <section className="card" style={{ marginTop: '1rem' }}><h2>Running low</h2>
          <div className="table-wrap"><table><thead><tr><th>Product</th><th className="right">In stock</th><th className="right">Warn at</th></tr></thead>
            <tbody>{data.low_stock.map((p) => <tr key={p.id}><td>{p.name}</td><td className="right num">{Number(p.quantity)}</td><td className="right num">{Number(p.reorder_level)}</td></tr>)}</tbody></table></div>
        </section>
      )}
      <p className="muted small" style={{ marginTop: '1rem' }}>Showing {periodSentence(preset, range, today, locale)}. Compared with {vs}. Dates use the {data.range.timezone} time zone. Every figure comes from recorded sales, payments and expenses; nothing is estimated.</p>
    </>
  );
}
