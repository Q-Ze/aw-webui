<template lang="pug">
div.schedule-page
  header.schedule-header
    div.schedule-heading
      span.schedule-eyebrow 日程
      h3 {{ periodLabel }}
      span.schedule-year {{ focusYear }} 年
    div.schedule-actions
      div.schedule-navigation(role='group', aria-label='日历导航')
        button.schedule-icon-button(type='button', aria-label='上一周期', data-testid='schedule-prev', @click='shiftPeriod(-1)')
          icon(name='chevron-left', scale='0.75')
        button.schedule-today(type='button', @click='goToday()') 今天
        button.schedule-icon-button(type='button', aria-label='下一周期', data-testid='schedule-next', @click='shiftPeriod(1)')
          icon(name='chevron-right', scale='0.75')
      div.schedule-view-switch(role='group', aria-label='日历视图')
        button(type='button', :aria-pressed='viewMode === "week"', @click='setMode("week")') 周
        button(type='button', :aria-pressed='viewMode === "month"', @click='setMode("month")') 月
      b-button.schedule-add(variant='primary', @click='openAdd()', data-testid='schedule-add')
        icon.mr-1(name='plus', scale='0.8')
        | 添加日程

  b-alert(v-if='loadError', variant='danger', show)
    div.schedule-error
      span {{ loadError }}
      b-button(size='sm', variant='outline-danger', @click='refresh()') 重试

  b-alert(v-if='cleanupError', variant='warning', show) {{ cleanupError }}

  nav.schedule-days(v-if='isMobile && viewMode === "week"', aria-label='选择日期')
    button.schedule-day(
      v-for='d in weekDays', :key='d.key', type='button',
      :aria-pressed='d.date.isSame(fcDate, "day")',
      :aria-label='d.date.format("YYYY年M月D日")',
      :class='{ "schedule-day--today": d.today }', @click='gotoDay(d.date)'
    )
      span {{ d.label }}
      b {{ d.date.date() }}

  section.schedule-surface(v-if='viewMode === "week"', aria-label='日程时间网格', :style='{ "--schedule-zoom": zoom / 100 }')
    FullCalendar.aw-schedule-fc(ref='fc', :key='zoom', :options='calendarOptions')

  section.schedule-surface.schedule-month(v-else, aria-label='月历')
    div.schedule-month-grid
      span.schedule-month-weekday(v-for='w in weekdays', :key='w') 周{{ w }}
      button.schedule-month-day(
        v-for='cell in cells', :key='cell.key', type='button',
        :aria-label='cell.date.format("YYYY年M月D日") + "，" + cell.entries.length + "项日程"',
        :class='{ "schedule-month-day--out": cell.out, "schedule-month-day--today": cell.today }',
        @click='jumpToWeek(cell.date)'
      )
        span.schedule-month-number {{ cell.date.date() }}
        span.schedule-month-entry(v-for='e in cell.entries.slice(0, 3)', :key='entryUid(e)', :title='entryLabel(e)')
          i(:style='{ backgroundColor: entryColor(e.data.title) }')
          | {{ e.data.title }}
        span.schedule-month-more(v-if='cell.entries.length > 3') +{{ cell.entries.length - 3 }} 项

  footer.schedule-footer
    div.schedule-legend(v-if='viewMode === "week"')
      span
        i.schedule-legend-plan
        | 计划日程
      label.schedule-actual-toggle
        input(type='checkbox', v-model='showActual')
        i.schedule-legend-actual
        | 显示实际活跃
    div.schedule-zoom(v-if='viewMode === "week"', role='group', aria-label='时间轴缩放')
      span 时间轴
      button(type='button', aria-label='缩小时间轴', :disabled='zoom <= 75', @click='setZoom(zoom - 25)') −
      button.schedule-zoom-value(type='button', aria-label='恢复默认缩放', @click='setZoom(100)') {{ zoom }}%
      button(type='button', aria-label='放大时间轴', :disabled='zoom >= 200', @click='setZoom(zoom + 25)') +
      button.schedule-now(type='button', @click='goToday()') 现在
    span.schedule-status(role='status', aria-live='polite')
      template(v-if='syncing') 正在读取日程…
      template(v-else-if='actualLoading && viewMode === "week"') 正在读取活跃记录…
      template(v-else-if='actualError && viewMode === "week"') 活跃记录暂不可用
      template(v-else-if='viewMode === "week"') 点击空白时段添加日程
      template(v-else) 选择日期查看当天日程

  b-sidebar.aw-schedule-drawer(
    v-model='drawerOpen', title='日程详情', right, shadow, lazy,
    width='min(92vw, 380px)', bg-variant='', text-variant=''
  )
    div.schedule-drawer-body(v-if='selectedEntry')
      ScheduleDetail(
        :entry='selectedEntry', :actual='selectedActual',
        :actual-loading='detailActualLoading', :actual-error='detailActualError',
        :is-remote='remoteEntry(selectedEntry)',
        @edit='openEdit(selectedEntry)', @delete='requestDelete(selectedEntry)'
      )

  b-modal(
    ref='editModal', :title='editing ? "编辑日程" : "添加日程"',
    :ok-title='saving ? "保存中…" : "保存"', cancel-title='取消',
    :ok-disabled='!formIsValid || saving', :cancel-disabled='saving',
    :no-close-on-backdrop='saving', :no-close-on-esc='saving', :hide-header-close='saving',
    @ok.prevent='submit', @hidden='cancelEdit'
  )
    b-form.schedule-form(@submit.prevent='submit')
      b-alert(v-if='saveError', variant='danger', show) {{ saveError }}
      p.schedule-form-date {{ formDateLabel }}
      b-form-group(label='标题', label-for='schedule-title')
        b-form-input#schedule-title(v-model='form.title', required, :disabled='saving', placeholder='例如：组会、论文写作')
      b-form-group
        b-form-checkbox(v-model='form.allDay', :disabled='saving') 全天日程
      div.schedule-time-fields(v-if='!form.allDay')
        b-form-group(label='开始', label-for='schedule-start')
          b-form-input#schedule-start(v-model='form.start', type='time', required, :disabled='saving')
        b-form-group(:label='endNextDay ? "结束 · 次日" : "结束"', label-for='schedule-end')
          b-form-input#schedule-end(v-model='form.end', type='time', required, :disabled='saving')
      b-form-group(label='备注', label-for='schedule-notes')
        b-form-textarea#schedule-notes(v-model='form.notes', :disabled='saving', rows='3', placeholder='可选')

  b-modal(ref='deleteModal', title='删除日程', ok-title='删除', ok-variant='danger', cancel-title='取消', :ok-disabled='deleting', @ok.prevent='confirmDelete')
    p(v-if='pendingDelete') 确定删除「{{ pendingDelete.data.title }}」？删除标记将同步到其他设备。
    b-alert(v-if='deleteError', variant='danger', show) {{ deleteError }}
