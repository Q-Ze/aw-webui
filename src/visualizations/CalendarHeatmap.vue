<template lang="pug">
div
  div.small.text-muted.mb-1(v-if="loaded") Last 365 days · active time per day
  svg.vis-svg(ref="svg", width="100%")
  div.small.text-muted(v-if="error") Failed to load heatmap data: {{ error }}
  div.small.text-muted(v-else-if="!loaded") Loading...
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

import queries from '~/queries';
import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';
import { seconds_to_duration } from '~/util/time';

// Sequential green scale, light -> saturated. Fixed hexes read fine on both
// the light card background and the dark card background.
const HEAT_COLORS = ['#E8F0E9', '#C6E1C9', '#9CCDA3', '#6FB97B', '#47A257', '#2E8843', '#1B6E31'];

export default {
  name: 'aw-calendar-heatmap',
  data() {
    return { loaded: false, error: null as string | null, byDate: {} as Record<string, number> };
  },
  async mounted() {
    try {
      await useBucketsStore().ensureLoaded();
      const bucketsStore = useBucketsStore();
      const settingsStore = useSettingsStore();

      // Same bucket-selection policy as the activity store's history query:
      // all hosts' afk buckets in multidevice mode, else the current host's.
      let afk_buckets: string[] = [];
      const allAfkBuckets = _.flatten(
        bucketsStore.hosts
          .filter(h => h && !h.startsWith('fakedata'))
          .map(h => bucketsStore.bucketsAFK(h))
      );
      if (settingsStore.useMultidevice) {
        afk_buckets = allAfkBuckets;
      } else {
        afk_buckets = [allAfkBuckets[0]];
      }
      afk_buckets = afk_buckets.filter(Boolean);
      if (afk_buckets.length === 0) {
        this.error = 'no AFK bucket found';
        return;
      }

      const today = moment().startOf('day');
      const days: string[] = [];
      for (let i = 364; i >= 0; i--) {
        const d = today.clone().subtract(i, 'days');
        days.push(
          d.format('YYYY-MM-DDT00:00:00+00:00/') +
            d.clone().add(1, 'day').format('YYYY-MM-DDT00:00:00+00:00')
        );
      }

      const q = [
        'events = [];',
        ...afk_buckets.map(
          bid => `events = union_no_overlap(events, flood(query_bucket("${bid}")));`
        ),
        'events = filter_keyvals(events, "status", ["not-afk"]);',
        'duration = sum_durations(events);',
        'RETURN = {"duration": duration};',
      ];

      const data = await getClient().query(days, q, { name: 'heatmapQuery' });
      const byDate: Record<string, number> = {};
      _.each(days, (day, i) => {
        const res = data[i];
        const dur = res && res[0] && res[0].duration ? res[0].duration : 0;
        byDate[moment(day.split('/')[0]).format('YYYY-MM-DD')] = dur;
      });
      this.byDate = byDate;
      this.loaded = true;
      this.$nextTick(() => this.render());
    } catch (e) {
      this.error = (e as Error).message || String(e);
    }
  },
  methods: {
    render() {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl || !this.loaded) return;
      svgEl.innerHTML = '';

      const svg = d3.select(svgEl);
      const el = svgEl.parentElement as HTMLElement;
      const width = Math.max(el.clientWidth - 4, 540);
      const cell = Math.min(13, Math.floor((width - 30) / 53));
      const gap = 3;
      const leftPad = 28;
      const topPad = 16;

      const values = Object.values(this.byDate) as number[];
      const maxDur = d3.max(values) || 1;
      const color = d3
        .scaleQuantize<string>()
        .domain([0, Math.max(maxDur, 1)])
        .range(HEAT_COLORS);

      // Grid: columns are weeks (Sunday-start), rows are weekdays.
      const today = moment().startOf('day');
      const start = today.clone().subtract(364, 'days').startOf('week');

      const g = svg.append('g').attr('transform', `translate(${leftPad},${topPad})`);

      let week = 0;
      for (let d = start.clone(); d.isSameOrBefore(today); d.add(1, 'day')) {
        if (d.isBefore(start)) continue;
        const col = week;
        const row = d.day();
        const key = d.format('YYYY-MM-DD');
        const dur = this.byDate[key] || 0;
        if (d.day() === 6) week++;

        const rect = g
          .append('rect')
          .attr('x', col * (cell + gap))
          .attr('y', row * (cell + gap))
          .attr('width', cell)
          .attr('height', cell)
          .attr('rx', 2.5)
          .attr('fill', this.byDate[key] !== undefined ? color(dur) : 'transparent')
          .style('cursor', 'pointer');
        if (this.byDate[key] !== undefined) {
          rect
            .on('mouseenter', function () {
              d3.select(this)
                .attr('stroke', 'var(--aw-vis-subtext, #6B7280)')
                .attr('stroke-width', 1.2);
            })
            .on('mouseleave', function () {
              d3.select(this).attr('stroke', null);
            })
            .append('title')
            .text(`${key} · ${dur > 0 ? seconds_to_duration(dur) : 'no activity'}`);
        }
      }
      const totalWeeks = week + 1;

      // Month labels along the top.
      let lastMonth = -1;
      for (let d = start.clone(); d.isSameOrBefore(today); d.add(1, 'day')) {
        const m = d.month();
        if (m !== lastMonth && d.date() <= 7) {
          const col = Math.floor(d.diff(start, 'days') / 7);
          g.append('text')
            .attr('x', col * (cell + gap))
            .attr('y', -5)
            .attr('font-size', 9.5)
            .style('fill', 'var(--aw-vis-subtext, #6B7280)')
            .text(d.format('MMM'));
          lastMonth = m;
        }
      }

      // Weekday labels on the left.
      ['Mon', 'Wed', 'Fri'].forEach((lbl, i) => {
        g.append('text')
          .attr('x', -leftPad + 6)
          .attr('y', (i * 2 + 1) * (cell + gap) + cell - 2)
          .attr('font-size', 9.5)
          .style('fill', 'var(--aw-vis-subtext, #6B7280)')
          .text(lbl);
      });

      svg.attr('height', topPad + 7 * (cell + gap) + 6);
      svg.attr('width', leftPad + totalWeeks * (cell + gap));
    },
  },
};
</script>
