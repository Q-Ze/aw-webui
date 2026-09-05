// Annual report data layer: one per-day not-afk totals query for the year
// (same shape as the calendar heatmap query, proven against the
// single-threaded server) plus one category-totals query. Results are cached
// per year in localStorage — past years permanently, the current year with a
// TTL so revisits are instant.

import moment from 'moment';
import _ from 'lodash';

import queries from '~/queries';
import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';
import { useCategoryStore } from '~/stores/categories';
import { buildMultideviceHostParams } from '~/util/multidevice';

export interface NameSec {
  name: string;
  sec: number;
}

export interface BusiestPeriod {
  /** display key: date / week start / month label */
  key: string;
  sec: number;
  cats: NameSec[];
  apps: NameSec[];
}

export interface BootShutdown {
  /** earliest 4am-day start, real clock hour + minute */
  firstBoot: { date: string; hour: number; minute: number } | null;
  /** latest 4am-day end; real clock hour + minute; pastMidnight = after 00:00 */
  lastShutdown: { date: string; hour: number; minute: number; pastMidnight: boolean } | null;
  /** share of active days (4am-day) that ran past real midnight */
  lateNightPct: number;
  totalDays: number;
}

export interface YearReport {
  v: 5;
  /** lite = daily totals + top categories/apps only (skips the expensive
   *  monthly hourly batches); used for cross-year comparison. */
  lite?: boolean;
  year: number;
  /** seconds of not-afk time per day, keyed YYYY-MM-DD */
  byDate: Record<string, number>;
  /** top [category name, seconds] for the year */
  categories: [string, number][];
  /** top [app name, seconds] for the year */
  apps: [string, number][];
  /** seconds of activity per hour-of-day, from sampled weeks (index 0-23) */
  hourly: number[];
  /** weekday(Mon-first 0-6) × real hour(0-23) active seconds, sampled weeks */
  weekdayHour: number[][];
  busiest: { day: BusiestPeriod | null; week: BusiestPeriod | null; month: BusiestPeriod | null };
  boot: BootShutdown;
  computedAt: number;
}

export interface YearReportStats {
  totalSec: number;
  activeDays: number;
  avgHoursPerActiveDay: number;
  busiestDay: { date: string; sec: number } | null;
  monthly: { month: number; label: string; sec: number }[];
  weekdayAvgSec: number; // Mon–Fri average per active day
  weekendAvgSec: number; // Sat–Sun average per active day
  busiestWeek: { start: string; end: string; sec: number } | null;
  longestStreak: { start: string; days: number } | null;
  halfYear: { first: number; second: number }; // seconds
  chronotype: {
    label: string;
    peakHour: number;
    dayparts: { night: number; morning: number; afternoon: number; evening: number };
  };
}

const REPORT_VERSION = 5 as const;
const LS_KEY = 'aw-annual-report';
const CURRENT_YEAR_TTL_MS = 6 * 3600 * 1000;

function readCache(): Record<string, YearReport> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}

export function getCachedYearReport(year: number): YearReport | null {
  const entry = readCache()[String(year)];
  if (!entry || (entry as any).v !== REPORT_VERSION) return null;
  if (year === moment().year() && Date.now() - entry.computedAt > CURRENT_YEAR_TTL_MS) {
    return null;
  }
  return entry;
}

function afkBucketsForQuery(): string[] {
  const bucketsStore = useBucketsStore();
  const settingsStore = useSettingsStore();
  let afk: string[] = [];
  if (settingsStore.useMultidevice) {
    afk = _.flatten(
      bucketsStore.hosts
        .filter(h => h && !h.startsWith('fakedata'))
        .map(h => bucketsStore.bucketsAFK(h))
    );
  } else {
    afk = [bucketsStore.bucketsAFK(bucketsStore.hosts.find(h => h) || '')[0]];
  }
  return afk.filter(Boolean);
}

