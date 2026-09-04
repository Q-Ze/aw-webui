<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="height + 4")
  div.small.text-muted(v-if="days > 0")
    | Category switches per hour (avg over {{ days }} day{{ days === 1 ? '' : 's' }}) · lower is calmer
  div.small.text-muted(v-else-if="loaded") No window events for this period.
  div.small.text-muted(v-else) Loading...
</template>

<style scoped lang="scss">
svg.vis-svg {
  display: block;
}

.small {
  font-size: 11.5px;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import moment from 'moment';

import { fetchCategorizedWindowEvents, switchesPerHour } from '~/util/windowAnalysis';
import { useActivityStore } from '~/stores/activity';

const height = 150;

export default {
  name: 'aw-switch-rate',
  data() {
    return { loaded: false, days: 0 };
  },
  watch: {
    'activityStore.query_options.timeperiod': function () {
      this.load();
    },
  },
  mounted() {
    this.load();
  },
  methods: {
    async load() {
      this.loaded = false;
      const qo = useActivityStore().query_options;
      if (!qo) return;
      const start = moment(qo.timeperiod.start);
      const end = start.clone().add(qo.timeperiod.length[0], qo.timeperiod.length[1] as any);
      let data: { counts: number[]; days: number } | null = null;
      try {
        const events = await fetchCategorizedWindowEvents(start, end);
        data = switchesPerHour(events);
      } catch (e) {
        console.error('aw-switch-rate failed:', e);
      }
      this.days = data ? data.days : 0;
      this.loaded = true;
      this.$nextTick(() => this.render(data));
    },
    render(data: { counts: number[] } | null) {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';
      if (!data) return;
      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const margin = { top: 8, right: 8, bottom: 20, left: 30 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const x = d3.scaleBand<number>().domain(d3.range(24)).range([0, iw]).padding(0.35);
      const y = d3
        .scaleLinear()
        .domain([0, Math.max(...data.counts, 1)])
        .nice()
        .range([ih, 0]);

      g.append('g')
        .call(d3.axisLeft(y).ticks(3).tickFormat(d3.format('d')))
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

      // Amber bars: switching is a "heat" metric, distinct from the blue rhythm chart.
      g.selectAll('rect')
        .data(data.counts)
        .enter()
        .append('rect')
        .attr('x', (_v, h: number) => x(h) as number)
        .attr('y', ih)
        .attr('width', x.bandwidth())
        .attr('rx', 2)
        .attr('fill', '#F2A93B')
        .style('opacity', 0.85)
        .on('mouseenter', function () {
          d3.select(this).style('opacity', 1);
        })
        .on('mouseleave', function () {
          d3.select(this).style('opacity', 0.85);
        })
        .append('title')
        .text(
          (v: number, h: number) =>
            `${String(h).padStart(2, '0')}:00 · ${v.toFixed(1)} switches/h avg`
        );

      // Animate bars up on first paint.
      g.selectAll('rect')
        .transition()
        .duration(450)
        .ease(d3.easeCubicOut)
        .delay((_v, i: number) => i * 12)
        .attr('y', (v: number) => y(v))
        .attr('height', (v: number) => Math.max(ih - y(v), 1));
    },
  },
};
</script>