</template>

<script lang="ts">
import 'vue-awesome/icons/plus';
import 'vue-awesome/icons/chevron-left';
import 'vue-awesome/icons/chevron-right';
import FullCalendar from '@fullcalendar/vue';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import zhCnLocale from '@fullcalendar/core/locales/zh-cn';
import moment from 'moment';

import {
  fetchSchedule,
  saveEntry,
  deleteEntry,
  fetchActualEvents,
  localScheduleBucketId,
  isLocalScheduleBucket,
  entryColor,
  entryUid,
  newEntryUid,
  fmtTime,
  ScheduleEntry,
  EntryActual,
} from '~/util/schedule';
import { IEvent } from '~/util/interfaces';
import ScheduleDetail from './ScheduleDetail.vue';

const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export default {
  name: 'Schedule',
  components: { FullCalendar, ScheduleDetail },
  data() {
    return {
      viewMode: 'week' as 'week' | 'month',
      isMobile:
        typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 991px)').matches,
      fcDate: moment().startOf('day'),
      month: moment().startOf('month'),
      entries: [] as ScheduleEntry[],
      actualEvents: [] as IEvent[],
      showActual: true,
      zoom: 100,
      openingTime: moment().format('HH:mm:ss'),
      selectedEntry: null as ScheduleEntry | null,
      drawerOpen: false,
      loadError: null as string | null,
      cleanupError: null as string | null,
      saveError: null as string | null,
      actualError: false,
      actualLoading: false,
      syncing: false,
      saving: false,
      deleting: false,
      pendingDelete: null as ScheduleEntry | null,
      deleteError: null as string | null,
      editing: null as ScheduleEntry | null,
      editingDeleted: false,
      editingDate: null as moment.Moment | null,
      form: { title: '', allDay: false, start: '09:00', end: '10:00', notes: '' },
      weekdays: ['一', '二', '三', '四', '五', '六', '日'],
      localBucketId: '',
      scheduleSeq: 0,
      actualSeq: 0,
      detailSeq: 0,
      detailEvents: [] as IEvent[],
      detailLoading: false,
      detailError: false,
      mediaQuery: null as MediaQueryList | null,
      disposed: false,
      schedulePoll: null as ReturnType<typeof setInterval> | null,
    };
  },
  computed: {
    weekStart(): moment.Moment {
      return this.fcDate.clone().startOf('isoWeek');
    },
    focusYear(): number {
      return (this.viewMode === 'month' ? this.month : this.fcDate).year();
    },
    periodLabel(): string {
      if (this.viewMode === 'month') return this.month.format('M 月');
      const ws = this.weekStart;
      const end = ws.clone().add(6, 'days');
      return ws.month() === end.month()
        ? `${ws.format('M 月 D')} – ${end.format('D 日')}`
        : `${ws.format('M 月 D 日')} – ${end.format('M 月 D 日')}`;
    },
    visibleRange(): { start: moment.Moment; end: moment.Moment } {
      if (this.viewMode === 'week')
        return { start: this.weekStart, end: this.weekStart.clone().add(7, 'days') };
      const start = this.month.clone().startOf('month').startOf('isoWeek');
      return { start, end: start.clone().add(42, 'days') };
    },
    visibleRangeKey(): string {
      return `${
        this.viewMode
      }:${this.visibleRange.start.valueOf()}/${this.visibleRange.end.valueOf()}`;
    },
    weekDays(): any[] {
      const today = moment();
      return Array.from({ length: 7 }, (_, i) => {
        const date = this.weekStart.clone().add(i, 'days');
        return {
          date,
          key: date.format('YYYY-MM-DD'),
          label: weekdayNames[date.day()],
          today: date.isSame(today, 'day'),
        };
      });
    },
    cells(): any[] {
      return Array.from({ length: 42 }, (_, i) => {
        const date = this.visibleRange.start.clone().add(i, 'days');
        return {
          date,
          key: date.format('YYYY-MM-DD'),
          out: !date.isSame(this.month, 'month'),
          today: date.isSame(moment(), 'day'),
          entries: this.entriesOn(date),
        };
      });
    },
    trimmedTitle(): string {
      return (this.form.title || '').trim();
    },
    formIsValid(): boolean {
      return (
        !this.editingDeleted &&
        !!this.trimmedTitle &&
        (this.form.allDay || (validTime(this.form.start) && validTime(this.form.end)))
      );
    },
    formDateLabel(): string {
      return (this.editingDate || this.fcDate).format('YYYY 年 M 月 D 日 dddd');
    },
    endNextDay(): boolean {
      return !this.form.allDay && this.form.end <= this.form.start;
    },
    fcEvents(): any[] {
      const schedule = this.entries.map(e => {
        const start = moment(e.timestamp);
        return {
          id: entryUid(e),
          title: e.data.title,
          start: start.format(e.data.allDay ? 'YYYY-MM-DD' : undefined),
          end: e.data.allDay ? undefined : start.clone().add(e.duration, 'seconds').format(),
          allDay: !!e.data.allDay,
          backgroundColor: entryColor(e.data.title),
          borderColor: 'transparent',
          textColor: '#26324a',
        };
      });
      return this.showActual && !this.actualError
        ? [...schedule, ...this.backdropEvents()]
        : schedule;
    },
    calendarOptions(): any {
      return {
        plugins: [timeGridPlugin, interactionPlugin],
        locale: zhCnLocale,
        initialView: this.isMobile ? 'timeGridDay' : 'timeGridWeek',
        initialDate: this.fcDate.toDate(),
        firstDay: 1,
        slotDuration: '00:30:00',
        scrollTime: this.openingTime,
        scrollTimeReset: false,
        slotLabelInterval: '01:00:00',
        slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
        eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
        headerToolbar: false,
        height: 'clamp(520px, calc(100vh - 260px), 820px)',
        allDaySlot: true,
        allDayText: '全天',
        nowIndicator: true,
        expandRows: true,
        eventMinHeight: 22,
        eventShortHeight: 38,
        slotEventOverlap: false,
        dayMaxEvents: true,
        events: this.fcEvents,
        eventClick: this.onEventClick,
        dateClick: this.onDateClick,
        dayHeaderContent: this.dayHeaderContent,
      };
    },
    detailNeedsQuery(): boolean {
      if (!this.selectedEntry || this.selectedEntry.data.allDay) return false;
      const start = moment(this.selectedEntry.timestamp);
      const end = start.clone().add(this.selectedEntry.duration, 'seconds');
      return start.isBefore(this.visibleRange.start) || end.isAfter(this.visibleRange.end);
    },
    detailActualLoading(): boolean {
      return this.detailNeedsQuery ? this.detailLoading : this.actualLoading;
    },
    detailActualError(): boolean {
      return this.detailNeedsQuery ? this.detailError : this.actualError;
    },
    selectedActual(): EntryActual | undefined {
      if (
        !this.selectedEntry ||
        this.selectedEntry.data.allDay ||
        this.detailActualLoading ||
        this.detailActualError
      )
        return undefined;
      const entry = this.selectedEntry;
      const es = moment(entry.timestamp).valueOf();
      const ee = es + entry.duration * 1000;
      let activeSeconds = 0;
      const apps = new Map<string, number>();
      for (const ev of this.detailNeedsQuery ? this.detailEvents : this.actualEvents) {
        const s = moment(ev.timestamp).valueOf();
        const seconds =
          Math.max(0, Math.min(s + ev.duration * 1000, ee, Date.now()) - Math.max(s, es)) / 1000;
        activeSeconds += seconds;
        const app = ev.data?.app || '(unknown)';
        if (seconds > 0) apps.set(app, (apps.get(app) || 0) + seconds);
      }
      return {
        activeSeconds,
        scheduledSeconds: entry.duration,
        topApps: [...apps.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([app, seconds]) => ({ app, seconds })),
      };
    },
  },
  watch: {
    selectedEntry() {
      this.refreshDetailActual();
    },
    fcDate() {
      this.syncCalendar();
    },
    viewMode() {
      this.syncCalendar();
    },
    isMobile() {
      this.syncCalendar();
    },
    visibleRangeKey() {
      this.drawerOpen = false;
      this.selectedEntry = null;
      this.entries = [];
      this.actualEvents = [];
      this.refresh();
    },
  },
  mounted() {
    this.mediaQuery = window.matchMedia?.('(max-width: 991px)') || null;
    if (this.mediaQuery?.addEventListener)
      this.mediaQuery.addEventListener('change', this.onMediaChange);
    else this.mediaQuery?.addListener(this.onMediaChange);
    // Opening a calendar is a read operation; bucket creation belongs to saving.
    localScheduleBucketId()
      .then(id => {
        if (!this.disposed) this.localBucketId = id;
      })
      .catch(() => {
        // Schedule reads report connection errors; no write is attempted here.
      });
    this.refresh();
    this.syncCalendar();
    this.schedulePoll = setInterval(() => {
      if (!this.disposed && !this.saving && !this.deleting && !this.syncing) this.refreshSchedule();
    }, 5 * 60_000);
  },
  beforeDestroy() {
    this.disposed = true;
    if (this.schedulePoll) clearInterval(this.schedulePoll);
    this.scheduleSeq++;
    this.actualSeq++;
    this.detailSeq++;
    if (this.mediaQuery?.removeEventListener)
      this.mediaQuery.removeEventListener('change', this.onMediaChange);
    else this.mediaQuery?.removeListener(this.onMediaChange);
  },
  methods: {
    entryColor,
    entryUid,
    onMediaChange(event: MediaQueryListEvent) {
      this.isMobile = event.matches;
    },
    async syncCalendar() {
      await this.$nextTick();
      if (this.disposed || this.viewMode !== 'week') return;
      const api = this.$refs.fc?.getApi();
      if (!api) return;
      const type = this.isMobile ? 'timeGridDay' : 'timeGridWeek';
      if (api.view.type !== type) api.changeView(type, this.fcDate.toDate());
      else if (!moment(api.getDate()).isSame(this.fcDate, 'day'))
        api.gotoDate(this.fcDate.toDate());
      await this.$nextTick();
      const now = moment();
      const showsToday = this.isMobile
        ? this.fcDate.isSame(now, 'day')
        : this.weekStart.isSame(now, 'isoWeek');
      this.centerTime(
        showsToday ? now.hours() * 3600 + now.minutes() * 60 + now.seconds() : 8 * 3600
      );
    },
    currentClockSeconds(): number {
      const now = moment();
      return now.hours() * 3600 + now.minutes() * 60 + now.seconds();
    },
    timeViewport(): { scroller: HTMLElement; slots: HTMLElement } | null {
      const slots = this.$refs.fc?.$el.querySelector('.fc-timegrid-slots') as HTMLElement;
      const scroller = slots?.closest('.fc-scroller') as HTMLElement;
      return slots && scroller ? { slots, scroller } : null;
    },
    centerTime(seconds: number) {
      const viewport = this.timeViewport();
      if (!viewport) return;
      const { slots, scroller } = viewport;
      const rect = slots.getBoundingClientRect();
      if (!rect.height) {
        this.$refs.fc?.getApi().scrollToTime({ seconds: Math.max(0, seconds - 7200) });
        return;
      }
      scroller.scrollTop +=
        rect.top -
        scroller.getBoundingClientRect().top +
        (seconds / 86400) * rect.height -
        scroller.clientHeight / 2;
    },
    async setZoom(value: number) {
      const viewport = this.timeViewport();
      const slotsRect = viewport?.slots.getBoundingClientRect();
      // Retain the time at the viewport centre when enlarging or shrinking.
      const centreSeconds = slotsRect?.height
        ? ((viewport.scroller.getBoundingClientRect().top +
            viewport.scroller.clientHeight / 2 -
            slotsRect.top) /
            slotsRect.height) *
          86400
        : this.currentClockSeconds();
      // FullCalendar 5 caches slot coordinates: changing CSS height alone leaves
      // events, hit testing and the now indicator at their old positions. The
      // zoom key remounts the grid so all coordinates are measured together.
      this.zoom = Math.max(75, Math.min(200, value));
      await this.$nextTick();
      if (this.disposed || this.viewMode !== 'week') return;
      this.$refs.fc?.getApi().updateSize();
      this.centerTime(centreSeconds);
    },
    entriesOn(day: moment.Moment): ScheduleEntry[] {
      const start = day.clone().startOf('day').valueOf();
      const end = day.clone().startOf('day').add(1, 'day').valueOf();
      return this.entries.filter(e => {
        const s = moment(e.timestamp).valueOf();
        return e.data.allDay || e.duration === 0
          ? s >= start && s < end
          : s < end && s + e.duration * 1000 > start;
      });
    },
    entryLabel(e: ScheduleEntry): string {
      return e.data.allDay
        ? `${e.data.title}（全天）`
        : `${fmtTime(moment(e.timestamp))} ${e.data.title}`;
    },
    remoteEntry(e: ScheduleEntry): boolean {
      return (
        !!this.localBucketId &&
        !!e._bucket_id &&
        !isLocalScheduleBucket(e._bucket_id, this.localBucketId)
      );
    },
    async refresh() {
      const jobs = [this.refreshSchedule()];
      if (this.viewMode === 'week') jobs.push(this.refreshActual());
      else {
        this.actualSeq++;
        this.actualLoading = false;
        this.actualEvents = [];
      }
      await Promise.all(jobs);
    },
    async refreshSchedule() {
      const seq = ++this.scheduleSeq;
      const range = this.visibleRange;
      this.syncing = true;
      this.loadError = null;
      this.cleanupError = null;
      try {
        const entries = await fetchSchedule(range.start, range.end, {
          cleanup: true,
          onDeletedUids: uids => {
            if (
              seq === this.scheduleSeq &&
              this.editing?.data.uid &&
              uids.has(this.editing.data.uid)
            ) {
              this.editingDeleted = true;
              this.saveError = '该日程已被删除，请关闭弹窗后新建日程';
            }
          },
          onCleanupError: error => {
            if (seq === this.scheduleSeq)
              this.cleanupError =
                '已删除日程的清理暂未完成，下次加载会重试：' + this.errorMessage(error);
          },
        });
        if (seq !== this.scheduleSeq) return;
        this.entries = entries;
        if (this.selectedEntry)
          this.selectedEntry =
            entries.find(e => entryUid(e) === entryUid(this.selectedEntry)) || null;
        if (!this.selectedEntry) this.drawerOpen = false;
      } catch (err) {
        if (seq === this.scheduleSeq) this.loadError = '日程读取失败：' + this.errorMessage(err);
      } finally {
        if (seq === this.scheduleSeq) this.syncing = false;
      }
    },
    async refreshDetailActual() {
      const seq = ++this.detailSeq;
      this.detailEvents = [];
      this.detailError = false;
      this.detailLoading = false;
      if (!this.detailNeedsQuery) return;
      const start = moment(this.selectedEntry.timestamp);
      this.detailLoading = true;
      try {
        const events = await fetchActualEvents(
          start,
          start.clone().add(this.selectedEntry.duration, 'seconds')
        );
        if (seq === this.detailSeq) this.detailEvents = events;
      } catch {
        if (seq === this.detailSeq) this.detailError = true;
      } finally {
        if (seq === this.detailSeq) this.detailLoading = false;
      }
    },
    async refreshActual() {
      const seq = ++this.actualSeq;
      const range = this.visibleRange;
      this.actualLoading = true;
      this.actualError = false;
      this.actualEvents = [];
      try {
        const events = await fetchActualEvents(range.start, range.end);
        if (seq === this.actualSeq) this.actualEvents = events;
      } catch {
        if (seq === this.actualSeq) this.actualError = true;
      } finally {
        if (seq === this.actualSeq) this.actualLoading = false;
      }
    },
    errorMessage(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    },
    dayHeaderContent(info: any) {
      const date = moment(info.date);
      const label = document.createElement('span');
      label.className = 'schedule-fc-day';
      const name = document.createElement('span');
      name.className = 'schedule-fc-weekday';
      name.textContent = weekdayNames[date.day()];
      const number = document.createElement('span');
      number.className = 'schedule-fc-number';
      number.textContent = String(date.date());
      label.append(name, number);
      return { domNodes: [label] };
    },
    onEventClick(info: any) {
      if (info.event.display === 'background') return;
      const entry = this.entries.find(e => entryUid(e) === info.event.id);
      if (entry) {
        this.selectedEntry = entry;
        this.drawerOpen = true;
      }
    },
    onDateClick(info: any) {
      const date = moment(info.date);
      this.openAdd(
        date.format('HH:mm'),
        date.clone().add(1, 'hour').format('HH:mm'),
        !!info.allDay,
        date
      );
    },
    backdropEvents(): any[] {
      const now = Date.now();
      const spans = this.actualEvents
        .map(ev => {
          const s = moment(ev.timestamp).valueOf();
          return { s, t: Math.min(s + ev.duration * 1000, now) };
        })
        .filter(span => Number.isFinite(span.s) && span.t > span.s)
        .sort((a, b) => a.s - b.s);
      const blocks: { s: number; t: number }[] = [];
      for (const span of spans) {
        const last = blocks[blocks.length - 1];
        if (last && span.s - last.t <= 60_000) last.t = Math.max(last.t, span.t);
        else blocks.push({ ...span });
      }
      return blocks.map(b => ({
        display: 'background',
        classNames: ['schedule-activity'],
        start: moment(b.s).format(),
        end: moment(b.t).format(),
      }));
    },
    setMode(mode: 'week' | 'month') {
      if (mode === this.viewMode) return;
      if (mode === 'month') this.month = this.fcDate.clone().startOf('month');
      else if (!this.fcDate.isSame(this.month, 'month'))
        this.fcDate = this.month
          .clone()
          .date(Math.min(this.fcDate.date(), this.month.daysInMonth()));
      this.viewMode = mode;
    },
    shiftPeriod(n: number) {
      if (this.viewMode === 'month') this.month = this.month.clone().add(n, 'months');
      else this.gotoDay(this.fcDate.clone().add(n * 7, 'days'));
    },
    goToday() {
      this.fcDate = moment().startOf('day');
      this.month = this.fcDate.clone().startOf('month');
      this.syncCalendar();
    },
    gotoDay(date: moment.Moment) {
      this.fcDate = date.clone().startOf('day');
    },
    jumpToWeek(date: moment.Moment) {
      this.gotoDay(date);
      this.viewMode = 'week';
    },
    openAdd(start = '09:00', end = '10:00', allDay = false, date?: moment.Moment) {
      this.editing = null;
      this.editingDeleted = false;
      this.editingDate = date ? date.clone().startOf('day') : this.fcDate.clone().startOf('day');
      this.saveError = null;
      this.form = { title: '', allDay, start, end, notes: '' };
      this.$refs.editModal.show();
    },
    openEdit(entry: ScheduleEntry) {
      this.editing = entry;
      this.editingDeleted = false;
      this.editingDate = moment(entry.timestamp).startOf('day');
      this.saveError = null;
      const start = moment(entry.timestamp);
      this.form = {
        title: entry.data.title,
        allDay: !!entry.data.allDay,
        start: start.format('HH:mm'),
        end: start.clone().add(entry.duration, 'seconds').format('HH:mm'),
        notes: entry.data.notes || '',
      };
      this.drawerOpen = false;
      this.$refs.editModal.show();
    },
    cancelEdit() {
      this.editing = null;
      this.editingDeleted = false;
      this.editingDate = null;
    },
    async submit() {
      if (this.saving || !this.formIsValid) return;
      this.saving = true;
      this.saveError = null;
      try {
        const day = (this.editingDate || this.fcDate).clone().startOf('day');
        const [sh, sm] = this.form.start.split(':').map(Number);
        const [eh, em] = this.form.end.split(':').map(Number);
        const start = this.form.allDay ? day.clone() : day.clone().hours(sh).minutes(sm);
        let end = day.clone().hours(eh).minutes(em);
        if (this.endNextDay) end = end.add(1, 'day');
        const entry: ScheduleEntry = {
          timestamp: start.toISOString(true),
          duration: this.form.allDay ? 0 : end.diff(start, 'seconds'),
          data: {
            title: this.trimmedTitle,
            notes: this.form.notes.trim() || undefined,
            allDay: this.form.allDay || undefined,
            uid: this.editing ? this.editing.data.uid : newEntryUid(),
          },
        };
        if (this.editing) {
          entry.id = this.editing.id;
          entry._bucket_id = this.editing._bucket_id;
        }
        await saveEntry(entry);
        this.$refs.editModal.hide();
        await this.refreshSchedule();
      } catch (err) {
        this.saveError = '保存失败：' + this.errorMessage(err);
      } finally {
        this.saving = false;
      }
    },
    requestDelete(entry: ScheduleEntry) {
      this.pendingDelete = entry;
      this.deleteError = null;
      this.$refs.deleteModal.show();
    },
    async confirmDelete() {
      if (this.deleting || !this.pendingDelete) return;
      this.deleting = true;
      try {
        await deleteEntry(this.pendingDelete);
        this.selectedEntry = null;
        this.drawerOpen = false;
        this.pendingDelete = null;
        this.$refs.deleteModal.hide();
        await this.refreshSchedule();
      } catch (err) {
        this.deleteError = '删除失败：' + this.errorMessage(err);
      } finally {
        this.deleting = false;
      }
    },
  },
};
</script>

