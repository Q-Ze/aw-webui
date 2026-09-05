<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="height + 4")
  div.small.text-muted(v-if="days > 0")
    | {{ caption }}
  div.small.text-muted(v-else-if="loaded") No activity data for this range.
  div.small.text-muted(v-else) Loading…
</template>

<style scoped lang="scss">
svg.vis-svg {
  display: block;
}

:deep(.punch-cell) {
  cursor: pointer;

  &:hover {
    stroke: var(--aw-vis-subtext, #6b7280);
    stroke-width: 1.2;
  }
}

:deep(.punch-cell--future) {
  opacity: 0.35;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';
import moment from 'moment';

import { seconds_to_duration } from '~/util/time';
import {
  getDailyHourlyActivityByDays,
  getDailyHourlyActivityForTimeperiod,
} from '~/util/hourlyMatrix';
import { TimePeriod } from '~/util/timeperiod';

const height = 176;

interface Row {
  label: string;
  hours: number[];
  future: boolean;
}

// Day (single week) and week views show the containing week's seven real days,
// one row each; future days are dimmed and empty. Longer ranges keep the
// classic per-weekday average.
export default {
  name: 'aw-punchcard',
  props: {
    timeperiodStart: { type: String, default: null },
    timeperiodLength: { type: Array, default: () => [1, 'day'] },
    weekStart: { type: String, default: 'Monday' },
  },
  data() {
    return {
      loaded: false,
      days: 0,
      loadToken: 0,
      caption: '',
      weekdayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    };
  },
  computed: {
    isWeekView(): boolean {
      const unit = this.timeperiodLength[1] as string;
      return unit.startsWith('day') || unit.startsWith('week');
    },
  },
  watch: {
    timeperiodStart() {
      this.load();
    },
    timeperiodLength() {
      this.load();
    },
  },
  async mounted() {
    await this.load();
  },
  methods: {
    weekStartIndex(): number {
      if (this.weekStart === 'Monday') return 1;
      if (this.weekStart === 'Saturday') return 6;
      return 0;
    },
    weekDayKeys(): string[] {
      const ws = this.weekStartIndex();
      const selected = moment(this.timeperiodStart || undefined);
      const start = selected.clone().startOf(ws === 1 ? 'isoWeek' : 'week');
      if (ws === 6) start.subtract(1, 'day');
      return _.range(7).map(i => start.clone().add(i, 'days').format('YYYY-MM-DD'));
    },
    async load() {
      const token = ++this.loadToken;
      try {
        let rows: Row[];
        if (this.isWeekView) {
          const keys = this.weekDayKeys();
          const perDay = await getDailyHourlyActivityByDays(keys);
          if (token !== this.loadToken) return;
          const ws = this.weekStartIndex();
          const todayKey = moment().format('YYYY-MM-DD');
          rows = keys.map((key, i) => ({
            label: this.weekdayLabels[(ws + i) % 7],
            hours: perDay[key] || new Array(24).fill(0),
            future: key > todayKey,
          }));
          const fmt = (k: string) => moment(k).format('MM/DD');
          this.caption = `This week (${fmt(keys[0])} – ${fmt(
            keys[6]
          )}) · minutes per weekday × hour`;
        } else {
          const period: TimePeriod = {
            start: this.timeperiodStart || new Date().toISOString(),
            length: this.timeperiodLength,
          };
          const { days, matrix } = await getDailyHourlyActivityForTimeperiod(period);
          if (token !== this.loadToken) return;
          const ws = this.weekStartIndex();
          const minutes: number[][] = _.range(7).map(() => new Array(24).fill(0));
          const dowDays = new Array(7).fill(0);
          days.forEach((key, i) => {
            const dow = (moment(key + 'T12:00:00').day() - ws + 7) % 7;
            dowDays[dow] += 1;
            matrix[i].forEach((m, h) => (minutes[dow][h] += m));
          });
          rows = _.range(7).map(i => {
            const dow = (ws + i) % 7;
            const n = dowDays[dow] || 1;
            return {
              label: this.weekdayLabels[dow],
              hours: minutes[dow].map(v => v / n),
              future: false,
            };
          });
          const count = days.length;
          this.caption = `Average per weekday × hour · ${count} calendar day${
            count === 1 ? '' : 's'
          } · ${moment(days[count - 1]).format('MM/DD')}`;
        }
        this.days = this.isWeekView ? 7 : rows.length;
        if (token === this.loadToken) this.$nextTick(() => this.render(rows));
      } catch (e) {
        console.error('aw-punchcard failed:', e);
      }
      if (token === this.loadToken) this.loaded = true;
    },
    render(rows: Row[]) {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';

      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const margin = { top: 4, right: 6, bottom: 18, left: 34 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const cw = iw / 24;
      const ch = ih / 7;

      // Continuous sqrt-ramp scale so short sessions (10–20 min) are clearly
      // visible instead of collapsing into the track color.
      const maxVal = Math.max(90, ...rows.map(r => Math.max(...r.hours)));
      const color = d3
        .scaleSequential(t =>
          d3.interpolateRgbBasis(['#E8F0FE', '#A9CBF1', '#5B8DEF', '#2B62B8', '#16386E'])(t)
        )
        .domain([0, 1]);
      const ramp = (v: number) => color(Math.sqrt(Math.max(v, 0) / maxVal));
      const zeroFill = 'var(--aw-vis-track, #EDF1F6)';

      rows.forEach((row, r) => {
        svg
          .append('text')
          .attr('x', margin.left - 6)
          .attr('y', margin.top + r * ch + ch / 2 + 3.5)
          .attr('text-anchor', 'end')
          .attr('font-size', 10)
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text(row.label);

        _.range(24).forEach(hour => {
          const v = row.hours[hour];
          const rect = g
            .append('rect')
            .attr('class', `punch-cell${row.future ? ' punch-cell--future' : ''}`)
            .attr('x', hour * cw + 1)
            .attr('y', r * ch + 1)
            .attr('width', cw - 2)
            .attr('height', ch - 2)
            .attr('rx', 2.5)
            .attr('fill', v > 0 ? ramp(v) : zeroFill);
          rect
            .append('title')
            .text(
              `${row.label} ${String(hour).padStart(2, '0')}:00 · ` +
                (v > 0 ? seconds_to_duration(v * 60) : row.future ? 'not yet' : 'no activity')
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