async function fetchYearDaily(year: number): Promise<Record<string, number>> {
  const bucketsStore = useBucketsStore();
  await bucketsStore.ensureLoaded();
  const settingsStore = useSettingsStore();
  await settingsStore.ensureLoaded();

  const afk = afkBucketsForQuery();
  if (afk.length === 0) return {};

  const q = [
    'events = [];',
    ...afk.map(bid => `events = union_no_overlap(events, flood(query_bucket("${bid}")));`),
    'events = filter_keyvals(events, "status", ["not-afk"]);',
    'duration = sum_durations(events);',
    'RETURN = {"duration": duration};',
  ];

  const now = moment();
  const isCurrentYear = year === now.year();
  // Current year: stop at today; past years: full 12 months.
  const start = moment({ year, month: 0, date: 1 });
  const end = isCurrentYear
    ? now.clone().startOf('day')
    : moment({ year: year + 1, month: 0, date: 1 }).subtract(1, 'day');

  const periods: string[] = [];
  const dayKeys: string[] = [];
  for (let d = start.clone(); d.isSameOrBefore(end); d.add(1, 'day')) {
    const dayStart = d.format('YYYY-MM-DDT00:00:00+00:00');
    const nextDay = d.clone().add(1, 'day').format('YYYY-MM-DDT00:00:00+00:00');
    periods.push(`${dayStart}/${nextDay}`);
    dayKeys.push(d.format('YYYY-MM-DD'));
  }

  const data = await getClient().query(periods, q, { name: 'annualDailyQuery' });
  const byDate: Record<string, number> = {};
  _.each(periods, (_p, i) => {
    const res = data && data[i];
    const dur = (res && (res.duration ?? (res[0] && res[0].duration) ?? 0)) || 0;
    byDate[dayKeys[i]] = dur as number;
  });
  return byDate;
}

