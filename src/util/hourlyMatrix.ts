// Shared "activity by hour" matrix for the rhythm and punchcard charts.
//
// Source: canonical window events (window ∩ not-afk), same as the Timeline
// barchart. All requests share ONE server query anchored at today (the
// 60-day canonical query costs ~2s of the server's single-threaded
// datastore time, so it must not run per browsed date); older end dates
// are sliced out of the anchored result locally. The tiny (60×24 numbers)
// matrix is persisted to localStorage so page reloads skip the query too.

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
const LS_KEY = 'aw-hourly-matrix';
const ANCHOR_DAYS = 60;

interface AnchorPayload {
  at: number;
  days: string[];
  matrix: number[][];
}

let anchorPromise: Promise<AnchorPayload> | null = null;

function startOfTodayLocal(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function readPersisted(): AnchorPayload | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.days) || Date.now() - parsed.at > CACHE_TTL_MS) {
      return null;
    }
    return parsed as AnchorPayload;
  } catch {
    return null;
  }
}

function loadAnchor(): Promise<AnchorPayload> {
  const persisted = readPersisted();
  if (persisted) {
    return Promise.resolve(persisted);
  }
  if (!anchorPromise) {
    anchorPromise = fetchDailyHourlyActivity(ANCHOR_DAYS, startOfTodayLocal())
      .then(res => {
        const payload: AnchorPayload = { at: Date.now(), ...res };
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(payload));
        } catch {
          /* storage full/disabled — in-memory only */
        }
        return payload;
      })
      .catch(err => {
        anchorPromise = null;
        throw err;
      });
  }
  return anchorPromise;
}

/** Activity matrix for the nDays ending at endDate (default: today). */
export async function getDailyHourlyActivity(
  nDays: number,
  endDate?: Date
): Promise<DailyHourlyMatrix> {
  const anchor = await loadAnchor();
  const end = endDate || startOfTodayLocal();
  const endKey = keyOf(new Date(end.getFullYear(), end.getMonth(), end.getDate()));
  const endIdx = anchor.days.indexOf(endKey);
  const lastIdx = endIdx >= 0 ? endIdx : anchor.days.length - 1;
  const firstIdx = Math.max(lastIdx - nDays + 1, 0);
  return {
    days: anchor.days.slice(firstIdx, lastIdx + 1),
    matrix: anchor.matrix.slice(firstIdx, lastIdx + 1),
  };
}

async function fetchDailyHourlyActivity(nDays: number, endDate: Date): Promise<DailyHourlyMatrix> {
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

  const periods: string[] = [];
  const dayKeys: string[] = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const s = new Date(endDate.getTime() - i * 86400000);
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
