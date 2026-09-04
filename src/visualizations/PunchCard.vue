<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="height + 4")
  div.small.text-muted(v-if="days > 0")
    | Avg active minutes per hour · {{ days }} days ({{ weekdayLabels[startOfWeek] }}-start weeks)
  div.small.text-muted(v-else) No activity history for this period yet.
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

import { IEvent } from '~/util/interfaces';
import { seconds_to_duration } from '~/util/time';
import { clipEventToHours } from '~/util/hourclip';

const height = 168;

// Sequential blue ramp; ranks over active cells so daily peaks stand out
// against the mostly-quiet grid (same trick as the year heatmap).
const CELL_COLORS = ['#EEF3FB', '#D4E3F8', '#A9CBF1', '#75A8E6', '#4585DB', '#2B62B8', '#1D4890'];

export default {
  name: 'aw-punchcard',
  props: {
    history: { type: Object, default: null }, // Record<period_str, IEvent[]>
    startOfWeek: { type: Number, default: 1 }, // 1 = Monday
  },
  data() {
    return { days: 0, weekdayLabels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };
  },
  computed: {
    // 7 (weekdays, week-start aligned) x 24 (hours) average active minutes.
    grid(): { cells: number[][]; max: number; days: number } | null {
      if (!this.history) return null;
      const minutes: number[][] = _.range(7).map(() => new Array(24).fill(0));
      // Per-weekday day counts: a Monday 10:00 cell must be averaged over
      // the number of Mondays in the history, not over all days (else every
      // cell shrinks ~7x and drowns under the noise threshold).
      const dowDays = new Array(7).fill(0);
      const seenDates = new Set<string>();
      _.each(this.history as Record<string, IEvent[]>, events => {
        _.each(events || [], e => {
          clipEventToHours(e.timestamp, e.duration || 0, slice => {
            const key = slice.date.toDateString();
            if (!seenDates.has(key)) {
              seenDates.add(key);
              dowDays[(slice.date.getDay() - this.startOfWeek + 7) % 7] += 1;
            }
            const dow = (slice.date.getDay() - this.startOfWeek + 7) % 7;
            minutes[dow][slice.hour] += slice.seconds / 60;
          });
        });
      });
      const nDays = seenDates.size;
      if (nDays === 0) return null;
      const cells = minutes.map((row, dow) => {
        const n = dowDays[dow] || 1;
        return row.map(v => (v / n >= 5 ? v / n : 0));
      });
      return { cells, max: d3.max(cells.flat()) as number, days: nDays };
    },
  },
  watch: {
    history() {
      this.render();
    },
  },
  mounted() {
    this.render();
  },
  methods: {
    render() {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';
      const grid = this.grid;
      this.days = grid ? grid.days : 0;
      if (!grid) return;

      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const margin = { top: 4, right: 6, bottom: 18, left: 34 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const cw = iw / 24;
      const ch = ih / 7;

      // Quantile thresholds among nonzero cells for an even color spread.
      const active = grid.cells
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
        // Row label
        svg
          .append('text')
          .attr('x', margin.left - 6)
          .attr('y', margin.top + row * ch + ch / 2 + 3.5)
          .attr('text-anchor', 'end')
          .attr('font-size', 10)
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text(this.weekdayLabels[dayIdx]);

        _.range(24).forEach(hour => {
          const v = grid.cells[dayIdx][hour];
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

      // Hour axis: label every 3rd hour, thin gridline ticks.
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
