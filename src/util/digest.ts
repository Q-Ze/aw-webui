// LLM activity digest: build a compact activity snapshot for a granularity
// (day/week/month/year), ask an LLM for a 2-3 sentence summary, and cache
// results per granularity+period in localStorage.

import moment from 'moment';
import _ from 'lodash';

import queries from '~/queries';
import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import { buildMultideviceHostParams } from '~/util/multidevice';
import {
  fetchCategorizedWindowEvents,
  sessionsFromEvents,
  switchesPerHour,
} from '~/util/windowAnalysis';
import { callLLM, loadLLMConfig, saveLLMConfig, LLMConfig } from '~/util/aiSummary';
import { seconds_to_duration } from '~/util/time';

export type DigestGranularity = 'day' | 'week' | 'month' | 'year';

export const GRANULARITY_DAYS: Record<DigestGranularity, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const CACHE_KEY = 'aw-digest-cache';
const WEEKLY_STATE_KEY = 'aw-digest-weekly';

export interface DigestCacheEntry {
  dateKey: string; // start date of the covered range
  text: string;
  at: number;
}

function readCache(): Record<string, DigestCacheEntry> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function getCachedDigest(granularity: DigestGranularity): DigestCacheEntry | null {
  const entry = readCache()[granularity];
  if (!entry) return null;
  if (entry.dateKey !== rangeStart(granularity).format('YYYY-MM-DD')) return null;
  return entry;
}

