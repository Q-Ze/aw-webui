// LLM activity digest: build a compact, title-aware activity snapshot for a
// granularity (day/week/month/year) anchored at the browsed date, ask an LLM
// for a three-section retrospective, and cache per granularity+range in
// localStorage.

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
import { clipEventToHours } from '~/util/hourclip';

export type DigestGranularity = 'day' | 'week' | 'month' | 'year';

export const GRANULARITY_DAYS: Record<DigestGranularity, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const CACHE_KEY = 'aw-digest-cache';
const WEEKLY_STATE_KEY = 'aw-digest-weekly';
const TITLES_KEY = 'aw-digest-include-titles';
const MAX_CACHE_ENTRIES = 64;

export interface DigestCacheEntry {
  dateKey: string; // start date of the covered range
  withTitles: boolean;
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

export function getIncludeTitles(): boolean {
  try {
    return localStorage.getItem(TITLES_KEY) === '1';
  } catch {
    return false;
  }
}

export function setIncludeTitles(v: boolean): void {
  try {
    localStorage.setItem(TITLES_KEY, v ? '1' : '0');
  } catch {
    /* storage disabled */
  }
}

/** Range start for a digest anchored at `anchor` (defaults to today). */
export function rangeStart(granularity: DigestGranularity, anchor?: moment.Moment): moment.Moment {
  const base = (anchor || moment()).clone().startOf('day');
  return base.subtract(GRANULARITY_DAYS[granularity] - 1, 'days');
}

/** Cache is keyed per granularity+range start so each day keeps its digest. */
function cacheKey(granularity: DigestGranularity, anchor?: moment.Moment): string {
  return `${granularity}:${rangeStart(granularity, anchor).format('YYYY-MM-DD')}`;
}

export function getCachedDigest(
  granularity: DigestGranularity,
  anchor?: moment.Moment
): DigestCacheEntry | null {
  const entry = readCache()[cacheKey(granularity, anchor)];
  if (!entry) return null;
  if (entry.withTitles !== getIncludeTitles()) return null;
  return entry;
}

function storeDigest(granularity: DigestGranularity, anchor: moment.Moment, text: string) {
  const cache = readCache();
  // Drop legacy entries keyed by bare granularity (pre per-day fix).
  for (const k of Object.keys(cache)) {
    if (!k.includes(':')) delete cache[k];
  }
  cache[cacheKey(granularity, anchor)] = {
    dateKey: rangeStart(granularity, anchor).format('YYYY-MM-DD'),
    withTitles: getIncludeTitles(),
    text,
    at: Date.now(),
  };
  // Keep the newest entries only; localStorage is small and digests add up.
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    const byAge = keys.sort((a, b) => cache[b].at - cache[a].at);
    for (const k of byAge.slice(MAX_CACHE_ENTRIES)) delete cache[k];
  }
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

function fmtHourMinutes(hours: number[]): string {
  // Compact "HH:MM" run-length summary of the active part of the day.
  const active = hours.map((m, h) => ({ h, m })).filter(x => x.m >= 1);
  if (active.length === 0) return 'none';
  const runs: string[] = [];
  let runStart = active[0].h;
  let prev = active[0].h;
  for (const x of active.slice(1)) {
    if (x.h !== prev + 1) {
      runs.push(runStart === prev ? `${runStart}:00` : `${runStart}:00–${prev + 1}:00`);
      runStart = x.h;
    }
    prev = x.h;
  }
  runs.push(runStart === prev ? `${runStart}:00` : `${runStart}:00–${prev + 1}:00`);
  const peak = _.maxBy(active, x => x.m);
  return `${runs.join(', ')} (peak ${String(peak.h).padStart(2, '0')}:00, ~${Math.round(
    peak.m
  )}min)`;
}

function topGroups(events: any[], keyFn: (e: any) => string | null, n: number) {
  const groups: Record<string, { dur: number }> = {};
  for (const e of events) {
    const k = keyFn(e);
    if (!k) continue;
    groups[k] = groups[k] || { dur: 0 };
    groups[k].dur += e.duration || 0;
  }
  return _.take(
    _.orderBy(_.toPairs(groups), ([, v]) => -v.dur),
    n
  ) as [string, { dur: number }][];
}

/** Build the compact activity snapshot sent to the LLM. */
export async function buildDigestData(
  granularity: DigestGranularity,
  anchor: moment.Moment,
  includeTitles: boolean
) {
  const n = GRANULARITY_DAYS[granularity];
  const start = rangeStart(granularity, anchor);
  const isToday = anchor.isSame(moment(), 'day');
  const end = isToday ? moment() : anchor.clone().endOf('day');
  const prevStart = start.clone().subtract(n, 'days');

  // One query covers both the current and the previous range; split locally.
  const eventsAll = n <= 30 ? await fetchCategorizedWindowEvents(prevStart, end) : [];
  const events = eventsAll.filter(e => moment(e.timestamp).isSameOrAfter(start));
  const prevEvents = eventsAll.filter(e => moment(e.timestamp).isBefore(start));

  const activeMin = Math.round(_.sumBy(events, 'duration') / 60);
  const prevActiveMin = Math.round(_.sumBy(prevEvents, 'duration') / 60);

  const catLines = topGroups(
    events,
    e => {
      const cat = e.data && e.data['$category'];
      return cat ? cat.join(' > ') : null;
    },
    6
  ).map(([name, v]) => `  ${name}: ${seconds_to_duration(v.dur)}`);
  const appGroups = topGroups(events, e => (e.data && e.data.app) || null, 8);
  const appLines = appGroups.map(([name, v]) => `  ${name}: ${seconds_to_duration(v.dur)}`);

  const titleLines: string[] = [];
  if (includeTitles && n <= 30) {
    // Sanitize + cap titles: long/dirty window titles balloon the request and
    // are exactly what makes flaky LLM relays drop the call.
    // eslint-disable-next-line no-control-regex
    const ctrlRe = /[\u0000-\u001f]/;
    const clean = (t: string) => t.split(ctrlRe).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    const appByTitle: Record<string, Record<string, number>> = {};
    for (const e of events) {
      const t = e.data && e.data.title;
      const a = (e.data && e.data.app) || 'unknown';
      if (!t) continue;
      const key = clean(String(t));
      if (!key) continue;
      appByTitle[key] = appByTitle[key] || {};
      appByTitle[key][a] = (appByTitle[key][a] || 0) + (e.duration || 0);
    }
    const titles = _.take(
      _.orderBy(_.toPairs(_.mapValues(appByTitle, m => _.sum(_.values(m)))), ([, v]) => -v),
      12
    ) as [string, number][];
    for (const [t, dur] of titles) {
      const app = _.maxBy(_.toPairs(appByTitle[t]), ([, v]) => v)?.[0] || 'unknown';
      titleLines.push(`  [${app}] ${t} — ${seconds_to_duration(dur)}`);
    }
  }

  // Hourly active minutes from the same events (local hours).
  const hours = new Array(24).fill(0);
  for (const e of events) {
    clipEventToHours(e.timestamp, e.duration || 0, slice => {
      hours[slice.hour] += slice.seconds / 60;
    });
  }

  // Time-attributed structures so the LLM can say WHEN things happened,
  // not just what dominated the range in total.
  // eslint-disable-next-line no-control-regex
  const ctrlRe = /[\u0000-\u001f]/;
  const cleanT = (t: unknown) =>
    String(t ?? '')
      .split(ctrlRe)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  const topPairs = (rec: Record<string, number>, k: number): [string, number][] =>
    _.take(
      _.orderBy(_.toPairs(rec), ([, v]) => -v),
      k
    ) as [string, number][];

  interface Agg {
    min: number;
    cat: Record<string, number>;
    app: Record<string, number>;
    title: Record<string, number>;
  }
  const newAgg = (): Agg => ({ min: 0, cat: {}, app: {}, title: {} });
  const addEvent = (o: Agg, e: any) => {
    const d = e.duration || 0;
    o.min += d / 60;
    const cat = e.data && e.data['$category'];
    if (cat) o.cat[cat.join(' > ')] = (o.cat[cat.join(' > ')] || 0) + d;
    if (e.data && e.data.app) o.app[e.data.app] = (o.app[e.data.app] || 0) + d;
    if (e.data && e.data.title) {
      const t = cleanT(e.data.title);
      if (t) o.title[t] = (o.title[t] || 0) + d;
    }
  };

  const timelineLines: string[] = []; // day: hour -> what
  const perDayLines: string[] = []; // week: day -> what
  const perWeekLines: string[] = []; // month: week -> what

  if (n === 1 && events.length > 0) {
    const byHour: Record<number, Agg> = {};
    for (const e of events) {
      const h = moment(e.timestamp).hour();
      byHour[h] = byHour[h] || newAgg();
      addEvent(byHour[h], e);
    }
    for (const h of Object.keys(byHour)
      .map(Number)
      .sort((a, b) => a - b)) {
      const o = byHour[h];
      if (o.min < 1) continue;
      const cat = topPairs(o.cat, 1)[0]?.[0] || '';
      const titles = includeTitles
        ? topPairs(o.title, 2)
            .map(([t]) => t)
            .join('; ')
        : '';
      timelineLines.push(
        `  ${String(h).padStart(2, '0')}:00 · ${Math.round(o.min)}min · ${cat}${
          titles ? ` · ${titles}` : ''
        }`
      );
    }
  } else if (n <= 7 && events.length > 0) {
    const byDate: Record<string, Agg> = {};
    for (const e of events) {
      const k = moment(e.timestamp).format('YYYY-MM-DD');
      byDate[k] = byDate[k] || newAgg();
      addEvent(byDate[k], e);
    }
    for (const k of Object.keys(byDate).sort()) {
      const o = byDate[k];
      if (o.min < 1) continue;
      const wd = moment(k).format('dd'); // locale-aware short weekday
      const cats = topPairs(o.cat, 2)
        .map(([c, d]) => `${c} ${seconds_to_duration(d)}`)
        .join(', ');
      const apps = topPairs(o.app, 2)
        .map(([a]) => a)
        .join(', ');
      const dayTopTitle = includeTitles
        ? topPairs(o.title, 1)
            .map(([t]) => t)
            .join('')
        : '';
      perDayLines.push(
        `  ${wd} ${k.slice(5)} · ${seconds_to_duration(o.min * 60)} · ${cats} · ${apps}${
          dayTopTitle ? ` · top: ${dayTopTitle}` : ''
        }`
      );
    }
  } else if (n <= 30 && events.length > 0) {
    const byWeek: Record<string, Agg> = {};
    for (const e of events) {
      const k = moment(e.timestamp).startOf('isoWeek').format('YYYY-MM-DD');
      byWeek[k] = byWeek[k] || newAgg();
      addEvent(byWeek[k], e);
    }
    for (const k of Object.keys(byWeek).sort()) {
      const o = byWeek[k];
      if (o.min < 1) continue;
      const wEnd = moment(k).add(6, 'days').format('MM-DD');
      const cat = topPairs(o.cat, 1)[0];
      const app = topPairs(o.app, 1)[0]?.[0] || '';
      perWeekLines.push(
        `  ${moment(k).format('MM-DD')}–${wEnd} · ${seconds_to_duration(o.min * 60)} · ${
          cat ? `${cat[0]} ${seconds_to_duration(cat[1])}` : ''
        } · ${app}`
      );
    }
  }

  const sessions = sessionsFromEvents(events, 15);
  const prevSessions = sessionsFromEvents(prevEvents, 15);
  const sw = switchesPerHour(events);

  const lines: string[] = [
    `Period: ${start.format('YYYY-MM-DD')} to ${end.format('YYYY-MM-DD')} (${n} day(s)).`,
    `Total active time: ${seconds_to_duration(activeMin * 60)}.`,
    `Active hours (local): ${fmtHourMinutes(hours)}.`,
    '',
    'Top categories:',
    ...(catLines.length ? catLines : ['  (none)']),
    '',
    'Top applications:',
    ...(appLines.length ? appLines : ['  (none)']),
  ];

  if (titleLines.length) {
    lines.push('', 'Top window titles (app — title — duration):', ...titleLines);
  }

  if (timelineLines.length) {
    lines.push(
      '',
      'Timeline (hour · active minutes · top category · top titles):',
      ...timelineLines.slice(0, 16)
    );
  }
  if (perDayLines.length) {
    lines.push(
      '',
      'Per-day breakdown (weekday · total · top categories · top apps):',
      ...perDayLines
    );
  }
  if (perWeekLines.length) {
    lines.push(
      '',
      'Per-week breakdown (week range · total · top category · top app):',
      ...perWeekLines
    );
  }

  if (events.length > 0) {
    const longest = _.maxBy(sessions, s => s.duration);
    const when = longest
      ? n === 1
        ? moment(longest.start).format('HH:mm')
        : moment(longest.start).format('dd HH:mm')
      : '';
    lines.push(
      '',
      `Focus blocks >=15min: ${sessions.length}, longest ${seconds_to_duration(
        longest ? longest.duration : 0
      )}${when ? ` (from ${when})` : ''}.`,
      `Category switches per day: ~${_.round(_.sum(sw.counts), 0)}.`
    );
    if (prevActiveMin > 0) {
      const prevLongest = _.maxBy(prevSessions, s => s.duration);
      lines.push(
        `Previous period (${prevStart.format('MM-DD')}–${start
          .clone()
          .subtract(1, 'day')
          .format('MM-DD')}): active ${seconds_to_duration(prevActiveMin * 60)}, ${
          prevSessions.length
        } focus blocks, longest ${seconds_to_duration(prevLongest ? prevLongest.duration : 0)}.`
      );
    }
  } else {
    // Long ranges: fall back to category totals for context.
    const totals = await categoryTotals(start, end);
    const prevTotals = await categoryTotals(prevStart, start.clone().subtract(1, 'second'));
    lines.push('', 'Top categories (totals):');
    for (const [name, dur] of totals.slice(0, 8)) {
      lines.push(`  ${name}: ${seconds_to_duration(dur as number)}`);
    }
    if (prevTotals.length) {
      const prevTotal = _.sumBy(prevTotals, ([, v]) => v as number);
      const curTotal = _.sumBy(totals, ([, v]) => v as number);
      if (prevTotal > 0) {
        lines.push(
          `Previous period total: ${seconds_to_duration(prevTotal)} (current ${seconds_to_duration(
            curTotal
          )}).`
        );
      }
    }
  }

  return { text: lines.join('\n'), hasTitles: titleLines.length > 0, hasPrev: prevActiveMin > 0 };
}

async function categoryTotals(start: moment.Moment, end: moment.Moment) {
  const bucketsStore = useBucketsStore();
  const categoryStore = useCategoryStore();
  const settingsStore = useSettingsStore();
  // Ensure buckets + the category rule set are loaded before building the
  // query, otherwise hosts/classes are empty and everything returns [].
  await bucketsStore.ensureLoaded();
  await settingsStore.ensureLoaded();
  categoryStore.load();
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

export interface DigestDebugInfo {
  request: string;
  endpoint: string;
  model: string;
  responseRaw: string;
  ok: boolean;
  at: number;
}

let lastDebug: DigestDebugInfo | null = null;

/** Last LLM exchange of this page session (request text + raw response). */
export function getLastDigestDebug(): DigestDebugInfo | null {
  return lastDebug;
}

function digestPrompt(
  granularity: DigestGranularity,
  includeTitles: boolean,
  hasPrev: boolean
): string {
  const titlePart = includeTitles
    ? '窗口标题（Top window titles 一节，格式 [应用] 标题 — 时长）'
    : '';
  const sources = ['Top categories（分类时长）', 'Top applications（应用时长）', titlePart]
    .filter(Boolean)
    .join('、');
  const prevPart = hasPrev ? '，以及与 Previous period 的对比' : '';

  // Per-granularity: which temporal structure carries the "when" dimension.
  const isDay = granularity === 'day';
  const isWeek = granularity === 'week';
  let whatGuide: string;
  let whenGuide: string;
  let whenSource: string;
  if (isDay) {
    whenSource = 'Timeline（逐小时：几点 · 活跃分钟 · 主要分类 · 主要标题）';
    whatGuide =
      '按时间顺序叙述，每个活动带上时间锚点（如"上午主要在…""14 点前后切换到…"）。 Timeline 是判断"几点干了什么"的唯一依据。';
    whenGuide =
      '结合 Timeline 与 Active hours 说明一天的时间安排（如上午/午后/深夜各在做什么类型的事）、最长专注块出现在几点。';
  } else if (isWeek) {
    whenSource = 'Per-day breakdown（逐日：星期 · 总时长 · 当日主要分类与应用）';
    whatGuide =
      '把同类条目合并成"一件事"叙述；如 Per-day 显示某活动集中在特定几天，要点出"哪几天主要在做什么"。';
    whenGuide =
      '结合 Per-day 说明一周的节奏与分布（如工作日 vs 周末、哪几天是高峰、最长专注块出现在星期几）与项目/重点的切换点。';
  } else {
    whenSource = 'Per-week breakdown（逐周：周区间 · 总时长 · 当周主要分类）';
    whatGuide = '把同类条目合并成"一件事"叙述，点出整段期间的主线和次要线。';
    whenGuide =
      '结合 Per-week 说明这段期间的走向与变化（如某几周集中做什么、后段转向什么、节奏是否稳定）。';
  }

  return [
    '你是一份个人电脑活动日志的回顾助手。下面是某段时间的活动统计数据。',
    `可用素材：${sources}、活跃时段分布（Active hours）、${whenSource}${prevPart}、专注块（Focus blocks）与切换频率。`,
    '',
    '请用中文输出以下三个小节（保留【】标题）：',
    '',
    '【做了什么】',
    `1-3 句。把同类条目合并成"一件事"来叙述（例如从多个 VS Code 标题归纳出"在开发某项目的某模块"，从多个网页标题归纳出"在查阅某主题的资料"）。引用具体对象（文件名/页面主题/项目名），但不要逐条罗列原始数据。${whatGuide}`,
    '',
    '【时间结构】',
    `${whenGuide}${prevPart}`,
    '',
    '【一个观察】',
    '1 句。只陈述数据能直接支撑的事实（数字对比、集中度、时段特征）。禁止编造因果关系，禁止给出泛泛的建议（如"建议规划时间"）。',
    '',
    '硬性规则：所有内容必须来自给定数据，不得虚构；不要寒暄、不要免责声明、不要重复原始列表。',
    '',
  ].join('\n');
}

/** Generate (or return cached) digest text for a granularity. */
export async function getDigest(
  granularity: DigestGranularity,
  force = false,
  anchor?: moment.Moment
): Promise<string> {
  const anchorDate = anchor ? anchor.clone() : moment();
  if (!force) {
    const cached = getCachedDigest(granularity, anchorDate);
    if (cached) return cached.text;
  }
  const config = loadLLMConfig() as LLMConfig;
  if (!config.apiKey) throw new Error('No API key configured');
  const {
    text: data,
    hasTitles,
    hasPrev,
  } = await buildDigestData(granularity, anchorDate, getIncludeTitles());
  const fullRequest = digestPrompt(granularity, hasTitles, hasPrev) + '\n' + data;
  console.info('[aw-digest] request:\n' + fullRequest);
  const text = (
    await callLLM(config, fullRequest, exchange => {
      lastDebug = {
        request: fullRequest,
        endpoint: exchange.endpoint,
        model: exchange.model,
        responseRaw: exchange.responseRaw,
        ok: exchange.ok,
        at: exchange.at,
      };
      console.info('[aw-digest] raw response:\n' + exchange.responseRaw.slice(0, 4000));
    })
  ).trim();
  storeDigest(granularity, anchorDate, text);
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
