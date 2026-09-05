<template lang="pug">
div.annual-report
  div.d-flex.align-items-center.flex-wrap.mb-4
    h4.mb-0 🎉 {{ yearNum }} 年度报告
    b-button.ml-3(size="sm", variant="outline-secondary", :disabled="loading", @click="load(true)")
      b-spinner.mr-1(v-if="loading", small)
      | {{ loading ? '计算中…' : '刷新数据' }}
    b-button.ml-2(size="sm", variant="outline-secondary", v-if="yearNum > firstKnownYear", :to="`/annual-report/${yearNum - 1}`") ← {{ yearNum - 1 }}
    b-button.ml-1(size="sm", variant="outline-secondary", v-if="yearNum < currentYear", :to="`/annual-report/${yearNum + 1}`") {{ yearNum + 1 }} →

  b-alert(v-if="error", variant="danger", show) {{ error }}

  div(v-if="stats")
    // 开场
    div.report-card.hero
      div.small.text-muted {{ yearNum }}，你在电脑前度过的时光
      div.hero-number {{ totalHours }}
      div.hero-unit 小时
      div.small.text-muted.mt-2
        | 覆盖 <b>{{ stats.activeDays }}</b> 个活跃日 · 日均 <b>{{ avgHours }}</b> 小时
        span(v-if="cachedAt") · 本机缓存于 {{ cachedAt }}（点"刷新数据"重算）

    div.small.text-muted.mt-2(v-if="stats.activeDays === 0")
      | 这一年还没有数据（或尚未开始记录）。

    // 跨年对比
    div.report-card(v-if="yearNum > firstKnownYear")
      div.card-title 📊 跨年对比 · {{ yearNum }} vs {{ yearNum - 1 }}
      div.small.text-muted(v-if="prevLoading") 正在载入 {{ yearNum - 1 }} 年数据…
      template(v-if="prevStats && prevStats.totalSec > 0")
        div.row.small.text-center
          div.col-4
            div.text-muted 总活跃
            div.big-line-sm {{ cmpTotalHours }}
            div(:class="deltaClass(cmp.totalPct)") {{ deltaText(cmp.totalPct) }}
          div.col-4
            div.text-muted 活跃天数
            div.big-line-sm {{ stats.activeDays }} <span.small.text-muted>vs {{ prevStats.activeDays }}</span>
            div(:class="deltaClass(cmp.daysPct)") {{ deltaText(cmp.daysPct) }}
          div.col-4
            div.text-muted 日均小时
            div.big-line-sm {{ avgHours }} <span.small.text-muted>vs {{ prevAvgHours }}</span>
            div(:class="deltaClass(cmp.avgPct)") {{ deltaText(cmp.avgPct) }}
        div.small.text-muted.mt-3 月度对比（蓝 = {{ yearNum }}，灰 = {{ yearNum - 1 }}）
        div.cmp-months-row
          div.cmp-month-col(v-for="m in cmp.monthly", :key="m.label", :title="m.title")
            div.cmp-bars
              div.cmp-bar.cur(:style="{ height: `${m.hA}%` }")
              div.cmp-bar.prev(:style="{ height: `${m.hB}%` }")
            div.small.text-muted.month-label {{ m.label }}
        div.small.mt-3(v-if="cmp.catShifts.length")
          div.text-muted.mb-1 分类变化（按增减小时排序）
          div.cmp-cat-row(v-for="c in cmp.catShifts", :key="c.name")
            span.cmp-cat-name {{ c.name }}
            span(:class="deltaClass(c.deltaHours)") {{ c.deltaHours > 0 ? '▲' : '▼' }} {{ formatSec(Math.abs(c.deltaHours) * 3600).trim() }}
        div.small.text-muted.mt-2 {{ cmp.verdict }}
      div.small.text-muted(v-else-if="!prevLoading") {{ yearNum - 1 }} 年还没有数据，无从对比。

    template(v-if="stats.activeDays > 0")
      // 你的时刻
      div.report-card
        div.card-title ⭐ 最勤奋的一天
        div.big-line {{ stats.busiestDay.date }}
        div.small.text-muted
          | 当天活跃 <b>{{ formatSec(stats.busiestDay.sec) }}</b>
          | —— 占全年总时长的 {{ busiestShare }}%。
        div.small.mt-2(v-if="report.busiest.day")
          span.text-muted 当时主要在：
          template(v-for="(c, i) in report.busiest.day.cats")
            span(v-if="i > 0") 、
            b {{ c.name }}
            span.text-muted （{{ formatSec(c.sec) }}）
          div.small.text-muted.mt-1(v-if="report.busiest.day.apps.length")
            | 应用：{{ report.busiest.day.apps.map(a => a.name).join('、') }}

      // 作息类型
      div.report-card
        div.card-title 🌙 你的作息类型
        div.d-flex.align-items-baseline
          div.big-line {{ stats.chronotype.label }}
          div.small.text-muted.ml-2 全年活跃时间中{{ daypartTopName }}占比最高
        // 时段占比：一根横向分段条 + 图例
        div.daypart-bar.mt-3
          div.daypart-seg.part-morning(:style="{ width: pct(stats.chronotype.dayparts.morning) + '%' }", :title="`上午 ${pct(stats.chronotype.dayparts.morning)}%`")
          div.daypart-seg(:style="{ width: pct(stats.chronotype.dayparts.afternoon) + '%' }", :title="`午后 ${pct(stats.chronotype.dayparts.afternoon)}%`")
          div.daypart-seg.part-evening(:style="{ width: pct(stats.chronotype.dayparts.evening) + '%' }", :title="`晚间 ${pct(stats.chronotype.dayparts.evening)}%`")
          div.daypart-seg.part-night(:style="{ width: pct(stats.chronotype.dayparts.night) + '%' }", :title="`凌晨 ${pct(stats.chronotype.dayparts.night)}%`")
        div.d-flex.flex-wrap.small.text-muted.mt-1
          span.mr-3 ● 上午（05–12）{{ pct(stats.chronotype.dayparts.morning) }}%
          span.mr-3 ● 午后（12–18）{{ pct(stats.chronotype.dayparts.afternoon) }}%
          span.mr-3 ● 晚间（18–24）{{ pct(stats.chronotype.dayparts.evening) }}%
          span ● 凌晨（00–05）{{ pct(stats.chronotype.dayparts.night) }}%
        // 24 小时强度色带：越深越活跃，▲ 标记全年高峰
        div.small.text-muted.mt-3 一天中各钟点的活跃强度（颜色越深越活跃，▲ 为全年最高峰）
        div.ripple-row
          div.ripple-cell(
            v-for="(sec, h) in report.hourly",
            :key="h",
            :style="{ background: rippleColor(sec) }",
            :class="{ 'ripple-peak': h === stats.chronotype.peakHour }",
            :title="`${String(h).padStart(2, '0')}:00 · ${formatSec(sec)}`"
          )
        div.ripple-ticks
          span(v-for="h in [0, 6, 12, 18, 23]", :key="h") {{ String(h).padStart(2, '0') }}
        div.small.text-muted.mt-1
          | 全年高峰出现在 <b>{{ String(stats.chronotype.peakHour).padStart(2, '0') }}:00</b> 前后。
        div.small.text-muted.mt-2(v-if="report.boot.firstBoot")
          | 最早一次开始工作 <b>{{ fmtHM(report.boot.firstBoot) }}</b>（{{ report.boot.firstBoot.date }}）·
          | 最晚一次收工
          b {{ report.boot.lastShutdown.pastMidnight ? '次日 ' : '' }}{{ fmtHM(report.boot.lastShutdown) }}
          | （{{ report.boot.lastShutdown.date }}）·
          | <b>{{ report.boot.lateNightPct }}%</b> 的活跃日持续过零点
          |（一天按 04:00 → 次日 04:00 计；以首次/末次活跃时刻估算，精确到 5 分钟）

      // 坚持与节奏
      div.report-card
        div.card-title 💪 坚持与节奏
        div.row.small
          div.col-6.mb-2
            div.text-muted 最长连续活跃
            div.big-line-sm {{ stats.longestStreak.days }} 天
            div.text-muted 起于 {{ stats.longestStreak.start }}
          div.col-6.mb-2
            div.text-muted 最勤奋的一周
            div.big-line-sm {{ formatSec(stats.busiestWeek.sec) }}
            div.text-muted {{ stats.busiestWeek.start.slice(5) }} – {{ stats.busiestWeek.end }}
        div.small.mt-1(v-if="report.busiest.week && report.busiest.week.cats.length")
          span.text-muted 那一周主要在：
          template(v-for="(c, i) in report.busiest.week.cats.slice(0, 2)")
            span(v-if="i > 0") 、
            b {{ c.name }}
            span.text-muted （{{ formatSec(c.sec) }}）
        div.small.text-muted.mt-2
          | 上半场 <b>{{ formatSec(stats.halfYear.first) }}</b> ·
          | 下半场 <b>{{ formatSec(stats.halfYear.second) }}</b>（{{ halfYearVerdict }}）
        div.small.mt-1(v-if="report.busiest.month && report.busiest.month.cats.length")
          span.text-muted 最勤奋的月份是 <b>{{ report.busiest.month.key }}</b>（{{ formatSec(report.busiest.month.sec) }}），主要在：
          template(v-for="(c, i) in report.busiest.month.cats.slice(0, 2)")
            span(v-if="i > 0") 、
            b {{ c.name }}

      // 全年热力图
      div.report-card
        div.card-title 🗓️ 全年热力图
        div.heat-months-row
          div.heat-month-label(v-for="ml in heatMonthLabels", :key="ml.idx", :style="{ left: `${ml.leftPct}%` }") {{ ml.label }}
        div.heat-grid
          div.heat-col(v-for="(col, ci) in heatColumns", :key="ci")
            div.heat-cell(
              v-for="cell in col",
              :key="cell.key",
              :class="[`heat-l${cell.level}`]",
              :title="cell.title"
            )

      // 星期 × 小时
      div.report-card
        div.card-title 🧮 星期 × 小时
        div.small.text-muted.mb-2
          | 每格 = 某个星期几的某个钟点，颜色越蓝表示越活跃（全年合计）。悬停可看具体时长。
        div.punch-grid
          div.punch-label
          template(v-for="h in 24", :key="`h${h}`")
            div.punch-hour-label(v-if="(h - 1) % 6 === 0") {{ String(h - 1).padStart(2, '0') }}
            div.punch-hour-label(v-else)
          template(v-for="(row, wd) in report.weekdayHour")
            div.punch-label.weekday(:key="`w${wd}`") {{ weekdayLabels[wd] }}
            div.punch-cell(
              v-for="(sec, h) in row",
              :key="`${wd}-${h}`",
              :style="{ background: punchColor(sec) }",
              :title="`${weekdayLabels[wd]} ${String(h).padStart(2, '0')}:00 · ${formatSec(sec)}`"
            )

      // 年度主角
      div.report-card(v-if="report.categories.length")
        div.card-title 🏆 年度主角
        div.cat-row(v-for="[name, sec] in report.categories", :key="name")
          div.d-flex.justify-content-between.small
            span.cat-name {{ name }}
            span.text-muted {{ formatSec(sec) }} · {{ shareOf(sec) }}%
          div.cat-track
            div.cat-fill(:style="{ width: `${shareOf(sec)}%` }")

      // 年度应用榜
      div.report-card(v-if="report.apps.length")
        div.card-title 📦 年度应用榜
        div.cat-row(v-for="[name, sec] in report.apps", :key="name")
          div.d-flex.justify-content-between.small
            span.cat-name {{ name }}
            span.text-muted {{ formatSec(sec) }} · {{ appShareOf(sec) }}%
          div.cat-track
            div.cat-fill.app-fill(:style="{ width: `${appShareOf(sec)}%` }")

      // 月度节奏
      div.report-card
        div.card-title 📅 月度节奏
        div.months-row
          div.month-col(v-for="m in stats.monthly", :key="m.month")
            div.month-bar-wrap
              div.month-bar(:style="{ height: `${monthBarHeight(m.sec)}%` }")
            div.small.text-muted.month-label {{ m.label }}
        div.small.text-muted.mt-2
          | 工作日日均 <b>{{ formatSec(stats.weekdayAvgSec) }}</b> ·
          | 周末日均 <b>{{ formatSec(stats.weekendAvgSec) }}</b>（{{ weekendVerdict }}）

      // 换算
      div.report-card.text-center
        div.card-title 🎬 换个说法
        div.small.text-muted
          | 你的 {{ yearNum }} 相当于 <b>{{ movieCount }}</b> 部两小时电影、
          | <b>{{ workdayCount }}</b> 个八小时工作日、
          | 或 <b>{{ bookCount }}</b> 本每小时 20 页的书。

      // AI 年度总结
      div.report-card
        div.d-flex.align-items-center.justify-content-between
          div.card-title.mb-0 🤖 AI 年度总结
          div
            b-button(size="sm", variant="primary", :disabled="aiLoading || !aiKey", @click="generateAi")
              b-spinner.mr-1(v-if="aiLoading", small)
              | {{ aiLoading ? '生成中…' : aiText ? '重新生成' : '生成总结' }}
        div.small.text-muted.mt-2(v-if="!aiKey")
          | 需要先在活动页的 AI Summary 卡片配置 API Key（共用同一份配置）。
        div.digest-line.mt-2(v-if="aiText") {{ aiText }}
        div.small.text-muted.mt-1(v-if="aiText && aiAt") 生成于 {{ aiAt }} · 数据发送给你配置的 LLM 端点
        b-alert.mt-2(v-if="aiError", variant="danger", show) {{ aiError }}

      div.report-footer
        | 数据完全来自你本机的 ActivityWatch，没有上传到任何服务器。
