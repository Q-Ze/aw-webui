<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="height + 34")
  div.small.text-muted(v-if="days > 0")
    | Avg per hour, past {{ days }} day{{ days === 1 ? '' : 's' }}
    span(v-if="peak") · peak {{ peak.label }} ({{ peak.avg }})
</template>

<style scoped lang="scss">
svg.vis-svg {
  display: block;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';
import moment from 'moment';

import { seconds_to_duration } from '~/util/time';
import { IEvent } from '~/util/interfaces';

const height = 150;

// Distribution of a not-afk event's duration into the hour-of-day buckets it
// spans. Events longer than an hour get split across hours; the first/last
// partial hours get their clipped share.
function addEventToHours(e: IEvent, hours: number[]) {
  const start = moment(e.timestamp);
  const end = start.clone().add(e.duration, 'seconds');
  let cursor = start.clone();
  while (cursor.isBefore(end)) {
    const nextHour = cursor.clone().add(1, 'hour').startOf('hour');
    const segEnd = moment.min(end, nextHour);
    const secs = segEnd.diff(cursor, 'seconds', true);
    if (secs > 0) hours[cursor.hour()] += secs;
    cursor = segEnd;
  }
}

export default {
  name: 'aw-hourly-rhythm',
  props: {
    history: { type: Object, default: null }, // Record<period_str, IEvent[]>
  },
  data() {
    return { days: 0, peak: null as { label: string; avg: string } | null };
  },
  computed: {
    hourlyStats(): { avg: number[]; days: number } | null {
      if (!this.history) return null;
      const hours = new Array(24).fill(0);
      let nDays = 0;
      _.each(this.history as Record<string, IEvent[]>, events => {
        if (!events || events.length === 0) return;
        nDays += 1;
        _.each(events, e => addEventToHours(e, hours));
      });
      if (nDays === 0) return null;
      return { avg: hours.map(h => h / nDays), days: nDays };
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
      const stats = this.hourlyStats;
      this.days = stats ? stats.days : 0;
      this.peak = null;
      if (!stats) {
        d3.select(svgEl)
          .append('text')
          .attr('x', 4)
          .attr('y', 24)
          .attr('font-size', 14)
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text('No activity history for this period yet.');
        return;
      }
      const data = stats.avg;

      const svg = d3.select(svgEl);
      const el = svgEl.parentElement as HTMLElement;
      const width = Math.max(el.clientWidth - 4, 260);
      const margin = { top: 10, right: 8, bottom: 26, left: 34 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;

      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const x = d3.scalePoint<number>().domain(_.range(24)).range([0, iw]).padding(0.5);
      const y = d3
        .scaleLinear()
        .domain([0, Math.max(...data, 0)])
        .nice()
        .range([ih, 0]);

      // Gridlines
      g.append('g')
        .call(
          d3
            .axisLeft(y)
            .ticks(3)
            .tickFormat(v => `${Math.round((v as number) / 60)}m`)
        )
        .call(sel => sel.select('.domain').remove())
        .attr('font-size', 10.5)
        .style('color', 'var(--aw-vis-subtext, #6B7280)');

      g.append('g')
        .attr('transform', `translate(0,${ih})`)
        .call(
          d3
            .axisBottom(x)
            .tickValues([0, 3, 6, 9, 12, 15, 18, 21, 23])
            .tickFormat((h: number) => `${h}`)
        )
        .attr('font-size', 10.5)
        .style('color', 'var(--aw-vis-subtext, #6B7280)');

      // Smooth curve through the 24 hourly averages.
      const line = d3
        .line<number>()
        .x((_v: number, i: number) => x(i) as number)
        .y((v: number) => y(v))
        .curve(d3.curveCatmullRom.alpha(0.5));
      const area = d3
        .area<number>()
        .x((_v: number, i: number) => x(i) as number)
        .y0(ih)
        .y1((v: number) => y(v))
        .curve(d3.curveCatmullRom.alpha(0.5));

      const defs = svg.append('defs');
      const grad = defs
        .append('linearGradient')
        .attr('id', 'aw-rhythm-grad')
        .attr('x1', '0')
        .attr('y1', '0')
        .attr('x2', '0')
        .attr('y2', '1');
      grad
        .append('stop')
        .attr('offset', '0%')
        .attr('stop-color', '#5B8DEF')
        .attr('stop-opacity', 0.34);
      grad
        .append('stop')
        .attr('offset', '100%')
        .attr('stop-color', '#5B8DEF')
        .attr('stop-opacity', 0.02);

      g.append('path').datum(data).attr('fill', 'url(#aw-rhythm-grad)').attr('d', area);

      g.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', '#5B8DEF')
        .attr('stroke-width', 2)
        .attr('stroke-linecap', 'round')
        .attr('d', line);

      // Hover dots + guide
      const dot = g
        .append('circle')
        .attr('r', 3.5)
        .attr('fill', '#5B8DEF')
        .attr('stroke', 'var(--aw-card-bg, #fff)')
        .attr('stroke-width', 1.5)
        .style('opacity', 0);
      const guide = g
        .append('line')
        .attr('stroke', 'var(--aw-vis-grid, #E5E9F0)')
        .attr('stroke-dasharray', '3 3')
        .style('opacity', 0);
      const label = g
        .append('text')
        .attr('font-size', 11)
        .attr('font-weight', 600)
        .style('fill', 'var(--aw-vis-text, #3C4257)')
        .style('opacity', 0);

      const overlay = g
        .append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', iw)
        .attr('height', ih)
        .style('fill', 'transparent')
        .style('cursor', 'crosshair');

      overlay
        .on('mousemove', (event: MouseEvent) => {
          const [mx] = d3.pointer(event);
          // Nearest hour for the pointer position.
          const step = iw / 23;
          const h = Math.max(0, Math.min(23, Math.round(mx / step)));
          const v = data[h];
          dot
            .style('opacity', 1)
            .attr('cx', x(h) as number)
            .attr('cy', y(v));
          guide
            .style('opacity', 1)
            .attr('x1', x(h) as number)
            .attr('y1', 0)
            .attr('x2', x(h) as number)
            .attr('y2', ih);
          label
            .style('opacity', 1)
            .attr('x', (x(h) as number) + (h > 16 ? -70 : 8))
            .attr('y', Math.max(y(v) - 8, 10))
            .text(`${String(h).padStart(2, '0')}:00 · ${shortDur(v)}`);
        })
        .on('mouseleave', () => {
          dot.style('opacity', 0);
          guide.style('opacity', 0);
          label.style('opacity', 0);
        });

      // Peak hour annotation
      const peakHour = data.indexOf(Math.max(...data));
      this.peak = {
        label: `${String(peakHour).padStart(2, '0')}:00–${String((peakHour + 1) % 24).padStart(
          2,
          '0'
        )}:00`,
        avg: shortDur(data[peakHour]),
      };
    },
  },
};

function shortDur(seconds: number): string {
  const m = seconds_to_duration(seconds).match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
  return m ? m[0].trim() || '<1m' : '<1m';
}
</script>
