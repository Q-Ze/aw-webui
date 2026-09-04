// Shared analysis helpers for the focus-session and switch-rate
// visualizations: one categorized-window-events query plus the pure
// client-side computations on top of it.

import moment from 'moment';
import _ from 'lodash';

import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';
import { useCategoryStore } from '~/stores/categories';
import { buildMultideviceHostParams } from '~/util/multidevice';
import { IEvent } from '~/util/interfaces';

export interface FocusSession {
  start: string;
  end: string;
  duration: number;
  category: string;
}

/**
 * Fetch afk-filtered, categorized WINDOW events (chronological, NOT merged
 * by category — session/switch analysis needs the raw event sequence) for
 * the hosts visible to the current multidevice setting, restricted to
 * [start, end).
 */
// Short-TTL cache: focus-sessions and switch-rate (and the timespiral on
// short ranges) ask for the same day repeatedly — one query serves them all.
const fetchCache = new Map<string, { at: number; promise: Promise<IEvent[]> }>();
const FETCH_TTL_MS = 15000;

export function fetchCategorizedWindowEvents(
  start: moment.Moment,
  end: moment.Moment
): Promise<IEvent[]> {
  const key = `${start.valueOf()}|${end.valueOf()}`;
  const hit = fetchCache.get(key);
  if (hit && Date.now() - hit.at < FETCH_TTL_MS) {
    return hit.promise;
  }
  const promise = fetchCategorizedWindowEventsUncached(start, end);
  fetchCache.set(key, { at: Date.now(), promise });
  promise.catch(() => fetchCache.delete(key));
  return promise;
}

async function fetchCategorizedWindowEventsUncached(
  start: moment.Moment,
  end: moment.Moment
): Promise<IEvent[]> {
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  await bucketsStore.ensureLoaded();
  // Categories come from server settings; loading is sync but must happen
  // after settings are in, or categorize() gets an empty rule set and every
  // event lands in Uncategorized.
  const settingsStore = useSettingsStore();
  await settingsStore.ensureLoaded();
  categoryStore.load();

  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) return [];

  // Build a canonicalEvents-style query per host, union the hosts, categorize,
  // and return the raw event list (no merge_events_by_keys).
  const categoriesStr = JSON.stringify(categoryStore.classes_for_query).replace(/\\\\/g, '\\');
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
  q.push(`events = categorize(events, ${categoriesStr});`);
  q.push('RETURN = {"events": events};');

  const period = `${start.clone().utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${end
    .clone()
    .utc()
    .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
  const data = await getClient().query([period], q, { name: 'windowAnalysisQuery' });

  // aw-client returns one object per period ({ events: [...] }).
  const result = data && data[0];
  const events = (result && (result.events || (result[0] && result[0].events))) || [];
  return events as IEvent[];
}

/**
 * Identify focus sessions: maximal runs of consecutive events in the same
 * category whose total uninterrupted duration reaches minMinutes. Small gaps
 * between same-category events (up to gapToleranceSec, e.g. the fan-out of
 * tiny events) do not break a session.
 */
export function sessionsFromEvents(
  events: IEvent[],
  minMinutes: number,
  gapToleranceSec = 60
): FocusSession[] {
  const sorted = _.orderBy(
    events.filter(e => e.duration > 0 && e.data && e.data['$category']),
    e => moment(e.timestamp).valueOf()
  );
  const sessions: FocusSession[] = [];
  let cur: { start: moment.Moment; end: moment.Moment; category: string } | null = null;

  const flush = () => {
    if (cur && cur.end.diff(cur.start, 'seconds') >= minMinutes * 60) {
      sessions.push({
        start: cur.start.toISOString(),
        end: cur.end.toISOString(),
        duration: cur.end.diff(cur.start, 'seconds'),
        category: cur.category,
      });
    }
    cur = null;
  };

  for (const e of sorted) {
    const cat = (e.data['$category'] as string[]).join(' > ');
    const start = moment(e.timestamp);
    const end = start.clone().add(e.duration, 'seconds');
    if (cur && cur.category === cat && start.diff(cur.end, 'seconds') <= gapToleranceSec) {
      cur.end = moment.max(cur.end, end);
    } else {
      flush();
      cur = { start, end, category: cat };
    }
  }
  flush();
  return sessions;
}

/**
 * Category-switch counts per hour of day (0-23), averaged per day covered by
 * the events. A "switch" is an adjacent pair of events whose category
 * changed, attributed to the hour of the later event.
 */
export function switchesPerHour(events: IEvent[]): { counts: number[]; days: number } {
  const counts = new Array(24).fill(0);
  const sorted = _.orderBy(
    events.filter(e => e.data && e.data['$category']),
    e => moment(e.timestamp).valueOf()
  );
  const days = new Set<string>();
  let prevCat: string | null = null;
  for (const e of sorted) {
    const cat = (e.data['$category'] as string[]).join(' > ');
    const start = moment(e.timestamp);
    days.add(start.format('YYYY-MM-DD'));
    if (prevCat !== null && cat !== prevCat) {
      counts[start.hour()] += 1;
    }
    prevCat = cat;
  }
  const nDays = days.size || 1;
  return { counts: counts.map(c => c / nDays), days: days.size };
}