</template>

<style scoped lang="scss">
.annual-report {
  max-width: 720px;
  margin: 0 auto;
  padding: 1rem 0.5rem 3rem;
}

.report-card {
  background: var(--aw-card-bg, #fff);
  border-radius: 14px;
  padding: 1.5rem;
  margin-bottom: 1rem;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08);
}

// 全年热力图（GitHub 风格）
.heat-months-row {
  position: relative;
  height: 14px;
  margin-bottom: 2px;
}

.heat-month-label {
  position: absolute;
  font-size: 9px;
  color: var(--aw-vis-subtext, #6b7280);
  transform: translateX(-50%);
}

.heat-grid {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.heat-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.heat-cell {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--aw-vis-track, #edf1f6);
}

.heat-l1 {
  background: #d4e3f8;
}
.heat-l2 {
  background: #a9cbf1;
}
.heat-l3 {
  background: #5b8def;
}
.heat-l4 {
  background: #2b62b8;
}
.heat-l5 {
  background: #16386e;
}

// 星期 × 小时迷你格
.punch-grid {
  display: grid;
  grid-template-columns: 28px repeat(24, 1fr);
  gap: 2px;
  align-items: stretch;
}

.punch-label {
  font-size: 10px;
  color: var(--aw-vis-subtext, #6b7280);
  display: flex;
  align-items: center;
}

.punch-hour-label {
  font-size: 8px;
  color: var(--aw-vis-subtext, #6b7280);
  text-align: center;
}

.punch-cell {
  height: 13px;
  border-radius: 2px;
}

.digest-line {
  font-size: 0.92rem;
  line-height: 1.65;
  color: var(--aw-vis-text, #3c4257);
  white-space: pre-wrap;
}

.card-title {
  font-weight: 600;
  font-size: 0.95rem;
  margin-bottom: 0.75rem;
  color: var(--aw-vis-text, #3c4257);
}

.hero {
  text-align: center;
  padding: 2.5rem 1.5rem;
}

.hero-number {
  font-size: 3.4rem;
  font-weight: 700;
  line-height: 1.1;
  color: var(--aw-vis-text, #3c4257);
}

.hero-unit {
  color: var(--aw-vis-subtext, #6b7280);
}

.big-line {
  font-size: 1.6rem;
  font-weight: 600;
}

.big-line-sm {
  font-size: 1.25rem;
  font-weight: 600;
}

// 时段占比条
.daypart-bar {
  display: flex;
  height: 14px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--aw-vis-track, #edf1f6);
}

.daypart-seg {
  height: 100%;

  &.part-morning {
    background: #f0b429;
  }

  &.part-night {
    background: #7c6fd0;
  }

  &.part-evening {
    background: #2b62b8;
  }

  // 午后为默认蓝
  &:not(.part-morning):not(.part-night):not(.part-evening) {
    background: #5b8def;
  }
}

// 24 小时强度色带
.ripple-row {
  display: flex;
  gap: 2px;
  margin-top: 4px;
}

.ripple-cell {
  flex: 1;
  height: 26px;
  border-radius: 3px;
  background: var(--aw-vis-track, #edf1f6);
  position: relative;

  &.ripple-peak::after {
    content: '▲';
    position: absolute;
    top: -13px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 9px;
    color: #16386e;
  }
}

.ripple-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--aw-vis-subtext, #6b7280);
  margin-top: 3px;
}

// 跨年对比
.delta-up {
  color: #1e7f4f;
  font-size: 12px;
}

.delta-down {
  color: #b3423a;
  font-size: 12px;
}

.cmp-months-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 110px;
  margin-top: 6px;
}

.cmp-month-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.cmp-bars {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
}

.cmp-bar {
  width: 34%;
  max-width: 14px;
  border-radius: 3px 3px 0 0;
  min-height: 2px;

  &.cur {
    background: #2b62b8;
  }

  &.prev {
    background: #c3cad6;
  }
}

.cmp-cat-row {
  display: flex;
  justify-content: space-between;
  padding: 2px 0;
  border-bottom: 1px dashed var(--aw-vis-track, #edf1f6);
}

.cmp-cat-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 72%;
}

.cat-row {
  margin-bottom: 0.6rem;
}

.cat-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.cat-track {
  height: 8px;
  border-radius: 4px;
  background: var(--aw-vis-track, #edf1f6);
  overflow: hidden;
}

.cat-fill {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #5b8def, #2b62b8);

  &.app-fill {
    background: linear-gradient(90deg, #f0b429, #e08e0b);
  }
}

.months-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 120px;
}

.month-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}

.month-bar-wrap {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.month-bar {
  width: 70%;
  max-width: 26px;
  border-radius: 4px 4px 0 0;
  background: linear-gradient(180deg, #5b8def, #a9cbf1);
  min-height: 2px;
}

.month-label {
  margin-top: 4px;
  font-size: 10px;
}

.report-footer {
  text-align: center;
  font-size: 12px;
  color: var(--aw-vis-subtext, #6b7280);
  margin-top: 1.5rem;
}
</style>

<script lang="ts">
import moment from 'moment';
import _ from 'lodash';

import {
  getYearReport,
  getYearReportLite,
  computeStats,
  YearReport,
  YearReportStats,
} from '~/util/annualReport';
import { seconds_to_duration } from '~/util/time';
import { loadLLMConfig, callLLM } from '~/util/aiSummary';

const AI_CACHE_PREFIX = 'aw-annual-report-ai-';

export default {
  name: 'AnnualReport',
  props: {
    year: { type: String, default: '' },
  },
  data() {
    const saved = loadLLMConfig();
    return {
      report: null as YearReport | null,
      stats: null as YearReportStats | null,
      prevReport: null as YearReport | null,
      prevStats: null as YearReportStats | null,
      prevLoading: false,
      loading: false,
      error: '',
      currentYear: moment().year(),
      firstKnownYear: 2020,
      weekdayLabels: ['一', '二', '三', '四', '五', '六', '日'],
      aiKey: !!saved.apiKey,
      aiLoading: false,
      aiError: '',
      aiText: '',
      aiAt: '',
    };
  },
  computed: {
    yearNum(): number {
      const n = parseInt(this.year, 10);
      return Number.isFinite(n) && n > 1999 && n < 3000 ? n : moment().year();
    },
    totalHours(): string {
      return this.stats ? (this.stats.totalSec / 3600).toFixed(1) : '0';
    },
    avgHours(): string {
      return this.stats ? this.stats.avgHoursPerActiveDay.toFixed(1) : '0';
    },
    busiestShare(): string {
      if (!this.stats || !this.stats.busiestDay || !this.stats.totalSec) return '0';
      return ((this.stats.busiestDay.sec / this.stats.totalSec) * 100).toFixed(1);
    },
    cachedAt(): string {
      return this.report ? moment(this.report.computedAt).format('MM-DD HH:mm') : '';
    },
    weekendVerdict(): string {
      if (!this.stats) return '';
      const w = this.stats.weekendAvgSec;
      const d = this.stats.weekdayAvgSec;
      if (!d || !w) return '样本不足';
      const ratio = w / d;
      if (ratio > 1.2) return '周末比工作日更拼';
      if (ratio < 0.6) return '周末基本休息';
      return '工作日与周末节奏接近';
    },
    halfYearVerdict(): string {
      if (!this.stats) return '';
      const { first, second } = this.stats.halfYear;
      if (!first && !second) return '样本不足';
      if (!first) return '全部集中在下半场';
      const ratio = second / first;
      if (ratio > 1.3) return '下半场明显提速';
      if (ratio < 0.75) return '下半场放缓';
      return '上下半场势均力敌';
    },
    daypartTopName(): string {
      const label = this.stats?.chronotype.label || '';
      if (label.includes('夜猫子')) return '凌晨时段';
      if (label.includes('早起鸟')) return '上午时段';
      if (label.includes('晚间')) return '晚间时段';
      return '午后时段';
    },
    prevAvgHours(): string {
      return this.prevStats ? this.prevStats.avgHoursPerActiveDay.toFixed(1) : '0';
    },
    cmp(): {
      totalPct: number;
      daysPct: number;
      avgPct: number;
      monthly: { label: string; hA: number; hB: number; title: string }[];
      catShifts: { name: string; deltaHours: number }[];
      verdict: string;
    } {
      const empty = {
        totalPct: 0,
        daysPct: 0,
        avgPct: 0,
        monthly: [],
        catShifts: [],
        verdict: '',
      };
      if (!this.stats || !this.prevStats || !this.prevStats.totalSec) return empty;
      const s = this.stats;
      const p = this.prevStats;
      const pctDelta = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);
      const h = (sec: number) => sec / 3600;

      const maxMonth = Math.max(...s.monthly.map(m => m.sec), ...p.monthly.map(m => m.sec), 1);
      const monthly = s.monthly.map((m, i) => ({
        label: m.label,
        hA: Math.max((m.sec / maxMonth) * 100, m.sec > 0 ? 2 : 0),
        hB: Math.max((p.monthly[i].sec / maxMonth) * 100, p.monthly[i].sec > 0 ? 2 : 0),
        title: `${m.label}：${this.yearNum} ${h(m.sec).toFixed(1)}h vs ${this.yearNum - 1} ${h(
          p.monthly[i].sec
        ).toFixed(1)}h`,
      }));

      // Category shifts over the union of both years' top-5.
      const curMap: Map<string, number> = new Map(this.report?.categories.slice(0, 5) || []);
      const prevMap: Map<string, number> = new Map(this.prevReport?.categories.slice(0, 5) || []);
      const names: string[] = [...new Set([...curMap.keys(), ...prevMap.keys()])];
      const catShifts = names
        .map(name => ({
          name,
          deltaHours: Math.round(h(curMap.get(name) || 0) - h(prevMap.get(name) || 0)),
        }))
        .sort((a, b) => Math.abs(b.deltaHours) - Math.abs(a.deltaHours))
        .filter(c => Math.abs(c.deltaHours) >= 1)
        .slice(0, 4);

      const totalDeltaH = Math.round(h(s.totalSec) - h(p.totalSec));
      const totalPct = pctDelta(s.totalSec, p.totalSec);
      const upDown = totalDeltaH >= 0 ? '多' : '少';
      const shiftsTxt = catShifts
        .slice(0, 2)
        .map(c => `${c.name}${c.deltaHours >= 0 ? '增加' : '减少'} ${Math.abs(c.deltaHours)} 小时`)
        .join('，');
      const verdict = `比去年${upDown}活跃 ${Math.abs(totalDeltaH)} 小时（${
        totalDeltaH >= 0 ? '+' : ''
      }${totalPct.toFixed(0)}%）${shiftsTxt ? '；' + shiftsTxt : ''}。`;

      return {
        totalPct,
        daysPct: pctDelta(s.activeDays, p.activeDays),
        avgPct: pctDelta(s.avgHoursPerActiveDay, p.avgHoursPerActiveDay),
        monthly,
        catShifts,
        verdict,
      };
    },
    cmpTotalHours(): string {
      if (!this.stats || !this.prevStats) return '0';
      const cur = (this.stats.totalSec / 3600).toFixed(0);
      const prev = (this.prevStats.totalSec / 3600).toFixed(0);
      return `${cur}h vs ${prev}h`;
    },
    movieCount(): number {
      return this.stats ? Math.round(this.stats.totalSec / 3600 / 2) : 0;
    },
    workdayCount(): number {
      return this.stats ? Math.round(this.stats.totalSec / 3600 / 8) : 0;
    },
    bookCount(): number {
      // 300-page book at 20 pages/hour ≈ 15h
      return this.stats ? Math.round(this.stats.totalSec / 3600 / 15) : 0;
    },
    /** GitHub-style columns: weeks (Mon-start) × 7 days. */
    heatColumns(): { key: string; level: number; title: string }[][] {
      if (!this.report) return [];
      const byDate: Record<string, number> = this.report.byDate;
      const values = Object.values(byDate);
      const max = Math.max(...values, 1);
      const yearStart = moment({ year: this.yearNum, month: 0, date: 1 });
      const gridStart = yearStart.clone().startOf('isoWeek');
      const now = moment();
      const yearEnd =
        this.yearNum === now.year()
          ? now.clone().startOf('day')
          : moment({ year: this.yearNum + 1, month: 0, date: 1 }).subtract(1, 'day');
      const cols: { key: string; level: number; title: string }[][] = [];
      for (let w = gridStart.clone(); w.isSameOrBefore(yearEnd); w.add(1, 'week')) {
        const col: { key: string; level: number; title: string }[] = [];
        for (let d = 0; d < 7; d++) {
          const day = w.clone().add(d, 'days');
          const key = day.format('YYYY-MM-DD');
          if (day.year() !== this.yearNum) {
            col.push({ key, level: -1, title: '' }); // outside year → invisible
            continue;
          }
          const sec = byDate[key] || 0;
          const level = sec < 60 ? 0 : Math.min(5, 1 + Math.floor((sec / max) * 4.999));
          col.push({
            key,
            level,
            title: `${key} · ${sec >= 60 ? this.formatSec(sec) : '无活动'}`,
          });
        }
        cols.push(col);
      }
      return cols;
    },
    heatMonthLabels(): { idx: number; label: string; leftPct: number }[] {
      const total = Math.max(this.heatColumns.length, 1);
      const labels: { idx: number; label: string; leftPct: number }[] = [];
      let lastMonth = -1;
      this.heatColumns.forEach((col, ci) => {
        const first = col.find(c => c.level >= 0);
        if (!first) return;
        const m = moment(first.key).month();
        if (m !== lastMonth) {
          labels.push({
            idx: ci,
            label: moment(first.key).format('MMM'),
            leftPct: ((ci + 0.5) / total) * 100,
          });
          lastMonth = m;
        }
      });
      return labels;
    },
  },
  watch: {
    yearNum() {
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    formatSec(sec: number): string {
      const m = seconds_to_duration(sec).match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
      return m ? m[0].trim() || '<1m' : '<1m';
    },
    shareOf(sec: number): string {
      if (!this.report || !this.stats || !this.stats.totalSec) return '0';
      const topCat = this.report.categories[0]?.[1] || 1;
      return ((sec / topCat) * 100).toFixed(0);
    },
    appShareOf(sec: number): string {
      if (!this.report) return '0';
      const topApp = this.report.apps[0]?.[1] || 1;
      return ((sec / topApp) * 100).toFixed(0);
    },
    monthBarHeight(sec: number): number {
      const monthly: { month: number; label: string; sec: number }[] = this.stats?.monthly || [];
      const maxMonth = _.maxBy(monthly, m => m.sec);
      const max = maxMonth ? maxMonth.sec : 1;
      return max > 0 ? Math.max((sec / max) * 100, sec > 0 ? 2 : 0) : 0;
    },
    hourBarHeight(sec: number): number {
      const hours: number[] = this.report?.hourly || [];
      const max = Math.max(...hours, 1);
      return Math.max((sec / max) * 100, sec > 0 ? 2 : 0);
    },
    pct(sec: number): string {
      const parts = this.stats?.chronotype.dayparts;
      const total = parts ? parts.morning + parts.afternoon + parts.evening + parts.night : 0;
      return total > 0 ? ((sec / total) * 100).toFixed(0) : '0';
    },
    rippleColor(sec: number): string {
      const hours: number[] = this.report?.hourly || [];
      const max = Math.max(...hours, 1);
      if (sec <= 0) return 'var(--aw-vis-track, #edf1f6)';
      const t = Math.sqrt(sec / max);
      const alpha = 0.2 + t * 0.8;
      return `rgba(43, 98, 184, ${alpha.toFixed(2)})`;
    },
    fmtHour(h: number): string {
      return `${String(h).padStart(2, '0')}:00`;
    },
    deltaClass(pctDelta: number): string {
      return pctDelta >= 0 ? 'delta-up' : 'delta-down';
    },
    deltaText(pctDelta: number): string {
      return `${pctDelta >= 0 ? '+' : ''}${pctDelta.toFixed(0)}%`;
    },
    async loadCompare() {
      if (this.yearNum <= this.firstKnownYear) return;
      this.prevLoading = true;
      this.prevReport = null;
      this.prevStats = null;
      try {
        this.prevReport = await getYearReportLite(this.yearNum - 1);
        this.prevStats = computeStats(this.prevReport);
      } catch (e) {
        console.warn('annual report compare failed:', e);
      }
      this.prevLoading = false;
    },
    fmtHM(t: { hour: number; minute: number }): string {
      return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    },
    punchColor(sec: number): string {
      const grid: number[][] = this.report?.weekdayHour || [];
      const max = Math.max(1, ...grid.map(r => Math.max(...r, 0)));
      if (sec <= 0) return 'var(--aw-vis-track, #edf1f6)';
      const t = Math.sqrt(sec / max);
      const alpha = 0.15 + t * 0.85;
      return `rgba(43, 98, 184, ${alpha.toFixed(2)})`;
    },
    async generateAi() {
      if (!this.report || !this.stats) return;
      this.aiLoading = true;
      this.aiError = '';
      try {
        // Wait for the cross-year comparison data if it is still loading,
        // so the AI summary can include year-over-year context.
        for (let i = 0; this.prevLoading && i < 30; i++) {
          await new Promise(res => setTimeout(res, 500));
        }
        const config = loadLLMConfig() as any;
        if (!config.apiKey) throw new Error('未配置 API Key');
        const r = this.report;
        const s = this.stats;
        const monthsLine = s.monthly.map(m => `${m.label} ${Math.round(m.sec / 3600)}h`).join(', ');
        const catLine = r.categories.map(([n, v]) => `${n} ${Math.round(v / 3600)}h`).join(', ');
        const appLine = r.apps.map(([n, v]) => `${n} ${Math.round(v / 3600)}h`).join(', ');
        const busiestDay = r.busiest.day
          ? `最勤奋一天 ${r.busiest.day.key}（${Math.round(
              r.busiest.day.sec / 3600
            )}h，主要：${r.busiest.day.cats.map(c => c.name).join('、')}）`
          : '';
        const busiestMonth = r.busiest.month
          ? `最勤奋月份 ${r.busiest.month.key}（主要：${r.busiest.month.cats
              .map(c => c.name)
              .join('、')}）`
          : '';
        const boot = r.boot.firstBoot
          ? `最早开始工作约 ${this.fmtHM(r.boot.firstBoot)}，最晚收工约 ${
              r.boot.lastShutdown?.pastMidnight ? '次日 ' : ''
            }${this.fmtHM(r.boot.lastShutdown as { hour: number; minute: number })}，${
              r.boot.lateNightPct
            }% 的活跃日持续过零点（一天按 04:00–次日 04:00 计）`
          : '';
        // Cross-year comparison block (only when last year has data).
        let cmpLine = '';
        if (this.prevStats && this.prevStats.totalSec > 0) {
          const ps = this.prevStats;
          const dTotal = Math.round((s.totalSec - ps.totalSec) / 3600);
          const pTotal =
            ps.totalSec > 0 ? (((s.totalSec - ps.totalSec) / ps.totalSec) * 100).toFixed(0) : '0';
          const shifts = this.cmp.catShifts
            .slice(0, 3)
            .map(c => `${c.name}${c.deltaHours >= 0 ? '+' : ''}${c.deltaHours}h`)
            .join('，');
          cmpLine = [
            `与${this.yearNum - 1}年对比：去年总活跃 ${Math.round(ps.totalSec / 3600)} 小时 / ${
              ps.activeDays
            } 天 / 日均 ${ps.avgHoursPerActiveDay.toFixed(1)} 小时；`,
            `今年总时长${dTotal >= 0 ? '增加' : '减少'} ${Math.abs(dTotal)} 小时（${
              dTotal >= 0 ? '+' : ''
            }${pTotal}%），天数${this.cmp.daysPct >= 0 ? '增' : '减'} ${Math.abs(
              this.cmp.daysPct
            ).toFixed(0)}%，日均${this.cmp.avgPct >= 0 ? '升' : '降'} ${Math.abs(
              this.cmp.avgPct
            ).toFixed(0)}%。`,
            shifts ? `分类变化：${shifts}。` : '',
          ]
            .filter(Boolean)
            .join('');
        }
        const data = [
          `${this.yearNum} 年度活动统计：`,
          `总活跃 ${Math.round(s.totalSec / 3600)} 小时，覆盖 ${
            s.activeDays
          } 天，日均 ${s.avgHoursPerActiveDay.toFixed(1)} 小时。`,
          `作息类型：${s.chronotype.label}，高峰 ${this.fmtHour(
            s.chronotype.peakHour
          )} 前后。${boot}`,
          `分类：${catLine}。`,
          `应用：${appLine}。`,
          `月度活跃（小时）：${monthsLine}。`,
          `工作日日均 ${Math.round(s.weekdayAvgSec / 3600)}h，周末日均 ${Math.round(
            s.weekendAvgSec / 3600
          )}h。`,
          `最长连续活跃 ${s.longestStreak?.days ?? 0} 天。${busiestDay}${busiestMonth}`,
          cmpLine,
        ]
          .filter(Boolean)
          .join('\n');
        const prompt = [
          '你是个人时间报告的年度回顾撰稿人。根据下面的年度统计数据，用中文写一段 150-250 字的年度回顾：',
          '概括这一年的主线（主要投入在什么上）、节奏特征（作息、工作日/周末、上下半年）、一个具体的亮点或转变，结尾一句展望。',
          '如包含与去年的对比数据，请把同比变化自然地融入叙事（如"比去年更投入/某类活动明显减少"），但不要罗列全部百分比。',
          '所有陈述必须有数据支撑，不得虚构；不要罗列全部数字，挑有故事的讲；不要分节标题，输出一段连贯文字。',
          '',
          data,
        ].join('\n');
        const text = (await callLLM(config, prompt)).trim();
        if (!text) throw new Error('LLM 返回为空');
        this.aiText = text;
        this.aiAt = moment().format('MM-DD HH:mm');
        try {
          localStorage.setItem(
            `${AI_CACHE_PREFIX}${this.yearNum}`,
            JSON.stringify({ text, at: Date.now() })
          );
        } catch {
          /* ignore */
        }
      } catch (e) {
        this.aiError = (e as Error).message || String(e);
      }
      this.aiLoading = false;
    },
    async load(force = false) {
      this.loading = true;
      this.error = '';
      this.aiText = '';
      this.aiAt = '';
      this.aiError = '';
      this.aiKey = !!loadLLMConfig().apiKey;
      try {
        this.report = await getYearReport(this.yearNum, force);
        this.stats = computeStats(this.report);
        try {
          const cachedAi = JSON.parse(
            localStorage.getItem(`${AI_CACHE_PREFIX}${this.yearNum}`) || 'null'
          );
          if (cachedAi && cachedAi.text) {
            this.aiText = cachedAi.text;
            this.aiAt = moment(cachedAi.at).format('MM-DD HH:mm');
          }
        } catch {
          /* ignore */
        }
      } catch (e) {
        this.error = (e as Error).message || String(e);
      }
      this.loading = false;
      this.loadCompare();
    },
  },
};
</script>
