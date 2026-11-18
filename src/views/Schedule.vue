<template lang="pug">
div.schedule-page
  b-alert(v-if='loadError', variant='warning', show, dismissible, @dismissed='loadError = null') {{ loadError }}
  div.d-flex.align-items-center.mb-3.flex-wrap
    h3.mb-0.mr-3 日程
    span.small.text-muted(v-if='syncing') 同步中…

  div.row
    // ── 左侧：月视图 / 周视图 ──
    div.col-lg-5.mb-3
      div.card.schedule-calendar
        div.d-flex.align-items-center.mb-2
          b-button-group(size='sm')
            b-button(variant='outline-dark', @click='shiftPeriod(-1)') ‹
            b-button(variant='outline-dark', @click='goToday()') 今天
            b-button(variant='outline-dark', @click='shiftPeriod(1)') ›
          h6.mb-0.ml-2.mr-auto {{ periodLabel }}
          b-button-group(size='sm')
            b-button(variant='outline-dark', :pressed='viewMode === "month"', @click='viewMode = "month"') 月
            b-button(variant='outline-dark', :pressed='viewMode === "week"', @click='viewMode = "week"') 周

        // 月视图
        div(v-if='viewMode === "month"')
          div.schedule-grid
            div.schedule-weekday.text-center.small.text-muted(v-for='w in weekdays', :key='w') {{ w }}
            div.schedule-cell(
              v-for='cell in cells',
              :key='cell.key',
              :class='{ "schedule-cell--out": cell.out, "schedule-cell--today": cell.today, "schedule-cell--selected": selected && cell.date.isSame(selected, "day") }',
              @click='selectDay(cell.date)'
            )
              div.schedule-cell-day {{ cell.date.date() }}
              div.schedule-cell-entries
                span.schedule-dot(
                  v-for='(e, i) in cell.entries.slice(0, 4)',
                  :key='i',
                  :style='{ backgroundColor: entryColor(e.data.title) }',
                  :title='entryLabel(e)'
                )
                span.small.text-muted(v-if='cell.entries.length > 4') +{{ cell.entries.length - 4 }}

        // 周视图：每天一行，日程条目按时间排成彩色碎片
        div(v-else)
          div.schedule-week-row(
            v-for='d in weekDays',
              :key='d.key',
            :class='{ "schedule-week-row--today": d.today, "schedule-week-row--selected": selected && d.date.isSame(selected, "day") }',
            @click='selectDay(d.date)'
          )
            div.schedule-week-dayname
              span {{ d.date.format('ddd') }}
              b {{ d.date.date() }}
            div.schedule-week-chips
              span.schedule-chip(
                v-for='(e, i) in d.entries',
                :key='i',
                :style='{ backgroundColor: entryColor(e.data.title) }',
                :title='entryLabel(e)'
              ) {{ shortTitle(e) }}
              span.text-muted.small(v-if='d.entries.length === 0') —

    // ── 右侧：日视图（时间轴） ──
    div.col-lg-7
      div.card
        div.card-body.p-2
          div.d-flex.align-items-center.mb-2.pl-1.pr-1
            h6.mb-0.mr-auto {{ selectedLabel }}
            b-button(size='sm', variant='primary', @click='openAdd()')
              icon.mr-1(name='plus', scale='0.8')
              | 添加日程

          // 全天日程
          div.px-2.mb-1(v-if='allDayEntries.length')
            span.schedule-allday.mr-1(v-for='e in allDayEntries', :key='entryUid(e)',
              :style='{ backgroundColor: entryColor(e.data.title) }',
              @click='selectedEntry = e')
              | {{ e.data.title }}（全天）

          // 时间轴
          div.schedule-timeline(ref='timeline')
            div.schedule-hour-row(v-for='h in 24', :key='h',
              :class='{ "schedule-hour--now": isCurrentHour(h - 1) }')
              div.schedule-hour-label {{ String(h - 1).padStart(2, '0') }}:00
              div.schedule-hour-track
                div.schedule-hour-fill(
                  v-if='hourly[h - 1] > 0',
                  :style='hourStyle(h - 1)'
                )
            div.schedule-block(
              v-for='item in timedLayout',
              :key='entryUid(item.entry)',
              :style='blockStyle(item)',
              :class='{ "schedule-block--selected": selectedEntry === item.entry }',
              @click='selectedEntry = item.entry'
            )
              div.schedule-block-title
                | {{ continuesIntoDay(item.entry) ? '↩ ' : '' }}{{ item.entry.data.title }}
              div.schedule-block-time(v-if='blockHours(item.entry) >= 0.75') {{ entryTimeLabel(item.entry) }}

          // 选中日程详情
          div.mt-2.px-2(v-if='selectedEntry')
            div.schedule-detail.p-2.rounded
              div.d-flex.justify-content-between.align-items-start
                div
                  span.schedule-entry-bar.mr-2(:style='{ backgroundColor: entryColor(selectedEntry.data.title) }')
                  b {{ selectedEntry.data.title }}
                  span.text-muted.small.ml-2 {{ entryTimeLabel(selectedEntry) }}
                div
                  b-button.p-1(variant='link', size='sm', @click='openEdit(selectedEntry)')
                    icon(name='pen', scale='0.8')
                  b-button.p-1(variant='link', size='sm', @click='removeEntry(selectedEntry)')
                    icon(name='trash', scale='0.8')
              div.small.text-muted(v-if='selectedEntry.data.notes') {{ selectedEntry.data.notes }}
              div.small.text-warning(v-if='remoteEntry(selectedEntry)')
                icon.mr-1(name='exclamation-triangle', scale='0.75')
                | 来自其他设备，修改不会同步回原设备
              div.mt-1(v-if='actualFor(selectedEntry)')
                div.schedule-actual-bar
                  div.schedule-actual-fill(:style='{ width: actualPct(selectedEntry) + "%" }')
                span.small.text-muted
                  | 实际活跃 {{ fmtDur(actualFor(selectedEntry).activeSeconds) }} / 计划 {{ fmtDur(entryDuration(selectedEntry)) }}
                  | （{{ actualPct(selectedEntry) }}%）
                div.small.text-muted(v-if='actualFor(selectedEntry).topApps.length')
                  | 时段内主要在用：{{ actualFor(selectedEntry).topApps.map(a => a.app + ' ' + fmtDur(a.seconds)).join('、') }}

  // ── 添加 / 编辑弹窗 ──
  b-modal(ref='editModal', :title='editing ? "编辑日程" : "添加日程"', ok-title='保存', cancel-title='取消',
    :ok-disabled='!trimmedTitle || saving', @ok.prevent='submit', @hidden='cancelEdit', size='sm')
    b-form(@submit.prevent='submit')
      b-form-group(label='日期' label-cols='3' label-size='sm')
        span.align-middle {{ formDateLabel }}
      b-alert.py-1.px-2.mb-2(v-if='saveError', variant='danger', show, small) {{ saveError }}
      b-form-group(label='标题' label-cols='3' label-size='sm')
        b-form-input(v-model='form.title' size='sm' required placeholder='例：组会 / 写论文 rebuttal')
      b-form-group(label='全天' label-cols='3' label-size='sm')
        b-form-checkbox(v-model='form.allDay' size='sm')
      b-form-group(label='开始' label-cols='3' label-size='sm' v-if='!form.allDay')
        b-form-input(v-model='form.start' type='time' size='sm' required)
      b-form-group(label='结束' label-cols='3' label-size='sm' v-if='!form.allDay')
        b-form-input(v-model='form.end' type='time' size='sm' required)
        span.small.text-muted(v-if='endNextDay') （次日）
      b-form-group(label='备注' label-cols='3' label-size='sm')
        b-form-input(v-model='form.notes' size='sm' placeholder='可选')
