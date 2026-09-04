<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="height + 4")
  div.small.text-muted(v-if="days > 0")
    | Avg active minutes per hour · {{ days }} days ending {{ endLabel }}, by weekday ({{ weekdayLabels[startOfWeek] }}-start)
  div.small.text-muted(v-else-if="loaded") No activity data for the past 60 days.
  div.small.text-muted(v-else) Loading…
</template>

<style scoped lang="scss">
svg.vis-svg {
  display: block;
}

:deep(.punch-cell) {
  transition: opacity 0.1s ease;
  cursor: pointer;

  &:hover {
    opacity: 0.75;
  }
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';

import { seconds_to_duration } from '~/util/time';
import { getDailyHourlyActivity } from '~/util/hourlyMatrix';
import { useActivityStore } from '~/stores/activity';

const height = 168;
const WINDOW_DAYS = 60;

const CELL_COLORS = ['#EEF3FB', '#D4E3F8', '#A9CBF1', '#75A8E6', '#4585DB', '#2B62B8', '#1D4890'];

// Same data source as the Timeline barchart (canonical window ∩ not-afk),
// averaged per weekday over the trailing window. Independent of the
// selected date.
export default {
  name: 'aw-punchcard',
  props: {
    startOfWeek: { type: Number, default: 1 }, // 1 = Monday
  },
  data() {
    return {
      activityStore: useActivityStore(),
      days: 0,
      loaded: false,
      endLabel: '',
      weekdayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    };
  },
  watch: {
    // Follow the browsed date: the window is the 60 days ending at it.
    'activityStore.query_options.timeperiod': function () {
      this.load();
    },
  },
  async mounted() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        const end = this.selectedDate();
        this.endLabel = `${String(end.getMonth() + 1).padStart(2, '0')}/${String(
          end.getDate()
        ).padStart(2, '0')}`;
        const { days, matrix } = await getDailyHourlyActivity(WINDOW_DAYS, end);
        this.days = days.length;
        if (days.length > 0) {
          this.$nextTick(() => this.render(days, matrix));
        }
      } catch (e) {
        console.error('aw-punchcard failed:', e);
      }
      this.loaded = true;
    },
    selectedDate(): Date {
      const qo = useActivityStore().query_options;
      const d = qo ? new Date(qo.timeperiod.start) : new Date();
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    },
    render(dayKeys: string[], matrix: number[][]) {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';

      // minutes[weekday][hour], and per-weekday day counts for averaging.
      const minutes: number[][] = _.range(7).map(() => new Array(24).fill(0));
      const dowDays = new Array(7).fill(0);
      dayKeys.forEach((key, i) => {
        const d = new Date(key + 'T12:00:00');
        const dow = (d.getDay() - this.startOfWeek + 7) % 7;
        dowDays[dow] += 1;
        matrix[i].forEach((m, h) => (minutes[dow][h] += m));
      });
      const cells = minutes.map((row, dow) => {
        const n = dowDays[dow] || 1;
        return row.map(v => (v / n >= 10 ? v / n : 0));
      });

      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const margin = { top: 4, right: 6, bottom: 18, left: 34 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const cw = iw / 24;
      const ch = ih / 7;

      const active = cells
        .flat()
        .filter(v => v > 0)
        .sort(d3.ascending);
      const thresholds = [0.25, 0.5, 0.75, 0.9]
        .map(q => d3.quantile(active, q) as number)
        .filter((v, i, arr) => v > 0 && (i === 0 || v > arr[i - 1]));
      const color = d3
        .scaleThreshold<number, string>()
        .domain(thresholds)
        .range(CELL_COLORS.slice(0, thresholds.length + 1));
      const zeroFill = 'var(--aw-vis-track, #EDF1F6)';

      const weekdayOrder = _.range(7).map(i => (i + this.startOfWeek) % 7);
      weekdayOrder.forEach((dayIdx, row) => {
        svg
          .append('text')
          .attr('x', margin.left - 6)
          .attr('y', margin.top + row * ch + ch / 2 + 3.5)
          .attr('text-anchor', 'end')
          .attr('font-size', 10)
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text(this.weekdayLabels[dayIdx]);

        _.range(24).forEach(hour => {
          const v = cells[dayIdx][hour];
          const rect = g
            .append('rect')
            .attr('class', 'punch-cell')
            .attr('x', hour * cw + 1)
            .attr('y', row * ch + 1)
            .attr('width', cw - 2)
            .attr('height', ch - 2)
            .attr('rx', 2.5)
            .attr('fill', v > 0 ? color(v) : zeroFill);
          rect
            .append('title')
            .text(
              `${this.weekdayLabels[dayIdx]} ${String(hour).padStart(2, '0')}:00 · avg ` +
                (v > 0 ? seconds_to_duration(v * 60) : 'no activity')
            );
        });
      });

      [0, 3, 6, 9, 12, 15, 18, 21, 23].forEach(h => {
        svg
          .append('text')
          .attr('x', margin.left + h * cw + cw / 2)
          .attr('y', height - 5)
          .attr('text-anchor', 'middle')
          .attr('font-size', 9.5)
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text(h);
      });
    },
  },
};
</script>
