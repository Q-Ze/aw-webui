<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="height + 34")
  div.small.text-muted(v-if="days > 0")
    | Avg active minutes per hour · {{ days }} day{{ days === 1 ? '' : 's' }} ending {{ endLabel }} (window/AFK-based)
    span(v-if="peak") · peak {{ peak.label }} ({{ peak.avg }})
  div.small.text-muted(v-else-if="loaded") No activity data for the past 30 days.
  div.small.text-muted(v-else) Loading…
</template>

<style scoped lang="scss">
svg.vis-svg {
  display: block;
}

.small {
  font-size: 12px;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';

import { seconds_to_duration } from '~/util/time';
import { getDailyHourlyActivity } from '~/util/hourlyMatrix';
import { useActivityStore } from '~/stores/activity';

const height = 150;
const WINDOW_DAYS = 30;

// Chart data is a trailing-window average of canonical (window ∩ not-afk)
// activity — the same source as the Timeline barchart — not the AFK
// store's merged history. It does not depend on the selected date.
export default {
  name: 'aw-hourly-rhythm',
  data() {
    return {
      activityStore: useActivityStore(),
      loaded: false,
      days: 0,
      endLabel: '',
      peak: null as { label: string; avg: string } | null,
    };
  },
  watch: {
    // Follow the browsed date: the window is the 30 days ending at it.
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
        // The util anchors a single 60-day server query and slices windows
        // locally — switching dates costs no extra queries.
        const end = this.selectedDate();
        this.endLabel = `${String(end.getMonth() + 1).padStart(2, '0')}/${String(
          end.getDate()
        ).padStart(2, '0')}`;
        const { days, matrix } = await getDailyHourlyActivity(WINDOW_DAYS, end);
        const d = days;
        const m = matrix;
        this.days = d.length;
        if (d.length > 0) {
          const totals = new Array(24).fill(0);
          m.forEach(hours => hours.forEach((min, h) => (totals[h] += min)));
          const avg = totals.map(v => (v / d.length >= 0.5 ? (v / d.length) * 60 : 0));
          this.peak = peakOf(avg);
          this.$nextTick(() => this.render(avg));
        }
      } catch (e) {
        console.error('aw-hourly-rhythm failed:', e);
      }
      this.loaded = true;
    },
    selectedDate(): Date {
      const qo = useActivityStore().query_options;
      const d = qo ? new Date(qo.timeperiod.start) : new Date();
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    },
    render(avg: number[]) {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';
      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const margin = { top: 10, right: 8, bottom: 26, left: 34 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const x = d3.scalePoint<number>().domain(_.range(24)).range([0, iw]).padding(0.5);
      const y = d3
        .scaleLinear()
        .domain([0, Math.max(...avg, 60)])
        .nice()
        .range([ih, 0]);

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

      g.append('path').datum(avg).attr('fill', 'url(#aw-rhythm-grad)').attr('d', area);
      g.append('path')
        .datum(avg)
        .attr('fill', 'none')
        .attr('stroke', '#5B8DEF')
        .attr('stroke-width', 2)
        .attr('stroke-linecap', 'round')
        .attr('d', line);

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

      g.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', iw)
        .attr('height', ih)
        .style('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('mousemove', (event: MouseEvent) => {
          const [mx] = d3.pointer(event);
          const step = iw / 23;
          const h = Math.max(0, Math.min(23, Math.round(mx / step)));
          const v = avg[h];
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
    },
  },
};

function peakOf(avg: number[]): { label: string; avg: string } | null {
  const max = Math.max(...avg);
  if (max <= 0) return null;
  const h = avg.indexOf(max);
  return {
    label: `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`,
    avg: shortDur(max),
  };
}

function shortDur(seconds: number): string {
  const m = seconds_to_duration(seconds).match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
  return m ? m[0].trim() || '<1m' : '<1m';
}
</script>
