// Native-Date hour clipping shared by the rhythm/punchcard/spiral charts.
//
// Rationale: these charts previously clipped events with moment, and in the
// built bundle every segment landed in hour 0 (root cause never fully
// isolated — the same queries and the same timestamps distribute correctly
// with plain Date, verified in the page). Date is also measurably faster on
// the 10k+ event lists these charts chew through.

export interface HourSlice {
  hour: number; // local hour of day
  date: Date; // the local day the slice starts in
  seconds: number;
}

/** Clip an event into its clock-hour slices (local timezone). */
export function clipEventToHours(
  timestamp: string,
  durationSeconds: number,
  onSlice: (slice: HourSlice) => void
) {
  let cur = new Date(timestamp);
  // Clip to the current moment: server-side merging extends the day's last
  // not-afk heartbeat until the next afk event (or the period edge), which
  // during watcher outages stretches segments hours into the night — even
  // into the future. Everything past 'now' is certainly not real activity.
  const endMs = Math.min(cur.getTime() + (durationSeconds || 0) * 1000, Date.now());
  const end = new Date(endMs);
  while (cur < end) {
    const nextHour = new Date(cur);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const segEnd = end < nextHour ? end : nextHour;
    const seconds = (segEnd.getTime() - cur.getTime()) / 1000;
    if (seconds > 0) {
      onSlice({ hour: cur.getHours(), date: cur, seconds });
    }
    cur = segEnd;
  }
}

export function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function startOfToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
