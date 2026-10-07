/**
 * Date helpers.
 *
 * Server Components render in the server's timezone (usually UTC on Vercel)
 * while the browser renders in the user's local timezone. Formatting an
 * ISO timestamp with `date-fns` on the server therefore produced a different
 * string than the client expected, causing hydration mismatches and dates
 * that were "a day off" for many users.
 *
 * `formatDate` formats on a pinned UTC calendar so the server and client agree.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function parts(input: string | Date): { y: number; m: number; d: number } {
  if (input instanceof Date) {
    return { y: input.getUTCFullYear(), m: input.getUTCMonth(), d: input.getUTCDate() };
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return { y: 0, m: 0, d: 1 };
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

/** "Mar 4, 2025" — stable across server and client. */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '';
  const { y, m, d } = parts(input);
  if (!y) return '';
  return `${MONTHS[m]} ${d}, ${y}`;
}

/** "4 Mar 2025" */
export function formatDateShort(input: string | Date | null | undefined): string {
  if (!input) return '';
  const { y, m, d } = parts(input);
  if (!y) return '';
  return `${d} ${MONTHS[m]} ${y}`;
}

/** "March 2025" */
export function formatMonthYear(input: string | Date | null | undefined): string {
  if (!input) return '';
  const { y, m } = parts(input);
  if (!y) return '';
  return `${MONTHS_LONG[m]} ${y}`;
}

/** Year only, for release dates. */
export function formatYear(input: string | Date | null | undefined): string | null {
  if (!input) return null;
  const { y } = parts(input);
  return y ? String(y) : null;
}

/** ISO week number, used by the "streak" metric. */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** "just now" / "5m" / "3h" / "2d" / then a date. */
export function relativeTime(input: string | Date | null | undefined): string {
  if (!input) return '';
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return '';

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return formatDate(input);
}

/** Human-friendly playtime label from an optional hour count. */
export function formatPlaytime(hours: number | null | undefined): string {
  if (!hours || hours <= 0) return '—';
  if (hours < 1) return '<1 hr';
  if (hours < 2) return '1 hr';
  return `${Math.round(hours)} hrs`;
}