</template>

<style lang="scss" scoped>
.schedule-calendar {
  padding: 0.75rem;
}

.schedule-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.schedule-weekday {
  padding: 2px 0;
}

.schedule-cell {
  min-height: 56px;
  border: 1px solid var(--aw-card-border, #e5e9f0);
  border-radius: 6px;
  padding: 2px 4px;
  cursor: pointer;
  transition: background-color 0.1s ease;

  &:hover {
    background-color: var(--aw-vis-grid, #f0f2f7);
  }
}

.schedule-cell--out {
  opacity: 0.38;
}

.schedule-cell--today {
  border-color: #4b7bec;
  box-shadow: inset 0 0 0 1px #4b7bec;
}

.schedule-cell--selected {
  background-color: #e8f0fe;
}

.schedule-cell-day {
  font-size: 0.8rem;
  color: var(--aw-vis-text, #3c4257);
  font-weight: 600;
}

.schedule-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin: 3px 3px 0 0;
  border: 1px solid rgba(0, 0, 0, 0.15);
}

// 周视图
.schedule-week-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;

  &:hover {
    background-color: var(--aw-vis-grid, #f0f2f7);
  }
}

.schedule-week-row--today .schedule-week-dayname b {
  color: #4b7bec;
}

.schedule-week-row--selected {
  background-color: #e8f0fe;
}

.schedule-week-dayname {
  width: 34px;
  flex-shrink: 0;
  font-size: 0.72rem;
  color: var(--aw-vis-subtext, #8b91a5);
  line-height: 1.25;

  b {
    display: block;
    font-size: 0.95rem;
    color: var(--aw-vis-text, #3c4257);
  }
}

.schedule-week-chips {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
  min-height: 26px;
}

.schedule-chip {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 日视图时间轴
.schedule-timeline {
  position: relative;
  max-height: 68vh;
  overflow-y: auto;
  border-top: 1px solid var(--aw-card-border, #e5e9f0);
}

.schedule-hour-row {
  display: flex;
  height: 44px;
  border-bottom: 1px dashed var(--aw-card-border, #e5e9f0);
}

.schedule-hour--now .schedule-hour-track {
  border-top: 2px solid #ff7675;
}

.schedule-hour-label {
  width: 44px;
  flex-shrink: 0;
  font-size: 0.68rem;
  color: var(--aw-vis-subtext, #8b91a5);
  text-align: right;
  padding-right: 6px;
  padding-top: 1px;
}

.schedule-hour-track {
  position: relative;
  flex: 1;
}

// 实际活跃的背景着色（时段内实际在电脑前的强度）
.schedule-hour-fill {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background-color: rgba(46, 204, 113, 0.14);
}

// 日程块浮在时间轴上
.schedule-block {
  position: absolute;
  left: 52px;
  right: 6px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 2px 6px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  z-index: 2;

  &:hover {
    filter: brightness(0.96);
  }
}

.schedule-block--selected {
  box-shadow: 0 0 0 2px #4b7bec;
}

.schedule-block-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: #2c3245;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.schedule-block-time {
  font-size: 0.68rem;
  color: #4a5065;
}

.schedule-allday {
  display: inline-block;
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  cursor: pointer;
}

.schedule-detail {
  background-color: var(--aw-vis-grid, #f5f6fa);
}

.schedule-entry-bar {
  display: inline-block;
  width: 4px;
  height: 14px;
  border-radius: 2px;
  vertical-align: middle;
}

.schedule-actual-bar {
  height: 5px;
  border-radius: 3px;
  background-color: #e2e6ef;
  overflow: hidden;
  margin: 4px 0 2px 0;
}

.schedule-actual-fill {
  height: 100%;
  background-color: #2ecc71;
  transition: width 0.3s ease;
}
</style>

<script lang="ts">
import 'vue-awesome/icons/pen';
import 'vue-awesome/icons/trash';
import 'vue-awesome/icons/plus';
import 'vue-awesome/icons/exclamation-triangle';
import moment from 'moment';

import {
  fetchSchedule,
  saveEntry,
  deleteEntry,
  fetchActualForDay,
  entryColor,
  entryUid,
  newEntryUid,
  fmtTime,
  ScheduleEntry,
  EntryActual,
} from '~/util/schedule';

const HOUR_PX = 44;

function hhmm(m: moment.Moment): number {
  return m.hours() * 60 + m.minutes();
}

export default {
  name: 'Schedule',
  data() {
    return {
      viewMode: 'month' as 'month' | 'week',
      month: moment().startOf('month'),
      selected: moment().startOf('day'),
      monthEntries: [] as ScheduleEntry[],
      actualByEntry: new Map<number, EntryActual>(),
      hourly: new Array(24).fill(0),
      selectedEntry: null as ScheduleEntry | null,
      syncing: false,
      saving: false,
      loadError: null as string | null,
      saveError: null as string | null,
      // Monotonic request ids: a slow answer for an older month/day must
      // not clobber the currently displayed one.
      monthReqSeq: 0,
      actualReqSeq: 0,
      editing: null as ScheduleEntry | null,
      editingDate: null as moment.Moment | null,
      localBucketId: '',
      form: { title: '', allDay: false, start: '09:00', end: '10:00', notes: '' },
      weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    };
  },
  computed: {
    periodLabel(): string {
      if (this.viewMode === 'month') return this.month.format('YYYY 年 M 月');
      const ws = this.weekStart;
      return `${ws.format('M月D日')} – ${ws.clone().add(6, 'days').format('M月D日')}`;
    },
    atCurrentPeriod(): boolean {
      return this.viewMode === 'month'
        ? this.month.isSame(moment(), 'month')
        : this.weekStart.isSame(moment().startOf('isoWeek'));
    },
    selectedLabel(): string {
      return this.selected.format('M 月 D 日 dddd');
    },
    weekStart(): moment.Moment {
      return this.selected.clone().startOf('isoWeek');
    },
    weekDays(): any[] {
      const today = moment();
      return [...Array(7).keys()].map(i => {
        const d = this.weekStart.clone().add(i, 'days');
        return {
          date: d,
          key: d.format('YYYY-MM-DD'),
          today: d.isSame(today, 'day'),
          entries: this.entriesOn(d),
        };
      });
    },
    cells(): any[] {
      // Monday-first grid; leading/trailing cells from adjacent months so the
      // weekday columns always line up.
      const first = this.month.clone().startOf('month');
      const offset = (first.day() + 6) % 7; // Monday = 0
      const gridStart = first.clone().subtract(offset, 'days');
      const cells: any[] = [];
      const today = moment();
      for (let i = 0; i < 42; i++) {
        const d = gridStart.clone().add(i, 'days');
        cells.push({
          date: d,
          key: d.format('YYYY-MM-DD'),
          out: !d.isSame(this.month, 'month'),
          today: d.isSame(today, 'day'),
          entries: this.entriesOn(d),
        });
      }
      return cells;
    },
    dayEntries(): ScheduleEntry[] {
      return this.entriesOn(this.selected);
    },
    allDayEntries(): ScheduleEntry[] {
      return this.dayEntries.filter(e => e.data.allDay);
    },
    timedEntries(): ScheduleEntry[] {
      return this.dayEntries.filter(e => !e.data.allDay && (e.duration || 0) > 0);
    },
    /**
     * Overlapping entries get side-by-side columns so no entry is ever fully
     * covered by another (a same-slot pair used to render stacked with the
     * later one unclickable). Entries in one connected overlap-cluster share
     * the cluster's column count.
     */
    timedLayout(): { entry: ScheduleEntry; col: number; cols: number }[] {
      const dayStart = this.selected.clone().startOf('day');
      const dayEnd = dayStart.clone().add(1, 'day');
      const spans = this.timedEntries
        .map(e => ({
          e,
          s: Math.max(moment(e.timestamp).valueOf(), dayStart.valueOf()),
          t: Math.min(
            moment(e.timestamp).clone().add(e.duration, 'seconds').valueOf(),
            dayEnd.valueOf()
          ),
        }))
        .filter(x => x.t > x.s)
        .sort((a, b) => a.s - b.s || b.t - a.t);
      const out: { entry: ScheduleEntry; col: number; cols: number }[] = [];
      let colEnds: number[] = [];
      let clusterStart = 0; // index into `out` where the current cluster begins
      for (const item of spans) {
        const clusterMax = colEnds.length > 0 ? Math.max(...colEnds) : Infinity;
        if (out.length > clusterStart && item.s >= clusterMax) {
          // Close the cluster: every member gets its final column count.
          for (let i = clusterStart; i < out.length; i++) out[i].cols = colEnds.length;
          clusterStart = out.length;
          colEnds = [];
        }
        let col = colEnds.findIndex(end => end <= item.s);
        if (col === -1) {
          col = colEnds.length;
          colEnds.push(item.t);
        } else {
          colEnds[col] = item.t;
        }
        out.push({ entry: item.e, col, cols: colEnds.length });
      }
      for (let i = clusterStart; i < out.length; i++) out[i].cols = colEnds.length;
      return out;
    },

    // Whitespace-only titles must not pass validation: they would be saved
    // trimmed-to-empty and then filtered out by fetchSchedule, i.e. the entry
    // would silently vanish after saving.
    trimmedTitle(): string {
      return (this.form.title || '').trim();
    },
    formDateLabel(): string {
      // Editing shows the entry's ORIGINAL start date (kept on submit),
      // not the calendar's selected day.
      const d = this.editing ? this.editingDate : this.selected;
      return d ? d.format('YYYY-MM-DD dddd') : this.selected.format('YYYY-MM-DD dddd');
    },
    endNextDay(): boolean {
      if (this.form.allDay) return false;
      const [sh, sm] = (this.form.start || '0:0').split(':').map(Number);
      const [eh, em] = (this.form.end || '0:0').split(':').map(Number);
      return eh * 60 + em <= sh * 60 + sm;
    },
  },
  watch: {
    month() {
      this.refresh();
    },
    viewMode() {
      this.refresh();
    },
    selected() {
      this.selectedEntry = null;
      this.refreshActuals();
      this.scrollTimelineToNow();
    },
  },
  async mounted() {
    // For the remote-entry hint; importing ensureScheduleBucket would also
    // create the bucket on first visit, which is fine and expected.
    const { ensureScheduleBucket } = await import('~/util/schedule');
    this.localBucketId = await ensureScheduleBucket();
    this.refresh();
    this.scrollTimelineToNow();
  },
  methods: {
    entryColor,
    fmtTime,
    async refresh() {
      const seq = ++this.monthReqSeq;
      const month = this.month.clone();
      this.syncing = true;
      this.loadError = null;
      try {
        const start = month.clone().startOf('month').subtract(7, 'days');
        const end = month.clone().endOf('month').add(7, 'days');
        const entries = await fetchSchedule(start, end);
        if (seq !== this.monthReqSeq) return; // a newer navigation took over
        this.monthEntries = entries;
        await this.refreshActuals();
      } catch (err) {
        if (seq === this.monthReqSeq) {
          this.loadError = '日程读取失败：' + (err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (seq === this.monthReqSeq) this.syncing = false;
      }
    },
    async refreshActuals() {
      const seq = ++this.actualReqSeq;
      const day = this.selected.clone();
      this.actualByEntry = new Map();
      this.hourly = new Array(24).fill(0);
      if (this.dayEntries.length === 0) return;
      try {
        const { byEntry, hourly } = await fetchActualForDay(day, this.dayEntries);
        if (seq !== this.actualReqSeq) return; // a different day was selected meanwhile
        if (!day.isSame(this.selected, 'day')) return;
        this.actualByEntry = byEntry;
        this.hourly = hourly;
      } catch {
        // comparison is best-effort; the schedule itself still renders
      }
    },
    entriesOn(day: moment.Moment): ScheduleEntry[] {
      return this.monthEntries.filter(e =>
        moment(e.timestamp).isSame(day, 'day') || // timed entry starting today
        // all-day or long entries spanning across the day boundary
        (moment(e.timestamp).isBefore(day.clone().endOf('day')) &&
          moment(e.timestamp)
            .clone()
            .add(e.duration, 'seconds')
            .isAfter(day.clone().startOf('day')) &&
          !moment(e.timestamp).isSame(day, 'day'))
      );
    },
    entryLabel(e: ScheduleEntry): string {
      return `${this.entryTimeLabel(e)} ${e.data.title}`;
    },
    shortTitle(e: ScheduleEntry): string {
      const t = e.data.title;
      return t.length > 10 ? t.slice(0, 10) + '…' : t;
    },
    entryTimeLabel(e: ScheduleEntry): string {
      if (e.data.allDay) return '全天';
      const s = moment(e.timestamp);
      const endS = s.clone().add(e.duration, 'seconds');
      return `${fmtTime(s)}–${fmtTime(endS)}`;
    },
    entryDuration(e: ScheduleEntry): number {
      return e.duration || 0;
    },
    entryUid(e: ScheduleEntry): string {
      return entryUid(e);
    },
    actualFor(e: ScheduleEntry): EntryActual | undefined {
      return this.actualByEntry.get(entryUid(e));
    },
    actualPct(e: ScheduleEntry): number {
      const a = this.actualFor(e);
      if (!a || a.scheduledSeconds <= 0) return 0;
      return Math.min(100, Math.round((a.activeSeconds / a.scheduledSeconds) * 100));
    },
    fmtDur(sec: number): string {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h}小时${m ? m + '分' : ''}` : `${m}分钟`;
    },
    // ── 时间轴布局 ──
    // ── 时间轴几何（P2-5 裁剪 + P2-3 分列） ──
    blockStyle(item: { entry: ScheduleEntry; col: number; cols: number }): any {
      const e = item.entry;
      // Clip to the selected day first: an overnight entry (23:00-01:00)
      // must render as a short block at the END of its start day and a short
      // block at the START of the next day, not a 2h block at 23:00 twice.
      const dayStart = this.selected.clone().startOf('day');
      const dayEnd = dayStart.clone().add(1, 'day');
      const es = moment.max(moment(e.timestamp), dayStart);
      const ee = moment.min(moment(e.timestamp).clone().add(e.duration, 'seconds'), dayEnd);
      const startMin = es.hours() * 60 + es.minutes();
      const clippedMin = Math.max(0, ee.diff(es, 'minutes'));
      const top = (startMin / 60) * HOUR_PX;
      const height = Math.max(20, (clippedMin / 60) * HOUR_PX - 2);
      // Column split: blocks live between the hour labels (52px) and the
      // right margin (6px); overlapping entries divide that span.
      const left = `calc(52px + (100% - 58px) * ${item.col / item.cols})`;
      const width = `calc((100% - 58px) / ${item.cols} - 4px)`;
      return {
        top: `${top}px`,
        height: `${height}px`,
        left,
        width,
        backgroundColor: entryColor(e.data.title),
      };
    },

    blockHours(e: ScheduleEntry): number {
      // Clipped to the selected day, matching the rendered height.
      const dayStart = this.selected.clone().startOf('day');
      const dayEnd = dayStart.clone().add(1, 'day');
      const es = moment.max(moment(e.timestamp), dayStart);
      const ee = moment.min(moment(e.timestamp).clone().add(e.duration, 'seconds'), dayEnd);
      return Math.max(0, ee.diff(es, 'minutes')) / 60;
    },
    // Entries from another machine's (synced) bucket: edits stay local.
    // (methods, not computed: it takes the entry as an argument)
    remoteEntry(e: ScheduleEntry): boolean {
      const origin = (e as any)._bucket_id;
      return !!origin && origin !== this.localBucketId;
    },
    // Whether this entry continues past midnight into the selected day.
    continuesIntoDay(e: ScheduleEntry): boolean {
      return !moment(e.timestamp).isSame(this.selected, 'day');
    },
    hourStyle(h: number): any {
      const intensity = Math.min(1, this.hourly[h] / 3600);
      return { opacity: String(0.25 + 0.75 * intensity) };
    },
    isCurrentHour(h: number): boolean {
      return this.selected.isSame(moment(), 'day') && moment().hours() === h;
    },
    scrollTimelineToNow() {
      this.$nextTick(() => {
        const el = this.$refs.timeline as HTMLElement | undefined;
        if (!el) return;
        // A past/future day scrolls to 8:00; today scrolls to now − 2h.
        const base = this.selected.isSame(moment(), 'day') ? Math.max(0, moment().hours() - 2) : 8;
        el.scrollTop = base * HOUR_PX;
      });
    },
    // ── 导航 ──
    selectDay(d: moment.Moment) {
      this.selected = d.clone();
      // Keep the month grid in sync when navigating weeks into another month.
      if (!d.isSame(this.month, 'month')) this.month = d.clone().startOf('month');
    },
    shiftPeriod(n: number) {
      if (this.viewMode === 'month') {
        this.month = this.month.clone().add(n, 'months');
      } else {
        const next = this.selected.clone().add(n * 7, 'days');
        this.selected = next;
        if (!next.isSame(this.month, 'month')) this.month = next.clone().startOf('month');
      }
    },
    goToday() {
      this.month = moment().startOf('month');
      this.selected = moment().startOf('day');
    },
    // ── 弹窗表单 ──
    openAdd() {
      this.editing = null;
      this.editingDate = null;
      this.saveError = null;
      this.form = { title: '', allDay: false, start: '09:00', end: '10:00', notes: '' };
      (this.$refs.editModal as any).show();
    },
    openEdit(e: ScheduleEntry) {
      this.editing = e;
      this.saveError = null;
      const s = moment(e.timestamp);
      // Keep the ORIGINAL start date: for an overnight entry being edited
      // from the next day's view, submitting with the selected date would
      // silently move the entry a day later.
      (this as any).editingDate = s.clone().startOf('day');
      this.form = {
        title: e.data.title,
        allDay: !!e.data.allDay,
        start: s.format('HH:mm'),
        end: s.clone().add(e.duration, 'seconds').format('HH:mm'),
        notes: e.data.notes || '',
      };
      (this.$refs.editModal as any).show();
    },
    cancelEdit() {
      this.editing = null;
    },
    async submit() {
      // Re-entry guard: the modal button is disabled while saving, but the
      // form submit path (Enter key) can still fire and double-write.
      if (this.saving || !this.trimmedTitle) return;
      this.saving = true;
      this.saveError = null;
      try {
        // Editing keeps the entry's original start date; new entries start
        // on the selected day.
        const day = this.editing
          ? ((this as any).editingDate || this.selected.clone().startOf('day'))
          : this.selected.clone().startOf('day');
        const [sh, sm] = this.form.start.split(':').map(Number);
        const [eh, em] = this.form.end.split(':').map(Number);
        const start = day.clone().hours(sh || 0).minutes(sm || 0).seconds(0);
        // Overnight entries (end before start) carry into the next day.
        let end = day.clone().hours(eh || 0).minutes(em || 0).seconds(0);
        if (!this.form.allDay && hhmm(end) <= hhmm(start)) end = end.add(1, 'day');
        const duration = this.form.allDay
          ? 0
          : Math.max(60, end.diff(start, 'seconds'));
        const entry: ScheduleEntry = {
          timestamp: start.toISOString(true),
          duration,
          data: {
            title: this.trimmedTitle,
            notes: this.form.notes.trim() || undefined,
            allDay: this.form.allDay || undefined,
          },
        };
        if (this.editing) {
          // Keep identity intact: the id is only valid in the origin bucket,
          // and the uid is what merges synced copies of the same entry.
          entry.id = this.editing.id;
          (entry as any)._bucket_id = (this.editing as any)._bucket_id;
          entry.data.uid = this.editing.data.uid;
        } else {
          entry.data.uid = newEntryUid();
        }
        await saveEntry(entry);
        (this.$refs.editModal as any).hide();
        await this.refresh();
      } catch (err) {
        // Show the reason inside the modal instead of letting it vanish.
        this.saveError = '保存失败：' + (err instanceof Error ? err.message : String(err));
      } finally {
        this.saving = false;
      }
    },
    async removeEntry(e: ScheduleEntry) {
      try {
        await deleteEntry(e);
        this.selectedEntry = null;
        await this.refresh();
      } catch (err) {
        this.loadError = '删除失败：' + (err instanceof Error ? err.message : String(err));
      }
    },
  },
};
</script>
