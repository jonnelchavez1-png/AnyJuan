// ONE date range for the whole app. Pick "This month" on the Dashboard and Sales, Expenses and the Tax report
// are on "This month" too, with exactly the same days, so their totals can be compared side by side.
import { useMemo } from 'react';
import { PRESETS, PRESET_LABELS, describeRange, isYmd, previousRange, rangeFor, todayIn } from '../lib/dates.js';
import { useApp } from './context.js';

/** What the comparison period is called in plain words. */
export const COMPARE_NAME = {
  today: 'yesterday',
  week: 'the same days last week',
  month: 'the same days last month',
  quarter: 'the same days last quarter',
  year: 'the same days last year',
  custom: 'the period just before',
};

export function usePeriod() {
  const { business, period, setPeriod } = useApp();
  const today = todayIn(business.timezone);
  const preset = period.preset;
  const custom = period.custom || { from: today, to: today };
  const range = useMemo(
    () => rangeFor(preset, { today, weekStartsOn: business.week_starts_on, custom }),
    [preset, today, business.week_starts_on, custom.from, custom.to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const prev = useMemo(() => previousRange(preset, range), [preset, range]);
  return {
    preset, custom, range, prev, today,
    customOk: preset !== 'custom' || (isYmd(custom.from) && isYmd(custom.to)),
    setPreset: (p) => setPeriod((s) => ({ ...s, preset: p })),
    setCustom: (fn) => setPeriod((s) => ({ ...s, custom: typeof fn === 'function' ? fn(s.custom || { from: today, to: today }) : fn })),
  };
}

/** The sentence that says exactly which days are on screen, e.g. "Nov 1 – 2, 2026 · this month so far". */
export function periodSentence(preset, range, today, locale) {
  const days = describeRange(range, locale);
  const sofar = ['week', 'month', 'quarter', 'year'].includes(preset) && range.to === today;
  return sofar ? `${days} · ${PRESET_LABELS[preset].toLowerCase()} so far (up to today)` : days;
}

export function PeriodBar() {
  const { business } = useApp();
  const { preset, custom, range, today, customOk, setPreset, setCustom } = usePeriod();
  return (
    <>
      <div className="range-bar" role="group" aria-label="Date range">
        {PRESETS.map((p) => <button key={p} className="seg" aria-pressed={preset === p} onClick={() => setPreset(p)}>{PRESET_LABELS[p]}</button>)}
      </div>
      {preset === 'custom' && (
        <div className="row" style={{ marginBottom: '.75rem' }}>
          <label>From <input className="input" type="date" max={today} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
          <label>To <input className="input" type="date" max={today} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          {!customOk && <span className="notice bad">Choose both dates.</span>}
        </div>
      )}
      <p className="period-note" data-testid="period-note">Showing <strong>{periodSentence(preset, range, today, business.locale)}</strong> <span className="muted">· same dates on every screen</span></p>
    </>
  );
}
