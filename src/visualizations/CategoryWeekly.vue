<template lang="pug">
div
  svg.vis-svg(ref="svg", width="100%", :height="220 + 26")
  div.small.text-muted.mt-1 Hover a bar segment to see the category
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
import _ from 'lodash';
import moment from 'moment';

import queries from '~/queries';
import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import { buildMultideviceHostParams } from '~/util/multidevice';
import { seconds_to_duration } from '~/util/time';

interface DayCat {
  day: string; // YYYY-MM-DD
  values: Record<string, number>; // category name -> seconds
}

export default {
  name: 'aw-category-weekly',
  data() {
    return { series: null as { name: string; color: string; totalShort: string }[] | null };
  },
  async mounted() {
    try {
      await useBucketsStore().ensureLoaded();
      const bucketsStore = useBucketsStore();
      const settingsStore = useSettingsStore();
      const categoryStore = useCategoryStore();

      // Host selection mirrors the multidevice logic in the activity store.
      let hosts: string[] = [];
      if (settingsStore.useMultidevice) {
        hosts = bucketsStore.hosts.filter(h => h && !h.startsWith('fakedata'));
      } else {
        hosts = [bucketsStore.hosts.find(h => h) || ''];
      }
      const { host_params, hosts_with_buckets } = buildMultideviceHostParams(
        hosts,
        h => bucketsStore.bucketsWindow(h),
        h => bucketsStore.bucketsAFK(h)
      );
      if (hosts_with_buckets.length === 0) {
        this.series = [];
        return;
      }

      const today = moment().startOf('day');
      const periods: string[] = [];
      const days: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = today.clone().subtract(i, 'days');
        days.push(d.format('YYYY-MM-DD'));
        periods.push(
          d.format('YYYY-MM-DDT00:00:00+00:00/') +
            d.clone().add(1, 'day').format('YYYY-MM-DDT00:00:00+00:00')
        );
      }

      const q = queries.categoryQuery({
        hosts: hosts_with_buckets,
        filter_afk: true,
        categories: categoryStore.classes_for_query,
        // Must be null (not []) when no filter is active: canonicalEvents
        // treats a truthy empty list as a whitelist matching nothing.
        filter_categories: null,
        host_params,
        always_active_pattern: '',
      } as any);

      const data = await getClient().query(periods, q, { name: 'weeklyCategoryQuery' });

      // Flatten per-day categorized events into day -> {category: seconds}.
      // aw-client returns one object per period ({ cat_events: [...] });
      // accept the raw-REST [[{cat_events}]] shape as well, just in case.
      const dayCats: DayCat[] = days.map(day => ({ day, values: {} }));
      _.each(data, (result: any, i: number) => {
        const catEvents =
          (result && (result.cat_events || (result[0] && result[0].cat_events))) || [];
        _.each(catEvents, e => {
          // Some merged/categorized result events can lack data or duration
          // (e.g. flood edge cases); skip them rather than crash the chart.
          const cat = ((e.data && e.data['$category']) as string[]) || null;
          if (!cat) return;
          const name = cat.join(' > ');
          dayCats[i].values[name] = (dayCats[i].values[name] || 0) + (e.duration || 0);
        });
      });

      // Top 6 categories by week total; the rest collapse into "Other".
      const totals: Record<string, number> = {};
      _.each(dayCats, dc =>
        _.each(dc.values, (v, k) => {
          totals[k] = (totals[k] || 0) + v;
        })
      );
      const topCats = _.slice(
        _.sortBy(_.toPairs(totals), ([, v]) => -v),
        0,
        6
      ).map(([k]) => k);
      const catKeys = [...topCats, '__other__'];

      const stackData: Record<string, any>[] = dayCats.map(dc => {
        const row: Record<string, any> = { day: dc.day };
        _.each(catKeys, k => {
          row[k] = 0;
        });
        _.each(dc.values, (v, k) => {
          const key = topCats.includes(k) ? k : '__other__';
          row[key] += v;
        });
        return row;
      });

      const seriesInfo = catKeys
        .map(k => {
          const total = _.sumBy(stackData, k);
          return {
            key: k,
            name: k === '__other__' ? 'Other' : k,
            color: k === '__other__' ? '#B0BEC5' : categoryStore.get_category_color(k.split(' > ')),
            total,
            totalShort: shortDur(total),
          };
        })
        .filter(s => s.total > 0);
      this.$nextTick(() => this.render(stackData, seriesInfo));
    } catch (e) {
      console.error('aw-category-weekly failed:', e);
      this.series = [];
    }
  },
  methods: {
    render(
      stackData: Record<string, any>[],
      seriesInfo: { key: string; name: string; color: string; total: number }[]
    ) {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl) return;
      svgEl.innerHTML = '';
      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const height = 220;
      const margin = { top: 10, right: 8, bottom: 26, left: 38 };
      const iw = width - margin.left - margin.right;
      const ih = height - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      const stack = d3
        .stack<Record<string, any>>()
        .keys(seriesInfo.map(s => s.key))
        .order(d3.stackOrderNone)
        .offset(d3.stackOffsetNone);
      const layers = stack(stackData);

      const x = d3
        .scaleBand<string>()
        .domain(stackData.map(d => d.day))
        .range([0, iw])
        .padding(0.45);
      const yMax = d3.max(layers, l => d3.max(l, seg => seg[1])) as number;
      const y = d3
        .scaleLinear()
        .domain([0, yMax || 1])
        .nice()
        .range([ih, 0]);

      g.append('g')
        .call(
          d3
            .axisLeft(y)
            .ticks(4)
            .tickFormat(v => `${Math.round((v as number) / 3600)}h`)
        )
        .call(sel => sel.select('.domain').remove())
        .attr('font-size', 10.5)
        .style('color', 'var(--aw-vis-subtext, #6B7280)');

      g.append('g')
        .attr('transform', `translate(0,${ih})`)
        .call(d3.axisBottom(x).tickFormat((d: string) => moment(d).format('dd D/M')))
        .attr('font-size', 10.5)
        .style('color', 'var(--aw-vis-subtext, #6B7280)');

      const colorByKey: Record<string, string> = {};
      seriesInfo.forEach(s => (colorByKey[s.key] = s.color));

      const groups = g
        .selectAll('g.day')
        .data(layers)
        .enter()
        .append('g')
        .attr('fill', (l: any) => colorByKey[l.key]);

      groups
        .selectAll('rect')
        .data(
          (l: any) => l.map((seg: any) => ({ ...seg, key: l.key, day: seg.data.day })),
          (d: any) => d.day + d.key
        )
        .enter()
        .append('rect')
        .attr('x', (d: any) => x(d.day) as number)
        .attr('y', ih)
        .attr('width', x.bandwidth())
        .attr('rx', 2)
        .transition()
        .duration(500)
        .delay((d: any, i: number) => i * 30)
        .ease(d3.easeCubicOut)
        .attr('y', (d: any) => y(d[1]))
        .attr('height', (d: any) => Math.max(y(d[0]) - y(d[1]), 0))
        .selection()
        .append('title')
        .text(
          (d: any) =>
            `${moment(d.day).format('ddd, MMM D')} · ${
              seriesInfo.find(s => s.key === d.key)?.name
            }\n${seconds_to_duration(d[1] - d[0])}`
        );
    },
  },
};

function shortDur(seconds: number): string {
  const m = seconds_to_duration(seconds).match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
  return m ? m[0].trim() || '<1m' : '<1m';
}
</script>
