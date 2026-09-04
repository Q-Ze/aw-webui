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

import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useSettingsStore } from '~/stores/settings';
import { seconds_to_duration } from '~/util/time';

// Sequential green scale, light -> saturated, with strong steps between
// levels so adjacent ranks are clearly distinguishable. Fixed hexes read
// fine on both the light and dark card backgrounds.
const HEAT_COLORS = ['#EAF2EC', '#C8E5CD', '#93CFA5', '#57AE74', '#2E8B57', '#1E6B40'];

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
        // aw-client returns one object per period ({duration}); accept the
        // raw-REST [{duration}] shape as well.
        const res = data[i];
        const dur = (res && (res.duration ?? (res[0] && res[0].duration) ?? 0)) || 0;
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
      // Color by rank among ACTIVE days, not by value over [0, max]: raw
      // durations cluster (most days 2–10h, a few outliers near 24h), so a
      // linear scale paints nearly everything the same lightest shade.
      // Quantile thresholds over the non-zero days spread the ramps evenly;
      // zero-activity days stay visually empty (track color).
      const active = values.filter(v => v > 0).sort(d3.ascending);
      const thresholds = [0.25, 0.5, 0.75, 0.9]
        .map(q => d3.quantile(active, q) as number)
        .filter((v, i, arr) => v > 0 && (i === 0 || v > arr[i - 1]));
      const color = d3
        .scaleThreshold<number, string>()
        .domain(thresholds)
        .range(HEAT_COLORS.slice(0, thresholds.length + 1));
      const trackFill = 'var(--aw-vis-track, #EDF1F6)';

      // Fast custom tooltip (native <title> tooltips are too slow to feel
      // responsive on a grid like this).
      const tooltip = d3.select(el).append('div').attr('class', 'aw-vis-tooltip');

      // Grid: columns are weeks (Sunday-start), rows are weekdays.
      const today = moment().startOf('day');
      const start = today.clone().subtract(364, 'days').startOf('week');

      const g = svg.append('g').attr('transform', `translate(${leftPad},${topPad})`);

      let week = 0;
      for (let d = start.clone(); d.isSameOrBefore(today); d.add(1, 'day')) {
        const col = week;
        const row = d.day();
        const key = d.format('YYYY-MM-DD');
        const dur = this.byDate[key] || 0;
        if (d.day() === 6) week++;
        const hasData = this.byDate[key] !== undefined && !d.isAfter(today);

        const rect = g
          .append('rect')
          .attr('x', col * (cell + gap))
          .attr('y', row * (cell + gap))
          .attr('width', cell)
          .attr('height', cell)
          .attr('rx', 2.5)
          .attr('fill', hasData ? (dur > 0 ? color(dur) : trackFill) : 'transparent')
          .style('cursor', hasData ? 'pointer' : 'default');
        if (hasData) {
          rect
            .on('mousemove', (event: MouseEvent) => {
              const [mx, my] = d3.pointer(event, el);
              tooltip
                .classed('aw-vis-tooltip--visible', true)
                .style('left', Math.min(mx + 12, el.clientWidth - 130) + 'px')
                .style('top', my - 34 + 'px')
                .html(`<b>${key}</b><br>${dur > 0 ? seconds_to_duration(dur) : 'no activity'}`);
            })
            .on('mouseenter', function () {
              d3.select(this)
                .attr('stroke', 'var(--aw-vis-subtext, #6B7280)')
                .attr('stroke-width', 1.2);
            })
            .on('mouseleave', function () {
              d3.select(this).attr('stroke', null);
              tooltip.classed('aw-vis-tooltip--visible', false);
            });
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
