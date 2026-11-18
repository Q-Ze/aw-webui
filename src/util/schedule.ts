// Manual schedule entries stored as events in a server-side bucket.
//
// Storage design:
// - One bucket per machine: aw-webui-schedule_<hostname>, type aw-webui-schedule
// - Reading unions ALL schedule buckets discovered by id prefix (the synced
//   variants carry "-synced-from-*" suffixes, exactly like window/afk buckets —
//   hostname equality matching would silently drop the other machine's entries)
// - Writes always target the local machine's bucket; aw-sync carries them to
//   the other machine within one pull/push cycle (≤5 min)
//
// Event shape: { timestamp: ISO (entry start), duration: seconds,
//               data: { title, notes?, allDay? } }

import _ from 'lodash';
import moment from 'moment';

import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useServerStore } from '~/stores/server';
import { buildMultideviceHostParams } from '~/util/multidevice';
import { IEvent } from '~/util/interfaces';

export const SCHEDULE_TYPE = 'aw-webui-schedule';
const SCHEDULE_PREFIX = 'aw-webui-schedule_';

export interface ScheduleEntryData {
  title: string;
  notes?: string;
  allDay?: boolean;
  /** Persistent logical identity, used to merge synced copies of one entry. */
  uid?: string;
}

// Server events already carry an optional id (needed for replace/delete);
// _bucket_id records the origin bucket (set in fetchSchedule).
export type ScheduleEntry = IEvent & { data: ScheduleEntryData & Record<string, any> };

async function localHostname(): Promise<string> {
  const serverStore = useServerStore();
  if (!serverStore.info) await serverStore.getInfo();
  return serverStore.info.hostname;
}

export async function localScheduleBucketId(): Promise<string> {
  return SCHEDULE_PREFIX + (await localHostname());
}

/** All schedule buckets on this server (own + synced from peers). */
export function scheduleBucketIds(): string[] {
  const bucketsStore = useBucketsStore();
  return bucketsStore.buckets.filter(b => b.id.startsWith(SCHEDULE_PREFIX)).map(b => b.id);
}

/** Create the local schedule bucket if it doesn't exist yet. */
export async function ensureScheduleBucket(): Promise<string> {
  const bucketsStore = useBucketsStore();
  await bucketsStore.ensureLoaded();
  const hostname = await localHostname();
  const id = SCHEDULE_PREFIX + hostname;
  if (!scheduleBucketIds().includes(id)) {
    await getClient().createBucket(id, SCHEDULE_TYPE, hostname);
    await bucketsStore.loadBuckets();
  }
  return id;
}

/** Fetch all schedule entries overlapping [start, end), merged across buckets. */
export async function fetchSchedule(start: moment.Moment, end: moment.Moment): Promise<ScheduleEntry[]> {
  const client = getClient();
  // Wait for the bucket list: landing directly on /schedule races Header's
  // background load, and an empty list here would render an empty calendar
  // with no later refresh to fix it.
  const bucketsStore = useBucketsStore();
  await bucketsStore.ensureLoaded();
  const ids = scheduleBucketIds();
  const params = { start: start.toDate(), end: end.toDate(), limit: -1 };
  // A failed bucket read must surface as an error, not as "no schedules":
  // the page shows a load-error banner so the user can tell an empty calendar
  // apart from a broken one.
  const lists = await Promise.all(
    ids.map(async id => {
      const evs = (await client.getEvents(id, params)) as unknown as ScheduleEntry[];
      // Remember the origin bucket so edits/deletes target the right one.
      evs.forEach(e => ((e as any)._bucket_id = id));
      return evs;
    })
  );
  const entries = (_.flatten(lists) as ScheduleEntry[]).filter(e => e && e.data && e.data.title);
  return _.orderBy(dedupeScheduleEntries(entries), e => moment(e.timestamp).valueOf());
}

