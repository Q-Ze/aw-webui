<template lang="pug">
div.timespiral-wrap(ref="wrap")
  svg(ref="svg", :width="size", :height="size", style="display: block; margin: 0 auto; max-width: 100%;")
</template>

<style scoped lang="scss">
.timespiral-wrap {
  position: relative;
}

:deep(.spiral-arc) {
  cursor: pointer;
  transition: opacity 0.1s ease;

  &:hover {
    opacity: 0.7;
  }
}
</style>

<script lang="ts">
// A rewritten "time spiral": one full turn = one 24h day, most recent day on
// the innermost ring, spiraling outward into the past. Arcs are hour×category
// activity, colored by category. Multidevice-aware via the shared window
// analysis query.
import * as d3 from 'd3';
import _ from 'lodash';

import { IEvent } from '~/util/interfaces';
import { getCategoryColorFromString } from '~/util/color';
import { seconds_to_duration } from '~/util/time';
import { clipEventToHours, dateKey, daysBetween, startOfToday } from '~/util/hourclip';

interface Segment {
  dayIndex: number; // 0 = most recent day
  dayKey: string;
  hour: number;
  category: string;
  seconds: number;
}

export default {
  name: 'aw-timespiral',
  props: {
    events: { type: Array, default: () => [] },
    days: { type: Number, default: 14 },
  },
  data() {
    return {
      size: 560,
      renderFrame: null,
      resizeObserver: null,
    };
  },
  computed: {
    segments(): Segment[] {
      const byCell: Record<string, Segment> = {};
      const today = startOfToday();
      for (const e of this.events as IEvent[]) {
        if (!e.data || !e.data['$category']) continue;
        const cat = (e.data['$category'] as string[]).join(' > ');
        clipEventToHours(e.timestamp, e.duration, slice => {
          if (slice.seconds < 30) return; // noise: sub-30s slivers add clutter, not signal
          const dayIndex = daysBetween(slice.date, today);
          if (dayIndex < 0 || dayIndex >= this.days) return;
          const key = `${dateKey(slice.date)}|${slice.hour}|${cat}`;
          byCell[key] = byCell[key] || {
            dayIndex,
            dayKey: dateKey(slice.date),
            hour: slice.hour,
            category: cat,
            seconds: 0,
          };
          byCell[key].seconds += slice.seconds;
        });
      }
      return _.values(byCell);
    },
  },
  watch: {
    events() {
      this.scheduleRender();
    },
    days() {
      this.scheduleRender();
    },
  },
  mounted() {
    this.resizeObserver = new ResizeObserver(() => this.scheduleRender());
    this.resizeObserver.observe(this.$refs.wrap as HTMLElement);
    this.scheduleRender();
  },
  beforeDestroy() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
  },
  methods: {
    scheduleRender() {
      if (this.renderFrame !== null) return;
      this.renderFrame = requestAnimationFrame(() => {
        this.renderFrame = null;
        this.render();
      });
    },
    render() {
      const svgEl = this.$refs.svg as SVGSVGElement;
      const wrap = this.$refs.wrap as HTMLElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';
      d3.select(wrap).selectAll('.aw-vis-tooltip').remove();
      if ((this.events as IEvent[]).length === 0) return;

      const size = Math.min(this.size, Math.max(wrap.clientWidth || this.size, 320));
      const svg = d3.select(svgEl).attr('width', size).attr('height', size);
      const cx = size / 2;
      const cy = size / 2;

      const innerR = size * 0.13;
      const outerR = size * 0.46;
      const nRings = this.days;
      const ringW = (outerR - innerR) / nRings;
      const arcW = ringW * 0.78;

      // Day 0 (most recent) innermost.
      const ringFor = (dayIndex: number) => innerR + dayIndex * ringW + ringW / 2;
      // Midnight at the top (12 o'clock), clockwise.
      const angleFor = (hour: number, minute = 0) =>
        ((hour + minute / 60) / 24) * 2 * Math.PI - Math.PI / 2;

      const tooltip = d3.select(wrap).append('div').attr('class', 'aw-vis-tooltip');

      const g = svg.append('g').attr('transform', `translate(${cx},${cy})`);

      // Subtle ring separators + day labels for every other ring.
      for (let d = 0; d < nRings; d++) {
        const r = ringFor(d);
        g.append('circle')
          .attr('r', r)
          .attr('fill', 'none')
          .attr('stroke', 'var(--aw-vis-grid, #E5E9F0)')
          .attr('stroke-width', 0.5)
          .attr('pointer-events', 'none');
        if (d % 2 === 0 || nRings <= 7) {
          const date = new Date(startOfToday().getTime() - d * 86400000);
          const lbl = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(
            date.getDate()
          ).padStart(2, '0')}`;
          const lg = g
            .append('g')
            .attr('transform', `rotate(${((-Math.PI / 2 + Math.PI / 2) * 180) / Math.PI})`);
          lg.append('text')
            .attr('x', 0)
            .attr('y', -r + ringW / 2 + 3)
            .attr('font-size', Math.min(ringW * 0.55, 9.5))
            .attr('text-anchor', 'middle')
            .style('fill', 'var(--aw-vis-subtext, #6B7280)')
            .style('pointer-events', 'none')
            .text(d === 0 ? `今天 ${lbl}` : lbl);
        }
      }

      // Hour ticks (every 6h) around the outside.
      [0, 6, 12, 18].forEach(h => {
        const a = angleFor(h);
        const r1 = outerR + 2;
        const r2 = outerR + 8;
        g.append('line')
          .attr('x1', Math.cos(a) * r1)
          .attr('y1', Math.sin(a) * r1)
          .attr('x2', Math.cos(a) * r2)
          .attr('y2', Math.sin(a) * r2)
          .attr('stroke', 'var(--aw-vis-subtext, #6B7280)')
          .attr('stroke-width', 1);
        g.append('text')
          .attr('x', Math.cos(a) * (outerR + 18))
          .attr('y', Math.sin(a) * (outerR + 18) + 3)
          .attr('font-size', 10)
          .attr('text-anchor', 'middle')
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text(`${String(h).padStart(2, '0')}:00`);
      });

      const arcGen = d3
        .arc<Segment>()
        .innerRadius((s: Segment) => ringFor(s.dayIndex) - arcW / 2)
        .outerRadius((s: Segment) => ringFor(s.dayIndex) + arcW / 2)
        .startAngle((s: Segment) => angleFor(s.hour))
        .endAngle((s: Segment) => angleFor(s.hour) + (2 * Math.PI) / 24 - 0.004)
        .cornerRadius(1.5)
        .padAngle(0.004);

      g.selectAll('path.spiral-arc')
        .data(this.segments)
        .enter()
        .append('path')
        .attr('class', 'spiral-arc')
        .attr('d', (s: Segment) => arcGen(s) || '')
        .attr('fill', (s: Segment) => getCategoryColorFromString(s.category))
        .attr('opacity', (s: Segment) => 0.35 + 0.65 * Math.min(s.seconds / 3600, 1))
        .on('mousemove', (event: MouseEvent, s: Segment) => {
          const [mx, my] = d3.pointer(event, wrap);
          tooltip
            .classed('aw-vis-tooltip--visible', true)
            .style('left', Math.min(mx + 12, wrap.clientWidth - 150) + 'px')
            .style('top', my - 40 + 'px')
            .html(
              `<b>${s.dayKey} ${String(s.hour).padStart(2, '0')}:00–${String(
                (s.hour + 1) % 24
              ).padStart(2, '0')}:00</b><br>${s.category}<br>${seconds_to_duration(s.seconds)}`
            );
        })
        .on('mouseleave', () => tooltip.classed('aw-vis-tooltip--visible', false));
    },
  },
};
</script>
