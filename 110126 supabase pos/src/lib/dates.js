// Date ranges for the dashboard, worked out in the BUSINESS time zone (not the visitor's).
// Days are plain "YYYY-MM-DD" strings, so there is no daylight-saving or midnight trouble.

const pad = (n) => String(n).padStart(2, '0');

function parse(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d };
}
function toUtc(ymd) {
  const { y, m, d } = parse(ymd);
  return new Date(Date.UTC(y, m - 1, d));
}
function fromUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function isYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && fromUtc(toUtc(value)) === value;
}

/** Today's date in a time zone, e.g. todayIn('Asia/Manila'). */
export function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(ymd, n) {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

export function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 86400000);
}

/** Move to the same day-of-month n months away, but never past the end of that month. */
export function addMonths(ymd, n) {
  const { y, m, d } = parse(ymd);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function startOfWeek(ymd, weekStartsOn = 1) {
  const dow = toUtc(ymd).getUTCDay(); // 0 = Sunday
  const back = (dow - weekStartsOn + 7) % 7;
  return addDays(ymd, -back);
}
export function startOfMonth(ymd) {
  const { y, m } = parse(ymd);
  return `${y}-${pad(m)}-01`;
}
export function endOfMonth(ymd) {
  const { y, m } = parse(ymd);
  return `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
}
export function startOfQuarter(ymd) {
  const { y, m } = parse(ymd);
  return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
}
export function endOfQuarter(ymd) {
  return endOfMonth(addMonths(startOfQuarter(ymd), 2));
}
export function startOfYear(ymd) {
  return `${parse(ymd).y}-01-01`;
}
export function endOfYear(ymd) {
  return `${parse(ymd).y}-12-31`;
}

/** The instant (a Date) when a calendar day starts in a time zone, e.g. midnight in Manila is 16:00 UTC the day before. */
export function startOfDayInstant(ymd, timeZone) {
  const { y, m, d } = parse(ymd);
  const asUtc = Date.UTC(y, m - 1, d);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000) / 60000;
  };
  let guess = asUtc - offsetAt(asUtc) * 60000;
  const second = asUtc - offsetAt(guess) * 60000; // re-check in case a clock change falls in between
  if (second !== guess) guess = second;
  return new Date(guess);
}

export const PRESETS = ['today', 'week', 'month', 'quarter', 'year', 'custom'];

export const PRESET_LABELS = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
  custom: 'Custom range',
};

/**
 * The range for a preset, from its start up to today ("to date").
 * @returns {{from:string,to:string}}
 */
export function rangeFor(preset, { today, weekStartsOn = 1, custom = null }) {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'week':
      return { from: startOfWeek(today, weekStartsOn), to: today };
    case 'month':
      return { from: startOfMonth(today), to: today };
    case 'quarter':
      return { from: startOfQuarter(today), to: today };
    case 'year':
      return { from: startOfYear(today), to: today };
    case 'custom': {
      if (!custom || !isYmd(custom.from) || !isYmd(custom.to)) return { from: today, to: today };
      return custom.from <= custom.to ? { from: custom.from, to: custom.to } : { from: custom.to, to: custom.from };
    }
    default:
      throw new Error(`Unknown range: ${preset}`);
  }
}

/**
 * The period to compare with. Same number of days from the start of the PREVIOUS week / month / quarter / year
 * (so "this month so far" meets "the same days of last month"); yesterday for today; for a custom range,
 * the stretch of equal length right before it.
 */
export function previousRange(preset, range) {
  const len = daysBetween(range.from, range.to) + 1;
  const cap = (from, end) => {
    const to = addDays(from, len - 1);
    return { from, to: to > end ? end : to };
  };
  switch (preset) {
    case 'today':
      return { from: addDays(range.from, -1), to: addDays(range.from, -1) };
    case 'week': {
      const from = addDays(range.from, -7);
      return { from, to: addDays(from, len - 1) };
    }
    case 'month': {
      const from = addMonths(range.from, -1);
      return cap(from, endOfMonth(from));
    }
    case 'quarter': {
      const from = addMonths(range.from, -3);
      return cap(from, endOfQuarter(from));
    }
    case 'year': {
      const from = addMonths(range.from, -12);
      return cap(from, endOfYear(from));
    }
    default: {
      const to = addDays(range.from, -1);
      return { from: addDays(to, -(len - 1)), to };
    }
  }
}

/** Show a range the way the business locale writes dates, e.g. "Oct 25, 2026" or "Oct 1 – 25, 2026". */
export function describeRange(range, locale = 'en-PH') {
  const f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  if (range.from === range.to) return f.format(toUtc(range.from));
  return f.formatRange(toUtc(range.from), toUtc(range.to));
}

/**
 * Group the daily series for a chart: by day up to 45 days, by week up to about 6 months, else by month.
 * Each point sums net_sales, gross_profit, expenses and orders. `label` is a short text for the axis.
 */
export function bucketSeries(series, weekStartsOn = 1) {
  if (!series.length) return { unit: 'day', points: [] };
  const span = series.length;
  const unit = span <= 45 ? 'day' : span <= 190 ? 'week' : 'month';
  const keyOf = (ymd) => (unit === 'day' ? ymd : unit === 'week' ? startOfWeek(ymd, weekStartsOn) : startOfMonth(ymd));
  const map = new Map();
  for (const p of series) {
    const k = keyOf(p.date);
    const cur = map.get(k) || { key: k, net_sales: 0, gross_profit: 0, expenses: 0, orders: 0 };
    cur.net_sales += Number(p.net_sales) || 0;
    cur.gross_profit += Number(p.gross_profit) || 0;
    cur.expenses += Number(p.expenses) || 0;
    cur.orders += Number(p.orders) || 0;
    map.set(k, cur);
  }
  const short = (ymd) =>
    unit === 'month'
      ? new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', month: 'short', year: '2-digit' }).format(toUtc(ymd))
      : new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(toUtc(ymd));
  const points = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((p) => ({ ...p, label: short(p.key) }));
  return { unit, points };
}