/**
 * Merge the same logical entry seen in multiple buckets (its origin bucket on
 * the origin machine, synced copies elsewhere). Identity is the persistent
 * `data.uid` assigned at creation; content equality alone is NOT enough —
 * two genuinely different entries can share time+duration+title. Entries
 * without a uid (created before uids existed) are all kept: never silently
 * hidden by a content match.
 */
export function dedupeScheduleEntries(entries: ScheduleEntry[]): ScheduleEntry[] {
  const byUid = new Map<string, ScheduleEntry>();
  const rest: ScheduleEntry[] = [];
  for (const e of entries) {
    const uid = e.data && e.data.uid;
    if (typeof uid === 'string' && uid.length > 0) {
      if (!byUid.has(uid)) byUid.set(uid, e);
    } else {
      rest.push(e);
    }
  }
  return [...byUid.values(), ...rest];
}

/**
 * Fresh identity for a newly created entry (survives sync-side renaming).
 * crypto.randomUUID needs a secure context; over plain HTTP on the LAN it is
 * undefined, so fall back to an RFC4122-v4-shaped id from Math.random —
 * collision odds are irrelevant for one user's calendar.
 */
export function newEntryUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Save an entry: edits go back to the bucket the entry was fetched from
 * (its id is only valid there); new entries are created in the local bucket.
 *
 * Limitation: editing an entry that originated on the other machine only
 * changes this machine's view of that synced bucket — aw-sync pushes each
 * machine's own buckets, so the edit does not travel back. The origin
 * machine keeps its version (and a full re-sync could resurrect it).
 * Cross-machine edits of the same entry should be made where it was created.
 */
export async function saveEntry(entry: ScheduleEntry): Promise<void> {
  const origin = (entry as any)._bucket_id as string | undefined;
  if (entry.id !== undefined && !origin) {
    // An id is only valid inside the bucket it came from; writing it to the
    // local bucket could overwrite an unrelated local entry. Refuse instead
    // of silently falling back.
    throw new Error('editing an existing entry requires its origin bucket (_bucket_id)');
  }
  const bucketId = origin || (await ensureScheduleBucket());
  if (entry.id !== undefined) {
    await getClient().replaceEvents(bucketId, [entry as any]);
  } else {
    await getClient().insertEvents(bucketId, [entry as any]);
  }
}

export async function deleteEntry(entry: ScheduleEntry): Promise<void> {
  if (entry.id === undefined) {
    throw new Error('cannot delete an entry without an id (not fetched from the server?)');
  }
  // The entry may live in the local bucket or only in a synced copy; try the
  // bucket it was fetched from (recorded in fetchSchedule).
  const bucketId = (entry as any)._bucket_id || (await ensureScheduleBucket());
  await getClient().deleteEvent(bucketId, entry.id);
}

/**
 * Stable identity for a fetched entry: bucket of origin + event id/timestamp.
 * Event ids are only unique per bucket, so a bare id collides across the
 * local bucket and synced copies.
 */
export function entryUid(e: ScheduleEntry): string {
  const origin = (e as any)._bucket_id || '';
  return `${origin}|${e.id ?? e.timestamp}`;
}

// ── 计划 vs 实际 ────────────────────────────────────────────────────────────

export interface EntryActual {
  activeSeconds: number;
  scheduledSeconds: number;
  topApps: { app: string; seconds: number }[];
}

/**
 * For each time-ranged entry of one day, compute the actually-tracked active
 * time inside the entry's span plus the top apps of that span. One query for
 * the whole day (window ∩ not-afk, unioned across devices — same hardened
 * pattern as the rest of the webui), overlap computed client-side.
 */
export interface DayActual {
  byEntry: Map<string, EntryActual>;
  /** Active seconds per hour of day (0-23), for the timeline backdrop. */
  hourly: number[];
}