function storeDigest(granularity: DigestGranularity, text: string) {
  const cache = readCache();
  cache[granularity] = {
    dateKey: rangeStart(granularity).format('YYYY-MM-DD'),
    text,
    at: Date.now(),
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export function rangeStart(granularity: DigestGranularity): moment.Moment {
  return moment()
    .startOf('day')
    .subtract(GRANULARITY_DAYS[granularity] - 1, 'days');
}

async function activeSeconds(start: moment.Moment, end: moment.Moment): Promise<number> {
  const bucketsStore = useBucketsStore();
  await bucketsStore.ensureLoaded();
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
  afk = afk.filter(Boolean);
  if (afk.length === 0) return 0;
  const q = [
    'events = [];',
    ...afk.map(bid => `events = union_no_overlap(events, flood(query_bucket("${bid}")));`),
    'events = filter_keyvals(events, "status", ["not-afk"]);',
    'duration = sum_durations(events);',
    'RETURN = {"duration": duration};',
  ];
  const tp = `${start.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${end
    .utc()
    .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
  const data = await getClient().query([tp], q, { name: 'digestActiveQuery' });
  const r = data && data[0];
  return ((r && (r.duration ?? (r[0] && r[0].duration))) as number) || 0;
}

/** Build the compact activity snapshot sent to the LLM. */
export async function buildDigestData(granularity: DigestGranularity) {
  const start = rangeStart(granularity);
  const end = moment();
  const categoryStore = useCategoryStore();

  const [active, events] = await Promise.all([
    activeSeconds(start, end),
    // For long ranges the raw sequence gets huge; the category totals query
    // is the cheaper source. Focus/switch stats only for shorter ranges.
    GRANULARITY_DAYS[granularity] <= 30
      ? fetchCategorizedWindowEvents(start, end)
      : Promise.resolve([] as any[]),
  ]);

  const topCategories = _.take(
    _.orderBy(
      _.toPairs(
        _.mapValues(
          _.groupBy(
            events.filter(e => e.data && e.data['$category']),
            e => (e.data['$category'] as string[]).join(' > ')
          ),
          es => _.sumBy(es, 'duration')
        )
      ),
      ([, v]) => -v
    ),
    8
  );

  const topApps = _.take(
    _.orderBy(
      _.toPairs(
        _.mapValues(
          _.groupBy(
            events.filter(e => e.data && e.data.app),
            e => e.data.app
          ),
          es => _.sumBy(es, 'duration')
        )
      ),
      ([, v]) => -v
    ),
    8
  );

  let focusLine = '';
  let switchLine = '';
  if (events.length > 0) {
    const sessions = sessionsFromEvents(events, 15);
    if (sessions.length > 0) {
      const longest = Math.max(...sessions.map(s => s.duration));
      focusLine = `Focus sessions >=15min: ${sessions.length}, longest ${seconds_to_duration(
        longest
      )}.\n`;
    } else {
      focusLine = 'Focus sessions >=15min: none (highly fragmented day).\n';
    }
    const sw = switchesPerHour(events);
    switchLine = `Avg category switches per active day: ~${_.round(_.sum(sw.counts), 1)}.\n`;
  } else {
    // Long ranges: fall back to category totals for context.
    const totals = await categoryTotals(start, end);
    for (const [name, dur] of totals.slice(0, 8)) {
      topCategories.push([name, dur]);
    }
  }

  const catLines = topCategories
    .slice(0, 8)
    .map(([name, dur]) => `  ${name}: ${seconds_to_duration(dur as number)}`)
    .join('\n');
  const appLines = topApps
    .slice(0, 8)
    .map(([name, dur]) => `  ${name}: ${seconds_to_duration(dur as number)}`)
    .join('\n');

  return [
    `Period: past ${GRANULARITY_DAYS[granularity]} day(s) (${start.format(
      'YYYY-MM-DD'
    )} to ${end.format('YYYY-MM-DD')}).`,
    `Total active time: ${seconds_to_duration(active)}.`,
    '',
    'Top categories:',
    catLines || '  (none)',
    appLines ? `\nTop applications:\n${appLines}` : '',
    `\n${focusLine}${switchLine}`,
    categoryStore.classes ? '' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function categoryTotals(start: moment.Moment, end: moment.Moment) {
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
    bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata')),
    h => bucketsStore.bucketsWindow(h),
    h => bucketsStore.bucketsAFK(h)
  );
  if (hosts_with_buckets.length === 0) return [] as [string, number][];
  const q = queries.categoryQuery({
    hosts: hosts_with_buckets,
    filter_afk: true,
    categories: categoryStore.classes_for_query,
    filter_categories: null,
    host_params,
    always_active_pattern: '',
  } as any);
  const tp = `${start.utc().format('YYYY-MM-DD[T]HH:mm:ssZ')}/${end
    .utc()
    .format('YYYY-MM-DD[T]HH:mm:ssZ')}`;
  const data = await getClient().query([tp], q, { name: 'digestCategoryQuery' });
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

const DIGEST_PROMPT = `你是一个个人时间使用分析助手。根据下面的活动统计数据，用中文写一段 2-3 句话的简短总结：主要时间去向、一个值得注意的模式或趋势、以及一个具体可行动的小建议。不要罗列数据，直接给洞察。保持简洁，不超过 3 句话。\n\n`;

/** Generate (or return cached) digest text for a granularity. */
export async function getDigest(granularity: DigestGranularity, force = false): Promise<string> {
  if (!force) {
    const cached = getCachedDigest(granularity);
    if (cached) return cached.text;
  }
  const config = loadLLMConfig() as LLMConfig;
  if (!config.apiKey) throw new Error('No API key configured');
  const data = await buildDigestData(granularity);
  const text = (await callLLM(config, DIGEST_PROMPT + data)).trim();
  storeDigest(granularity, text);
  return text;
}

// ---------------------------------------------------------------------------
// Weekly auto-digest state (drives the homepage notification)

export interface WeeklyState {
  at: number; // last successful run
  text: string;
}

export function readWeeklyState(): WeeklyState | null {
  try {
    return JSON.parse(localStorage.getItem(WEEKLY_STATE_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeWeeklyState(state: WeeklyState) {
  localStorage.setItem(WEEKLY_STATE_KEY, JSON.stringify(state));
}

export function weeklyDue(): boolean {
  const s = readWeeklyState();
  return !s || Date.now() - s.at > 7 * 24 * 3600 * 1000;
}

/** Auto-generate the weekly digest if due and a persisted key exists. */
export async function autoWeeklyIfNeeded(): Promise<WeeklyState | null> {
  const config = loadLLMConfig() as LLMConfig;
  if (!config.apiKey) return null;
  if (!weeklyDue()) return readWeeklyState();
  try {
    const text = await getDigest('week', true);
    const state = { at: Date.now(), text };
    writeWeeklyState(state);
    return state;
  } catch (e) {
    console.warn('aw-digest weekly auto-run failed:', e);
    return readWeeklyState();
  }
}

export function saveDigestConfig(config: Partial<LLMConfig>, rememberKey: boolean) {
  saveLLMConfig(config, rememberKey);
}
