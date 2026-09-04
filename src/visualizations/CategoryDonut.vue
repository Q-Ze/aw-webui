<template lang="pug">
div.d-flex.align-items-center(v-if="slices && slices.length > 0")
  svg(ref="svg", :height="size", :width="size", style="flex: 0 0 auto;")
  div.legend.pl-3(style="flex: 1 1 auto; min-width: 0;")
    div.legend-row(
      v-for="s in slices",
      :key="s.name",
      :href="s.link",
      @click="s.link && navigate(s.link)",
      :style="{cursor: s.link ? 'pointer' : 'default'}",
      @mouseenter="hoverSlice(s.name)",
      @mouseleave="hoverSlice(null)"
    )
      span.legend-dot(:style="{background: s.color}")
      span.legend-name(:title="s.name") {{ s.name }}
      span.legend-value {{ s.durationShort }} · {{ s.pct }}%
div(v-else)
  div.text-muted.pt-3(v-if="loaded") No category data for this period.
  div.text-muted.pt-3(v-else) Loading...
</template>

<style scoped lang="scss">
.legend-row {
  display: flex;
  align-items: center;
  padding: 2.5px 0;
  font-size: 13px;
  color: var(--aw-vis-text, #3c4257);

  &:hover .legend-name {
    text-decoration: underline;
  }
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: 0 0 auto;
  margin-right: 8px;
}

.legend-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 10px;
}

.legend-value {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  color: var(--aw-vis-subtext, #6b7280);
  font-size: 12px;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';

import { useCategoryStore } from '~/stores/categories';
import { seconds_to_duration } from '~/util/time';
import { IEvent } from '~/util/interfaces';

const size = 190;
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
    return { loaded: false, hoverName: null as string | null };
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
  },
  watch: {
    slices() {
      this.render();
    },
    hoverName() {
      this.render();
    },
  },
  mounted() {
    this.loaded = this.events != null;
    this.render();
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
      const radius = size / 2;
      const g = svg.append('g').attr('transform', `translate(${radius},${radius})`);

      const pie = d3
        .pie<Slice>()
        .value((d: Slice) => d.duration)
        .sort(null)
        .padAngle(0.015);

      const arc = d3
        .arc<d3.PieArcDatum<Slice>>()
        .innerRadius(radius - thickness)
        .cornerRadius(4);

      const arcs = pie(this.slices);

      g.selectAll('path')
        .data(arcs)
        .enter()
        .append('path')
        .attr('fill', (d: d3.PieArcDatum<Slice>) => d.data.color)
        .attr('d', (d: d3.PieArcDatum<Slice>) => {
          const arcGen = arc.outerRadius(
            d.data.name === this.hoverName ? radius - 1 : radius - 5
          );
          return arcGen(d) || '';
        })
        .style('cursor', 'pointer')
        .style('opacity', (d: d3.PieArcDatum<Slice>) =>
          this.hoverName && d.data.name !== this.hoverName ? 0.45 : 1
        )
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
      const centerText =
        this.hoverName != null ? this.slices.find(s => s.name === this.hoverName) : null;
      g.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '-0.15em')
        .attr('font-size', 17)
        .attr('font-weight', 600)
        .style('fill', 'var(--aw-vis-text, #3C4257)')
        .text(centerText ? centerText.durationShort : shortDuration(this.totalDuration));
      g.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '1.25em')
        .attr('font-size', 11.5)
        .style('fill', 'var(--aw-vis-subtext, #6B7280)')
        .text(centerText ? centerText.pct + '%' : this.slices.length + ' categories');
    },
  },
};

function shortDuration(seconds: number): string {
  const s = seconds_to_duration(seconds);
  // "2h 8m 50s" -> "2h 08m"; drop seconds for the compact center label
  const m = s.match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
  return m ? m[0].trim() || s : s;
}
</script>
