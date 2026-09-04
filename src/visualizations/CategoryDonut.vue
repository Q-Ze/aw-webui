<template lang="pug">
div(v-if="slices && slices.length > 0", style="position: relative;")
  svg(ref="svg", :width="size", :height="size", :viewBox="`0 0 ${size} ${size}`", style="display: block; margin: 0 auto; max-width: 100%;")
  div.small.text-muted.text-center.mt-1(v-if="hoverSliceName")
    | {{ hoverSliceName }}
div(v-else)
  div.text-muted.pt-3(v-if="loaded") No category data for this period.
  div.text-muted.pt-3(v-else) Loading...
</template>

<style scoped lang="scss">
.small {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';

import { useCategoryStore } from '~/stores/categories';
import { seconds_to_duration } from '~/util/time';
import { IEvent } from '~/util/interfaces';

const thickness = 30;

interface Slice {
  name: string;
  duration: number;
  durationShort: string;
  pct: string;
  color: string;
  link?: string;
}

export default {
  name: 'aw-category-donut',
  props: {
    events: { type: Array, default: null },
  },
  data() {
    return {
      // Exposed to the template: a module-level const is not reachable from
      // the template, which silently left the svg at the default 300x150 and
      // clipped the bottom of the chart.
      size: 190,
      loaded: false,
      hoverName: null as string | null,
    };
  },
  computed: {
    // NOTE: slices and totalDuration must not read each other (circular
    // computed dependencies recurse until the stack overflows). Both derive
    // from this.events directly.
    slices(): Slice[] | null {
      if (!this.events) return null;
      const categoryStore = useCategoryStore();
      const total = _.sumBy(this.events as IEvent[], 'duration');
      return _.map(this.events as IEvent[], e => {
        const cat = ((e.data && e.data['$category']) as string[]) || ['Uncategorized'];
        const name = cat.join(' > ');
        return {
          name,
          duration: e.duration || 0,
          durationShort: shortDuration(e.duration || 0),
          pct: (total > 0 ? ((e.duration || 0) / total) * 100 : 0).toFixed(0),
          color: categoryStore.get_category_color(cat),
          link: '#' + (this as any).$route.path + '?category=' + encodeURIComponent(cat.join('>')),
        };
      });
    },
    totalDuration(): number {
      return this.events ? _.sumBy(this.events as IEvent[], 'duration') : 0;
    },
    hoverSliceName(): string | null {
      if (this.hoverName == null || !this.slices) return null;
      const s = this.slices.find(x => x.name === this.hoverName);
      return s ? s.name : null;
    },
  },
  watch: {
    slices() {
      // $nextTick: the v-if branch above creates the <svg> in the same
      // update; without waiting for the patch, $refs.svg is still undefined
      // and the render silently never happens.
      this.$nextTick(() => this.render());
    },
    hoverName() {
      this.updateHover();
    },
  },
  mounted() {
    this.loaded = this.events != null;
    this.$nextTick(() => this.render());
  },
  methods: {
    navigate(href: string) {
      (this as any).$router.push(href.slice(1)).catch(() => {
        /* duplicated navigation */
      });
    },
    hoverSlice(name: string | null) {
      this.hoverName = name;
    },
    render() {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl || !this.slices || this.slices.length === 0) return;
      svgEl.innerHTML = '';

      const svg = d3.select(svgEl);
      const radius = this.size / 2;
      const g = svg.append('g').attr('transform', `translate(${radius},${radius})`);

      const pie = d3
        .pie<Slice>()
        .value((d: Slice) => d.duration)
        .sort(null)
        .padAngle(0.015);

      const arc = d3
        .arc<d3.PieArcDatum<Slice>>()
        .innerRadius(radius - thickness)
        .outerRadius(radius - 3)
        .cornerRadius(4);

      const arcs = pie(this.slices);

      g.selectAll('path')
        .data(arcs)
        .enter()
        .append('path')
        .attr('fill', (d: d3.PieArcDatum<Slice>) => d.data.color)
        .attr('d', (d: d3.PieArcDatum<Slice>) => arc(d) || '')
        .style('cursor', 'pointer')
        .style('transition', 'opacity 0.12s ease')
        .on('click', (event: MouseEvent, d: d3.PieArcDatum<Slice>) =>
          this.navigate(d.data.link || '')
        )
        .on('mouseenter', (event: MouseEvent, d: d3.PieArcDatum<Slice>) => {
          this.hoverSlice(d.data.name);
        })
        .on('mouseleave', () => this.hoverSlice(null))
        .append('title')
        .text(
          (d: d3.PieArcDatum<Slice>) => d.data.name + '\n' + seconds_to_duration(d.data.duration)
        );

      // Center label: hovered category, else total.
      g.append('text')
        .attr('class', 'donut-center-main')
        .attr('text-anchor', 'middle')
        .attr('dy', '-0.15em')
        .attr('font-size', 17)
        .attr('font-weight', 600)
        .style('fill', 'var(--aw-vis-text, #3C4257)');
      g.append('text')
        .attr('class', 'donut-center-sub')
        .attr('text-anchor', 'middle')
        .attr('dy', '1.25em')
        .attr('font-size', 11.5)
        .style('fill', 'var(--aw-vis-subtext, #6B7280)');

      this.updateHover();
    },
    // Hover updates only tweak path opacity and the two center labels — no
    // full SVG rebuild, so hovering stays smooth even with many slices.
    updateHover() {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl || !this.slices) return;
      const svg = d3.select(svgEl);

      svg
        .selectAll('path')
        .style('opacity', (d: any) =>
          this.hoverName && d.data.name !== this.hoverName ? 0.45 : 1
        );

      const center =
        this.hoverName != null ? this.slices.find(s => s.name === this.hoverName) : null;
      svg
        .select('.donut-center-main')
        .text(center ? center.durationShort : shortDuration(this.totalDuration));
      svg
        .select('.donut-center-sub')
        .text(
          center
            ? center.pct + '% · ' + truncate(center.name, 18)
            : this.slices.length + ' categories'
        );
    },
  },
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function shortDuration(seconds: number): string {
  const s = seconds_to_duration(seconds);
  // "2h 8m 50s" -> "2h 08m"; drop seconds for the compact center label
  const m = s.match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
  return m ? m[0].trim() || s : s;
}
</script>