<style lang="scss">
.schedule-page {
  --schedule-surface: var(--aw-vis-tooltip-bg, #fff);
  --schedule-text: var(--aw-vis-text, #3c4257);
  --schedule-muted: var(--aw-vis-subtext, #6b7280);
  --schedule-line: var(--aw-vis-grid, #e5e9f0);
  --schedule-accent: #456dd3;
  color: var(--schedule-text);

  button:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--schedule-accent);
    outline-offset: 3px;
  }
  .schedule-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 22px;
    flex-wrap: wrap;
  }
  .schedule-heading {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  .schedule-eyebrow {
    color: var(--schedule-muted);
    font-size: 14px;
  }
  .schedule-heading h3 {
    font-size: 23px;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.5px;
  }
  .schedule-year {
    color: var(--schedule-muted);
    font-size: 13px;
  }
  .schedule-actions,
  .schedule-navigation {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .schedule-navigation {
    margin-right: 8px;
  }
  .schedule-navigation button {
    color: var(--schedule-text);
    background: transparent;
    border: 0;
    border-radius: 7px;
    height: 34px;
    padding: 0 11px;
    font-size: 13px;
  }
  .schedule-navigation button:hover {
    background: var(--schedule-line);
  }
  .schedule-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .schedule-today {
    font-weight: 500;
  }
  .schedule-view-switch {
    display: flex;
    padding: 3px;
    border-radius: 8px;
    background: var(--schedule-line);
  }
  .schedule-view-switch button {
    color: var(--schedule-muted);
    border: 0;
    background: transparent;
    border-radius: 6px;
    padding: 4px 16px;
    font-size: 13px;
  }
  .schedule-view-switch button[aria-pressed='true'] {
    background: var(--schedule-surface);
    color: var(--schedule-text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.07);
  }
  .schedule-add {
    padding: 7px 13px;
    border-radius: 8px;
    font-size: 13px;
    margin-left: 6px;
  }
  .schedule-surface {
    background: var(--schedule-surface);
    border: 1px solid var(--schedule-line);
    border-radius: 12px;
    overflow: hidden;
  }
  .schedule-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .schedule-footer,
  .schedule-legend {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }
  .schedule-footer {
    justify-content: space-between;
    padding: 14px 3px 0;
    font-size: 12px;
    color: var(--schedule-muted);
  }
  .schedule-zoom {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .schedule-zoom > span {
    margin-right: 3px;
  }
  .schedule-zoom button {
    background: transparent;
    color: var(--schedule-text);
    border: 1px solid var(--schedule-line);
    border-radius: 6px;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
  }
  .schedule-zoom button:hover:not(:disabled) {
    background: var(--schedule-line);
  }
  .schedule-zoom button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .schedule-zoom .schedule-zoom-value {
    width: 48px;
    font-variant-numeric: tabular-nums;
  }
  .schedule-zoom .schedule-now {
    margin-left: 4px;
  }
  .schedule-legend span,
  .schedule-actual-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin: 0;
  }
  .schedule-legend-plan {
    height: 10px;
    width: 14px;
    background: #e0e8fc;
    border-left: 3px solid var(--schedule-accent);
    border-radius: 2px;
  }
  .schedule-legend-actual {
    height: 12px;
    width: 4px;
    background: #4ea87c;
    border-radius: 2px;
  }
  .schedule-actual-toggle {
    cursor: pointer;
  }
  .schedule-actual-toggle input {
    accent-color: var(--schedule-accent);
  }
  .schedule-days {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
  }
  .schedule-day {
    flex: 1;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: var(--schedule-muted);
    padding: 6px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    font-size: 12px;
  }
  .schedule-day b {
    font-size: 17px;
    font-weight: 500;
    color: var(--schedule-text);
  }
  .schedule-day[aria-pressed='true'] {
    background: var(--schedule-accent);
    color: #fff;
  }
  .schedule-day[aria-pressed='true'] b {
    color: #fff;
  }
  .schedule-day--today:not([aria-pressed='true']) b {
    text-decoration: underline;
    text-underline-offset: 5px;
  }
  .schedule-month-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
  .schedule-month-weekday {
    text-align: center;
    color: var(--schedule-muted);
    padding: 15px 0;
    font-size: 12px;
  }
  .schedule-month-day {
    display: flex;
    flex-direction: column;
    text-align: left;
    background: transparent;
    color: var(--schedule-text);
    min-height: 116px;
    padding: 10px;
    border: 0;
    border-top: 1px solid var(--schedule-line);
    border-right: 1px solid var(--schedule-line);
    gap: 5px;
    min-width: 0;
  }
  .schedule-month-day:nth-child(7n) {
    border-right: 0;
  }
  .schedule-month-day:hover {
    background: color-mix(in srgb, var(--schedule-line) 45%, transparent);
  }
  .schedule-month-day--out .schedule-month-number {
    color: var(--schedule-muted);
    opacity: 0.6;
  }
  .schedule-month-number {
    align-self: flex-start;
    border-radius: 50%;
    width: 25px;
    height: 25px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
  }
  .schedule-month-day--today .schedule-month-number {
    background: var(--schedule-accent);
    color: #fff;
  }
  .schedule-month-entry {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }
  .schedule-month-entry i {
    display: inline-block;
    width: 5px;
    height: 9px;
    border-radius: 2px;
    margin-right: 5px;
  }
  .schedule-month-more {
    font-size: 11px;
    color: var(--schedule-muted);
  }
}
.aw-schedule-fc {
  --fc-border-color: var(--schedule-line);
  --fc-page-bg-color: var(--schedule-surface);
  --fc-neutral-bg-color: var(--schedule-surface);
  --fc-today-bg-color: rgba(69, 109, 211, 0.035);
  --fc-now-indicator-color: #dd6b64;
  .fc-scrollgrid {
    border: 0;
  }
  .fc-col-header-cell-cushion {
    padding: 13px 0 11px;
    color: var(--schedule-text);
    text-decoration: none;
    width: 100%;
  }
  .schedule-fc-day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .schedule-fc-weekday {
    color: var(--schedule-muted);
    font-size: 12px;
    font-weight: 400;
  }
  .schedule-fc-number {
    font-size: 19px;
    font-weight: 500;
    width: 31px;
    height: 31px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }
  .fc-day-today .schedule-fc-number {
    color: #fff;
    background: var(--schedule-accent);
  }
  .fc-timegrid-now-indicator-container,
  .fc-timegrid-now-indicator-line,
  .fc-timegrid-now-indicator-arrow {
    pointer-events: none;
  }
  .fc-timegrid-slot {
    height: calc(26px * var(--schedule-zoom, 1));
  }
  .fc-timegrid-slot-label {
    color: var(--schedule-muted);
    font-size: 11px;
  }
  .fc-timegrid-slot-label-cushion {
    padding: 0 12px;
  }
  .fc-timegrid-slot-minor {
    border-top-style: solid;
    border-top-color: color-mix(in srgb, var(--schedule-line) 45%, transparent);
  }
  .fc-timegrid-axis-cushion {
    font-size: 12px;
    color: var(--schedule-muted);
    padding: 10px;
  }
  .fc-timegrid-event,
  .fc-daygrid-event {
    border-radius: 6px;
    box-shadow: none;
  }
  .fc-timegrid-event .fc-event-main {
    padding: 4px 6px;
  }
  .fc-event-time {
    font-size: 11px;
    font-weight: 400;
    opacity: 0.8;
  }
  .fc-event-title {
    font-size: 12px;
    font-weight: 500;
  }
  .fc-bg-event.schedule-activity {
    left: auto;
    right: 1px;
    width: 4px;
    background: #4ea57b;
    opacity: 0.5;
    border-radius: 2px;
    pointer-events: none;
  }
  .fc-timegrid-col-events {
    margin-right: 8px;
  }
  .fc-event {
    cursor: pointer;
  }
}
.aw-schedule-drawer .b-sidebar {
  background: var(--aw-vis-tooltip-bg, #fff);
  color: var(--aw-vis-text, #3c4257);
}
.aw-schedule-drawer .b-sidebar-header {
  padding: 20px 22px;
  font-size: 15px;
  border-bottom: 1px solid var(--aw-vis-grid, #e5e9f0);
}
.schedule-drawer-body {
  padding: 24px;
}
.schedule-form-date {
  color: var(--aw-vis-subtext, #6b7280);
  font-size: 14px;
  margin-bottom: 20px;
}
.schedule-time-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 991px) {
  .schedule-page .schedule-header {
    gap: 16px;
    margin-bottom: 18px;
  }
  .schedule-page .schedule-actions {
    width: 100%;
    justify-content: space-between;
    gap: 4px;
  }
  .schedule-page .schedule-navigation {
    margin-right: 0;
    gap: 0;
  }
  .schedule-page .schedule-navigation button {
    height: 40px;
  }
  .schedule-page .schedule-heading h3 {
    font-size: 21px;
  }
  .schedule-page .schedule-footer {
    gap: 10px;
  }
  .schedule-page .schedule-month-day {
    min-height: 90px;
    padding: 6px;
  }
  .schedule-page .schedule-month-entry {
    font-size: 11px;
  }
  .aw-schedule-fc .fc-col-header-cell-cushion {
    padding: 9px 0;
  }
  .aw-schedule-fc .schedule-fc-day {
    flex-direction: row;
    justify-content: center;
  }
}
@media (max-width: 420px) {
  .schedule-page .schedule-heading {
    gap: 8px;
  }
  .schedule-page .schedule-add {
    padding: 7px 9px;
    margin-left: 0;
    font-size: 12px;
  }
  .schedule-page .schedule-view-switch button {
    padding: 5px 11px;
  }
  .schedule-page .schedule-navigation button {
    padding: 0 8px;
  }
  .schedule-page .schedule-month-day {
    min-height: 80px;
    padding: 4px;
  }
}
</style>
