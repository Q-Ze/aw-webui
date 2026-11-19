<template lang="pug">
article.schedule-detail
  div.schedule-detail-heading
    span.schedule-detail-mark(:style='{ backgroundColor: entryColor(entry.data.title) }')
    h4 {{ entry.data.title }}
  p.schedule-detail-date {{ dateLabel }}
  p.schedule-detail-time {{ entryTimeLabel }}
  p.schedule-detail-notes(v-if='entry.data.notes') {{ entry.data.notes }}
  div.schedule-detail-warning(v-if='isRemote', data-testid='schedule-detail-remote-hint')
    icon(name='exclamation-triangle', scale='0.8')
    span 来自其他设备，编辑不会同步回原设备；删除标记会同步
  section.schedule-detail-activity(v-if='!entry.data.allDay')
    h5 时段内实际活跃
    p.schedule-detail-muted(v-if='actualLoading', role='status') 正在读取活跃记录…
    p.schedule-detail-muted(v-else-if='actualError', role='status') 活跃记录暂不可用，请返回日历重试。
    template(v-else-if='actual')
      div.schedule-detail-values
        strong {{ fmtDur(actual.activeSeconds) }}
        span / {{ fmtDur(entry.duration || 0) }} 计划时长
      div.schedule-actual-bar(role='progressbar', :aria-valuenow='pct', aria-valuemin='0', aria-valuemax='100', aria-label='时段内活跃占比')
        div.schedule-actual-fill(:style='{ width: pct + "%" }')
      p.schedule-detail-muted 实际活跃 {{ fmtDur(actual.activeSeconds) }} / 计划 {{ fmtDur(entry.duration || 0) }}（{{ pct }}%）
      ul.schedule-detail-apps(v-if='actual.topApps.length')
        li(v-for='app in actual.topApps', :key='app.app')
          span {{ app.app }}
          span {{ fmtDur(app.seconds) }}
  div.schedule-detail-actions
    b-button(variant='outline-primary', @click='$emit("edit")', data-testid='schedule-detail-edit')
      icon.mr-2(name='pen', scale='0.8')
      | 编辑日程
    b-button(variant='link', @click='$emit("delete")', data-testid='schedule-detail-delete')
      icon.mr-2(name='trash', scale='0.8')
      | 删除
</template>

<script lang="ts">
import 'vue-awesome/icons/pen';
import 'vue-awesome/icons/trash';
import 'vue-awesome/icons/exclamation-triangle';
import moment from 'moment';
import { entryColor, fmtTime, ScheduleEntry, EntryActual } from '~/util/schedule';

export default {
  name: 'ScheduleDetail',
  props: {
    entry: { type: Object as () => ScheduleEntry, required: true },
    actual: { type: Object as () => EntryActual | undefined, default: undefined },
    actualLoading: { type: Boolean, default: false },
    actualError: { type: Boolean, default: false },
    isRemote: { type: Boolean, default: false },
  },
  computed: {
    dateLabel(): string {
      return moment(this.entry.timestamp).format('M 月 D 日 dddd');
    },
    entryTimeLabel(): string {
      if (this.entry.data.allDay) return '全天';
      const start = moment(this.entry.timestamp);
      const end = start.clone().add(this.entry.duration, 'seconds');
      return `${fmtTime(start)}–${end.isSame(start, 'day') ? '' : '次日 '}${fmtTime(end)}`;
    },
    pct(): number {
      if (!this.actual || this.actual.scheduledSeconds <= 0) return 0;
      return Math.min(
        100,
        Math.round((this.actual.activeSeconds / this.actual.scheduledSeconds) * 100)
      );
    },
  },
  methods: {
    entryColor,
    fmtDur(seconds: number): string {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h > 0 ? `${h}小时${m ? m + '分' : ''}` : `${m}分钟`;
    },
  },
};
</script>

<style lang="scss" scoped>
.schedule-detail {
  color: var(--aw-vis-text, #3c4257);
}
.schedule-detail-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.schedule-detail-mark {
  width: 6px;
  height: 25px;
  border-radius: 3px;
  flex-shrink: 0;
  margin-top: 3px;
}
.schedule-detail-heading h4 {
  font-size: 22px;
  line-height: 1.4;
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.schedule-detail-date {
  font-size: 13px;
  color: var(--aw-vis-subtext, #6b7280);
  margin: 17px 0 5px;
}
.schedule-detail-time {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  margin-bottom: 22px;
}
.schedule-detail-notes {
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.schedule-detail-warning {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 12px;
  border-radius: 8px;
  background: rgba(205, 150, 52, 0.1);
  color: var(--aw-vis-text, #3c4257);
  font-size: 12px;
  margin: 20px 0;
}
.schedule-detail-warning svg {
  flex-shrink: 0;
  margin-top: 3px;
}
.schedule-detail-activity {
  border-top: 1px solid var(--aw-vis-grid, #e5e9f0);
  padding-top: 24px;
  margin-top: 24px;
}
.schedule-detail-activity h5 {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 15px;
}
.schedule-detail-values {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.schedule-detail-values strong {
  font-size: 24px;
  font-weight: 500;
}
.schedule-detail-values span,
.schedule-detail-muted {
  font-size: 12px;
  color: var(--aw-vis-subtext, #6b7280);
}
.schedule-detail-muted {
  line-height: 1.6;
  margin: 10px 0;
}
.schedule-actual-bar {
  height: 5px;
  border-radius: 3px;
  background: var(--aw-vis-grid, #e5e9f0);
  overflow: hidden;
  margin-top: 12px;
}
.schedule-actual-fill {
  height: 100%;
  background: #4ea57b;
}
.schedule-detail-apps {
  padding: 0;
  margin: 20px 0 0;
  list-style: none;
}
.schedule-detail-apps li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  padding: 7px 0;
}
.schedule-detail-apps li span:first-child {
  overflow-wrap: anywhere;
}
.schedule-detail-apps li span:last-child {
  color: var(--aw-vis-subtext, #6b7280);
  flex-shrink: 0;
}
.schedule-detail-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 30px;
  padding-top: 22px;
  border-top: 1px solid var(--aw-vis-grid, #e5e9f0);
}
.schedule-detail-actions .btn {
  border-radius: 7px;
  font-size: 13px;
}
</style>
