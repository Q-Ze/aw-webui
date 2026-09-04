// Shared "activity by hour" matrix for the rhythm and punchcard charts.
//
// Both charts previously derived their data from the AFK store's
// active.history (not-afk events merged server-side into one segment per
// day, which stretches across watcher outages). They now use the same
// source as the Timeline barchart — canonical window events intersected
// with not-afk time — queried once for the trailing N days and cut into
// clock hours client-side. A module-level cache lets both cards share a
// single query.

import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import { buildMultideviceHostParams } from '~/util/multidevice';
import { clipEventToHours } from '~/util/hourclip';
import { IEvent } from '~/util/interfaces';

export interface DailyHourlyMatrix {
  /** Days (YYYY-MM-DD) that actually had activity, oldest first. */
  days: string[];
  /** minutes[d][h] = active minutes on day d, hour h. */
  matrix: number[][];
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { at: number; nDays: number; promise: Promise<DailyHourlyMatrix> } | null = null;

/** Trailing-window activity matrix (canonical window events, per clock hour). */
export function getDailyHourlyActivity(nDays: number): Promise<DailyHourlyMatrix> {
  const now = Date.now();
  if (cached && cached.nDays === nDays && now - cached.at < CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = fetchDailyHourlyActivity(nDays);
  cached = { at: now, nDays, promise };
  // Do not cache failures.
  promise.catch(() => {
    cached = null;
  });
  return promise;
}

async function fetchDailyHourlyActivity(nDays: number): Promise<DailyHourlyMatrix> {
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  await bucketsStore.ensureLoaded();
  const settingsStore = useSettingsStore();
  await settingsStore.ensureLoaded();
  categoryStore.load();

  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) return { days: [], matrix: [] };

  // One query, one day-period per trailing day: events = window ∩ not-afk
  // (canonical, without the category merge — we only need durations).
  const q: string[] = [];
  hosts_with_buckets.forEach(host => {
    const p = host_params[host];
    const suffix = host.replace(/[^a-zA-Z0-9_]/g, '');
    q.push(`events_${suffix} = flood(query_bucket("${p.bid_window}"));`);
    q.push(`not_afk_${suffix} = flood(query_bucket("${p.bid_afk}"));`);
    q.push(`not_afk_${suffix} = filter_keyvals(not_afk_${suffix}, "status", ["not-afk"]);`);
    q.push(`events_${suffix} = filter_period_intersect(events_${suffix}, not_afk_${suffix});`);
  });
  q.push('events = [];');
  hosts_with_buckets.forEach(host => {
    const suffix = host.replace(/[^a-zA-Z0-9_]/g, '');
    q.push(`events = union_no_overlap(events, events_${suffix});`);
  });
  q.push('RETURN = {"events": events};');

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const periods: string[] = [];
  const dayKeys: string[] = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const s = new Date(todayStart.getTime() - i * 86400000);
    const e = new Date(s.getTime() + 86400000);
    periods.push(toIso(s) + '/' + toIso(e));
    dayKeys.push(keyOf(s));
  }

  const data = await getClient().query(periods, q, { name: 'hourlyActivityQuery' });

  const matrix: number[][] = [];
  const days: string[] = [];
  for (let i = 0; i < dayKeys.length; i++) {
    const result = data && data[i];
    const events =
      ((result && (result.events || (result[0] && result[0].events))) as IEvent[]) || [];
    const hours = new Array(24).fill(0);
    for (const e of events) {
      clipEventToHours(e.timestamp, e.duration || 0, slice => {
        hours[slice.hour] += slice.seconds / 60;
      });
    }
    if (hours.some(v => v > 0)) {
      days.push(dayKeys[i]);
      matrix.push(hours);
    }
  }
  return { days, matrix };
}

function toIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const om = String(Math.abs(off) % 60).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00${sign}${oh}:${om}`;
}

function keyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