async function fetchYearCategories(year: number): Promise<[string, number][]> {
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  const settingsStore = useSettingsStore();
  // Buckets + categories both need explicit loading before building the
  // query, otherwise hosts/rules are empty and everything returns [].
  await bucketsStore.ensureLoaded();
  await settingsStore.ensureLoaded();
  categoryStore.load();
  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) return [];

  const q = queries.categoryQuery({
    hosts: hosts_with_buckets,
    filter_afk: true,
    categories: categoryStore.classes_for_query,
    filter_categories: null,
    host_params,
    always_active_pattern: '',
  } as any);

  const now = moment();
  const start = moment({ year, month: 0, date: 1 });
  const end = year === now.year() ? now : moment({ year: year + 1, month: 0, date: 1 });
  const tp = `${start.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${end
    .utc()
    .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;

  const data = await getClient().query([tp], q, { name: 'annualCategoryQuery' });
  const r = data && data[0];
  const catEvents = (r && (r.cat_events || (r[0] && r[0].cat_events))) || [];
  return _.take(
    _.orderBy(
      (catEvents as any[])
        .filter(e => e.data && e.data['$category'])
        .map(
          e => [(e.data['$category'] as string[]).join(' > '), e.duration || 0] as [string, number]
        ),
      ([, v]) => -v
    ),
    8
  );
}

async function fetchYearApps(year: number): Promise<[string, number][]> {
  const bucketsStore = useBucketsStore();
  await bucketsStore.ensureLoaded();
  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) return [];

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
  q.push('app_events = sort_by_duration(merge_events_by_keys(events, ["app"]));');
  q.push('app_events = limit_events(app_events, 10);');
  q.push('RETURN = {"app_events": app_events};');

  const now = moment();
  const start = moment({ year, month: 0, date: 1 });
  const end = year === now.year() ? now : moment({ year: year + 1, month: 0, date: 1 });
  const tp = `${start.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${end
    .utc()
    .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
  const data = await getClient().query([tp], q, { name: 'annualAppQuery' });
  const r = data && data[0];
  const appEvents = (r && (r.app_events || (r[0] && r[0].app_events))) || [];
  return _.take(
    _.orderBy(
      (appEvents as any[])
        .filter(e => e.data && e.data.app)
        .map(e => [e.data.app as string, e.duration || 0] as [string, number]),
      ([, v]) => -v
    ),
    5
  );
}

/** Full-year hour detail: hour-of-day profile, weekday×hour grid, and per
 *  4am-day first/last active hours (boot/shutdown + late-night share).
 *  Queried in sequential monthly batches (≈720 hour-periods each) so the
 *  single-threaded server is never hit with all 8760 periods at once. */
async function fetchYearSamples(year: number): Promise<{
  hourly: number[];
  weekdayHour: number[][];
  boot: BootShutdown;
}> {
  const bucketsStore = useBucketsStore();
  const settingsStore = useSettingsStore();
  await bucketsStore.ensureLoaded();
  await settingsStore.ensureLoaded();
  const afk = afkBucketsForQuery();
  const empty = {
    hourly: new Array(24).fill(0),
    weekdayHour: _.range(7).map(() => new Array(24).fill(0)),
    boot: { firstBoot: null, lastShutdown: null, lateNightPct: 0, totalDays: 0 } as BootShutdown,
  };
  if (afk.length === 0) return empty;

  const q = [
    'events = [];',
    ...afk.map(bid => `events = union_no_overlap(events, flood(query_bucket("${bid}")));`),
    'events = filter_keyvals(events, "status", ["not-afk"]);',
    'duration = sum_durations(events);',
    'RETURN = {"duration": duration};',
  ];

  const now = moment();
  const yearEnd =
    year === now.year()
      ? now.clone().startOf('day')
      : moment({ year: year + 1, month: 0, date: 1 }).subtract(1, 'day');

  // Exact full-year hour data, queried in sequential monthly batches so the
  // single-threaded server is never hit with all 8760 periods at once.
  const yearStart = moment({ year, month: 0, date: 1 });
  const hourly = new Array(24).fill(0);
  const weekdayHour = _.range(7).map(() => new Array(24).fill(0));
  // 4am-day bookkeeping: shifted hour sh = (h - 4 + 24) % 24; a real-hour h<4
  // belongs to the PREVIOUS calendar date's 4am-day.
  const dayFirst: Record<string, number> = {};
  const dayLast: Record<string, number> = {};
  const THRESH = 60; // an hour counts as active past 60s

  for (
    let monthStart = yearStart.clone();
    monthStart.isSameOrBefore(yearEnd, 'day');
    monthStart.add(1, 'month')
  ) {
    const monthEnd = moment.min(monthStart.clone().endOf('month').startOf('day'), yearEnd);
    const periods: string[] = [];
    const meta: { date: string; hour: number; weekday: number }[] = [];
    for (let d = monthStart.clone(); d.isSameOrBefore(monthEnd); d.add(1, 'day')) {
      for (let h = 0; h < 24; h++) {
        const s = d.clone().add(h, 'hours');
        const e = s.clone().add(1, 'hour');
        periods.push(
          `${s.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${e.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}`
        );
        meta.push({ date: d.format('YYYY-MM-DD'), hour: h, weekday: (d.day() + 6) % 7 });
      }
    }
    if (periods.length === 0) continue;
    const data = await getClient().query(periods, q, { name: 'annualHourlyQuery' });
    _.each(periods, (_p, i) => {
      const res = data && data[i];
      const dur = ((res && (res.duration ?? (res[0] && res[0].duration) ?? 0)) || 0) as number;
      const { date, hour: h, weekday } = meta[i];
      hourly[h] += dur;
      weekdayHour[weekday][h] += dur;
      if (dur >= THRESH) {
        const sh = (h - 4 + 24) % 24;
        const dayKey = h < 4 ? moment(date).subtract(1, 'day').format('YYYY-MM-DD') : date;
        if (dayFirst[dayKey] === undefined || sh < dayFirst[dayKey]) dayFirst[dayKey] = sh;
        if (dayLast[dayKey] === undefined || sh > dayLast[dayKey]) dayLast[dayKey] = sh;
      }
    });
  }
  const dayKeys = Object.keys(dayFirst);
  if (dayKeys.length === 0) {
    return {
      hourly,
      weekdayHour,
      boot: {
        firstBoot: null,
        lastShutdown: null,
        lateNightPct: 0,
        totalDays: 0,
      } as BootShutdown,
    };
  }

  let firstBoot: BootShutdown['firstBoot'] = null;
  let lastShutdown: BootShutdown['lastShutdown'] = null;
  let late = 0;
  for (const k of dayKeys) {
    const f = dayFirst[k];
    const l = dayLast[k];
    if (firstBoot === null || f < dayFirst[firstBoot.date]) {
      firstBoot = { date: k, hour: (f + 4) % 24, minute: 0 };
    }
    if (lastShutdown === null || l > dayLast[lastShutdown.date]) {
      lastShutdown = { date: k, hour: (l + 4) % 24, minute: 0, pastMidnight: l >= 20 };
    }
    if (l >= 20) late += 1; // activity past real midnight
  }

  // Drill the two record-setting hours down to 5-minute blocks for a
  // human-looking time instead of a bare clock hour.
  const drillMinute = async (
    dayKey: string,
    realHour: number,
    dir: 'first' | 'last'
  ): Promise<number> => {
    // Real timestamp base: hour < 4 belongs to the next calendar day of the
    // 4am-day key.
    const base = moment(dayKey)
      .add(realHour < 4 ? 1 : 0, 'days')
      .add(realHour, 'hours');
    const periods = _.range(12).map(i => {
      const s = base.clone().add(i * 5, 'minutes');
      const e = s.clone().add(5, 'minutes');
      return `${s.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${e
        .utc()
        .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
    });
    try {
      const data = await getClient().query(periods, q, { name: 'annualMinuteQuery' });
      const durs = periods.map(
        (_p, i) =>
          ((data && data[i] && (data[i].duration ?? (data[i][0] && data[i][0].duration))) ||
            0) as number
      );
      const active = durs.map((d, i) => (d >= 15 ? i : -1)).filter(i => i >= 0);
      if (active.length === 0) return 0;
      const idx = dir === 'first' ? active[0] : active[active.length - 1];
      return idx * 5;
    } catch {
      return 0;
    }
  };

  if (firstBoot) {
    firstBoot.minute = await drillMinute(firstBoot.date, firstBoot.hour, 'first');
  }
  if (lastShutdown) {
    lastShutdown.minute = await drillMinute(lastShutdown.date, lastShutdown.hour, 'last');
    // 收工时刻 = 最后一个活跃块的结束
    lastShutdown.minute = Math.min(lastShutdown.minute + 5, 59);
  }

  const boot: BootShutdown = {
    firstBoot,
    lastShutdown,
    lateNightPct: dayKeys.length ? Math.round((late / dayKeys.length) * 100) : 0,
    totalDays: dayKeys.length,
  };
  return { hourly, weekdayHour, boot };
}

/** What was done during the busiest day / week / month: one canonical query
 *  with three periods, returning categorized + app-merged events for each. */
async function fetchBusiestWhat(
  year: number,
  targets: { day?: string; weekStart?: string; month?: number }
): Promise<YearReport['busiest']> {
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  const settingsStore = useSettingsStore();
  await bucketsStore.ensureLoaded();
  await settingsStore.ensureLoaded();
  categoryStore.load();
  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) {
    return { day: null, week: null, month: null };
  }

  const cats = JSON.stringify(categoryStore.classes_for_query).replace(/\\\\/g, '\\');
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
  q.push(`events = categorize(events, ${cats});`);
  q.push('cat_events = sort_by_duration(merge_events_by_keys(events, ["$category"]));');
  q.push('app_events = sort_by_duration(merge_events_by_keys(events, ["app"]));');
  q.push('RETURN = {"cat_events": cat_events, "app_events": app_events};');

  const iso = (a: moment.Moment, b: moment.Moment) =>
    `${a.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${b.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
  const periods: string[] = [];
  const kinds: ('day' | 'week' | 'month')[] = [];
  if (targets.day) {
    const d = moment(targets.day);
    periods.push(iso(d, d.clone().add(1, 'day')));
    kinds.push('day');
  }
  if (targets.weekStart) {
    const w = moment(targets.weekStart);
    periods.push(iso(w, w.clone().add(7, 'days')));
    kinds.push('week');
  }
  if (targets.month !== undefined) {
    const m = moment({ year, month: targets.month, date: 1 });
    periods.push(iso(m, m.clone().add(1, 'month')));
    kinds.push('month');
  }
  if (periods.length === 0) return { day: null, week: null, month: null };

  const data = await getClient().query(periods, q, { name: 'annualBusiestQuery' });
  const parse = (i: number): { cats: NameSec[]; apps: NameSec[] } => {
    const r = data && data[i];
    const catEvents = (r && (r.cat_events || (r[0] && r[0].cat_events))) || [];
    const appEvents = (r && (r.app_events || (r[0] && r[0].app_events))) || [];
    const cats = _.take(
      _.orderBy(
        (catEvents as any[])
          .filter(e => e.data && e.data['$category'])
          .map(e => ({
            name: (e.data['$category'] as string[]).join(' > '),
            sec: e.duration || 0,
          })),
        c => -c.sec
      ),
      3
    );
    const apps = _.take(
      _.orderBy(
        (appEvents as any[])
          .filter(e => e.data && e.data.app)
          .map(e => ({ name: e.data.app as string, sec: e.duration || 0 })),
        a => -a.sec
      ),
      3
    );
    return { cats, apps };
  };

  const out: YearReport['busiest'] = { day: null, week: null, month: null };
  _.each(kinds, (kind, i) => {
    const { cats, apps } = parse(i);
    if (kind === 'day' && targets.day) {
      out.day = { key: targets.day, sec: 0, cats, apps };
    } else if (kind === 'week' && targets.weekStart) {
      out.week = { key: targets.weekStart, sec: 0, cats, apps };
    } else if (kind === 'month' && targets.month !== undefined) {
      out.month = {
        key: moment({ year, month: targets.month }).format('YYYY年M月'),
        sec: 0,
        cats,
        apps,
      };
    }
  });
  return out;
}

export async function getYearReport(year: number, force = false): Promise<YearReport> {
  if (!force) {
    const cached = getCachedYearReport(year);
    if (cached) return cached;
  }
  const [byDate, categories, apps, samples] = await Promise.all([
    fetchYearDaily(year),
    fetchYearCategories(year),
    fetchYearApps(year),
    fetchYearSamples(year),
  ]);

  // Busiest candidates from the daily totals, then one query for "what".
  const entries = _.toPairs(byDate).filter(([, sec]) => sec >= 60);
  const dayTop = entries.length ? _.maxBy(entries, ([, sec]) => sec) : null;
  const byWeek: Record<string, number> = {};
  const byMonth: Record<number, number> = {};
  for (const [date, sec] of entries) {
    const k = moment(date).startOf('isoWeek').format('YYYY-MM-DD');
    byWeek[k] = (byWeek[k] || 0) + sec;
    const m = moment(date).month();
    byMonth[m] = (byMonth[m] || 0) + sec;
  }
  const weekTop = _.maxBy(_.toPairs(byWeek), ([, sec]) => sec);
  const monthTop = _.maxBy(_.toPairs(byMonth), ([, sec]) => sec);
  const busiest = await fetchBusiestWhat(year, {
    day: dayTop ? dayTop[0] : undefined,
    weekStart: weekTop ? weekTop[0] : undefined,
    month: monthTop ? parseInt(monthTop[0], 10) : undefined,
  });
  if (busiest.day && dayTop) busiest.day.sec = dayTop[1];
  if (busiest.week && weekTop) busiest.week.sec = weekTop[1];
  if (busiest.month && monthTop) busiest.month.sec = monthTop[1];

  const report: YearReport = {
    v: REPORT_VERSION,
    year,
    byDate,
    categories,
    apps,
    hourly: samples.hourly,
    weekdayHour: samples.weekdayHour,
    busiest,
    boot: samples.boot,
    computedAt: Date.now(),
  };
  try {
    const cache = readCache();
    cache[String(year)] = report;
    localStorage.setItem(LS_KEY, JSON.stringify(cache));
  } catch {
    /* storage full/disabled — in-memory only */
  }
  return report;
}

/** Lightweight year report for cross-year comparison: daily totals + top
 *  categories/apps, skipping the expensive monthly hourly batches. Past
 *  years cache permanently, so the comparison loads instantly after the
 *  first visit. */
export async function getYearReportLite(year: number): Promise<YearReport> {
  const cached = getCachedYearReport(year);
  if (cached) return cached;
  const [byDate, categories, apps] = await Promise.all([
    fetchYearDaily(year),
    fetchYearCategories(year),
    fetchYearApps(year),
  ]);
  const report: YearReport = {
    v: REPORT_VERSION,
    lite: true,
    year,
    byDate,
    categories,
    apps,
    hourly: new Array(24).fill(0),
    weekdayHour: _.range(7).map(() => new Array(24).fill(0)),
    busiest: { day: null, week: null, month: null },
    boot: { firstBoot: null, lastShutdown: null, lateNightPct: 0, totalDays: 0 },
    computedAt: Date.now(),
  };
  try {
    const cache = readCache();
    cache[String(year)] = report;
    localStorage.setItem(LS_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  return report;
}

export function computeStats(report: YearReport): YearReportStats {
  const entries = _.toPairs(report.byDate).filter(([, sec]) => sec >= 60);
  const totalSec = _.sumBy(entries, ([, sec]) => sec);
  const activeDays = entries.length;
  const busiest = entries.length ? _.maxBy(entries, ([, sec]) => sec) : null;

  const monthSec = new Array(12).fill(0);
  const weekdaySec = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
  const weekdayDays = [0, 0, 0, 0, 0, 0, 0];
  for (const [date, sec] of entries) {
    const m = moment(date).month();
    const d = moment(date).day();
    monthSec[m] += sec;
    weekdaySec[d] += sec;
    weekdayDays[d] += 1;
  }
  // Mon..Fri
  const weekdayTotal = _.sum([1, 2, 3, 4, 5].map(i => weekdaySec[i]));
  const weekdayCount = _.sum([1, 2, 3, 4, 5].map(i => weekdayDays[i]));
  const weekendTotal = weekdaySec[0] + weekdaySec[6];
  const weekendCount = weekdayDays[0] + weekdayDays[6];

  // Busiest 7-day window (calendar weeks starting Monday).
  let busiestWeek: YearReportStats['busiestWeek'] = null;
  if (entries.length > 0) {
    const byWeek: Record<string, number> = {};
    for (const [date, sec] of entries) {
      const k = moment(date).startOf('isoWeek').format('YYYY-MM-DD');
      byWeek[k] = (byWeek[k] || 0) + sec;
    }
    const topWeek = _.maxBy(_.toPairs(byWeek), ([, sec]) => sec);
    if (topWeek) {
      busiestWeek = {
        start: topWeek[0],
        end: moment(topWeek[0]).add(6, 'days').format('MM-DD'),
        sec: topWeek[1],
      };
    }
  }

  // Longest run of consecutive active days.
  let longestStreak: YearReportStats['longestStreak'] = null;
  if (entries.length > 0) {
    const sorted = entries.map(([d]) => d).sort();
    let bestStart = sorted[0];
    let bestLen = 1;
    let curStart = sorted[0];
    let curLen = 1;
    for (let i = 1; i < sorted.length; i++) {
      const gap = moment(sorted[i]).diff(moment(sorted[i - 1]), 'days');
      if (gap === 1) {
        curLen += 1;
      } else {
        curStart = sorted[i];
        curLen = 1;
      }
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    }
    longestStreak = { start: bestStart, days: bestLen };
  }

  // Calendar halves (H1 = Jan–Jun, H2 = Jul–Dec).
  const halfYear = {
    first: _.sumBy(entries, ([d, sec]) => (moment(d).month() < 6 ? sec : 0)),
    second: _.sumBy(entries, ([d, sec]) => (moment(d).month() >= 6 ? sec : 0)),
  };

  // Chronotype from the sampled hour-of-day profile.
  const hourly = report.hourly || new Array(24).fill(0);
  const dayparts = {
    night: _.sum(hourly.slice(0, 5)), // 00:00–05:00
    morning: _.sum(hourly.slice(5, 12)), // 05:00–12:00
    afternoon: _.sum(hourly.slice(12, 18)), // 12:00–18:00
    evening: _.sum(hourly.slice(18, 24)), // 18:00–24:00
  };
  const peakHour = hourly.indexOf(_.max(hourly) as number);
  const parts: [keyof typeof dayparts, number][] = [
    ['night', dayparts.night],
    ['morning', dayparts.morning],
    ['afternoon', dayparts.afternoon],
    ['evening', dayparts.evening],
  ];
  const topPart = _.maxBy(parts, ([, v]) => v)?.[0] || 'afternoon';
  const chronotypeLabel: Record<string, string> = {
    night: '夜猫子型',
    morning: '早起鸟型',
    afternoon: '午后发力型',
    evening: '晚间高产型',
  };

  return {
    totalSec,
    activeDays,
    avgHoursPerActiveDay: activeDays ? totalSec / activeDays / 3600 : 0,
    busiestDay: busiest ? { date: busiest[0], sec: busiest[1] } : null,
    monthly: monthSec.map((sec, month) => ({
      month,
      label: moment({ month }).format('MMM'),
      sec,
    })),
    weekdayAvgSec: weekdayCount ? weekdayTotal / weekdayCount : 0,
    weekendAvgSec: weekendCount ? weekendTotal / weekendCount : 0,
    busiestWeek,
    longestStreak,
    halfYear,
    chronotype: {
      label: chronotypeLabel[topPart],
      peakHour: peakHour >= 0 ? peakHour : 12,
      dayparts,
    },
  };
}