export async function fetchActualForDay(
  day: moment.Moment,
  entries: ScheduleEntry[]
): Promise<DayActual> {
  const result = new Map<string, EntryActual>();
  const hourly = new Array(24).fill(0);
  const ranged = entries.filter(e => !e.data.allDay && (e.duration || 0) > 0);
  if (ranged.length === 0) return { byEntry: result, hourly };

  const bucketsStore = useBucketsStore();
  await bucketsStore.ensureLoaded();
  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) return { byEntry: result, hourly };

  const vars = queryVarNames(
    hosts_with_buckets.filter(host => host_params[host] && 'bid_window' in host_params[host])
  );
  const q: string[] = [];
  hosts_with_buckets.forEach(host => {
    const p = host_params[host];
    if (!p || !('bid_window' in p)) return;
    const v = vars.get(host)!;
    q.push(`events_${v} = flood(query_bucket("${p.bid_window}"));`);
    q.push(`not_afk_${v} = flood(query_bucket("${p.bid_afk}"));`);
    q.push(`not_afk_${v} = filter_keyvals(not_afk_${v}, "status", ["not-afk"]);`);
    q.push(`events_${v} = filter_period_intersect(events_${v}, not_afk_${v});`);
  });
  q.push('events = [];');
  for (const v of vars.values()) {
    q.push(`events = union_no_overlap(events, events_${v});`);
  }
  q.push('RETURN = {"events": events};');

  // Day boundaries anchored to the queried day's calendar bounds in local time.
  const start = day.clone().startOf('day');
  const end = start.clone().add(1, 'day');
  const period = `${start.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${end
    .utc()
    .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
  const data = await getClient().query([period], q, { name: 'scheduleActualQuery' });
  const events: IEvent[] = (data?.[0]?.events as IEvent[]) || [];

  // Hourly backdrop from the same event stream (clipped to the day + now).
  const dayStart = start.valueOf();
  const nowMs = Date.now();
  for (const ev of events) {
    let s = moment(ev.timestamp).valueOf();
    let e = s + (ev.duration || 0) * 1000;
    s = Math.max(s, dayStart);
    e = Math.min(e, dayStart + 86400000, nowMs);
    if (e <= s) continue;
    let cur = new Date(s);
    const endD = new Date(e);
    while (cur < endD) {
      const nextHour = new Date(cur);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      const segEnd = endD < nextHour ? endD : nextHour;
      const sec = (segEnd.getTime() - cur.getTime()) / 1000;
      if (sec > 0) hourly[cur.getHours()] += sec;
      cur = segEnd;
    }
  }

  for (const entry of ranged) {
    const es = moment(entry.timestamp);
    const ee = es.clone().add(entry.duration, 'seconds');
    const scheduledSeconds = entry.duration;
    let activeSeconds = 0;
    const apps = new Map<string, number>();
    for (const ev of events) {
      const s = moment(ev.timestamp);
      const e = s.clone().add(ev.duration, 'seconds');
      const os = moment.max(s, es);
      const oe = moment.min(e, ee);
      const sec = oe.diff(os, 'seconds');
      if (sec > 0) {
        activeSeconds += sec;
        const app = (ev.data && ev.data.app) || '(unknown)';
        apps.set(app, (apps.get(app) || 0) + sec);
      }
    }
    result.set(entryUid(entry), {
      activeSeconds,
      scheduledSeconds,
      topApps: [...apps.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([app, seconds]) => ({ app, seconds })),
    });
  }
  return { byEntry: result, hourly };
}

/**
 * Unique query-variable suffixes per host. Sanitized hostnames alone collide
 * ("work-laptop" and "worklaptop" both become "worklaptop", and the second
 * device's assignment silently overwrites the first), so every suffix
 * carries the host's index.
 */
export function queryVarNames(hosts: string[]): Map<string, string> {
  const m = new Map<string, string>();
  hosts.forEach((h, i) => m.set(h, `h${i}_${h.replace(/[^a-zA-Z0-9_]/g, '')}`));
  return m;
}

// ── helpers for the view ────────────────────────────────────────────────────

export function entryColor(title: string): string {
  // Stable pastel per title hash so recurring entries keep their color.
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 65%, 80%)`;
}

export function fmtTime(m: moment.Moment): string {
  return m.format('HH:mm');
}
