// Cash drawer helpers. All amounts are whole cents. The database does the official working-out
// (supabase function shift_figures); these helpers only word the result and double-check the sum.
import { toCents } from './money.js';

/** What the drawer should hold, added up from the pieces: starting cash + cash received - cash refunded + cash in - cash out. */
export function expectedFromFigures(f) {
  return toCents(f.opening_cash) + toCents(f.cash_received) - toCents(f.cash_refunded) + toCents(f.cash_in) - toCents(f.cash_out);
}

/** Compare the counted cash with the expected cash. kind: 'balanced' | 'short' | 'over'; cents is never negative. */
export function describeDifference(expectedCents, countedCents) {
  const d = countedCents - expectedCents;
  if (d === 0) return { kind: 'balanced', cents: 0 };
  return d < 0 ? { kind: 'short', cents: -d } : { kind: 'over', cents: d };
}

/** The same wording everywhere: "Balanced", "Short by ₱10.00", "Over by ₱5.00". */
export function differenceText(diff, money) {
  if (diff.kind === 'balanced') return 'Balanced';
  return `${diff.kind === 'short' ? 'Short' : 'Over'} by ${money(diff.cents)}`;
}

/** The drawer functions may not be installed yet (the update-drawer.sql step). Say so in plain words. */
export function isDrawerMissing(message) {
  return /current_shift|get_shift|open_shift|shifts|schema cache|could not find the function/i.test(String(message || ''));
}
