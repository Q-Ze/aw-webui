<template lang="pug">
div
  div.d-flex.align-items-center.mb-1
    span.small.text-muted.mr-2 Min session:
    select.form-control.form-control-sm(v-model.number="minMinutes_", style="width: auto;")
      option(v-for="opt in [10, 15, 25, 45, 60]", :key="opt", :value="opt") {{ opt }} min
  div(v-if="sessions && sessions.length > 0")
    div.stats-row
      div.stat
        div.stat-value {{ stats.count }}
        div.stat-label sessions ≥ {{ minMinutes_ }}m
      div.stat
        div.stat-value {{ stats.longest }}
        div.stat-label longest
      div.stat
        div.stat-value {{ stats.avg }}
        div.stat-label average
      div.stat
        div.stat-value {{ stats.total }}
        div.stat-label total focus
    svg.vis-svg(ref="svg", width="100%", :height="barH + 22")
    div.small.text-muted.mt-1 Hover a bar for its time window and category
  div.small.text-muted.pt-2(v-else-if="loaded && longestRun !== null")
    | No sessions ≥ {{ minMinutes_ }}m — your longest uninterrupted block was
    | #[b {{ longestRun }}] . Try a lower threshold above.
  div.small.text-muted.pt-3(v-else-if="loaded") No window events for this period.
  div.small.text-muted.pt-3(v-else) Loading...
</template>

<style scoped lang="scss">
svg.vis-svg {
  display: block;
}

.stats-row {
  display: flex;
  gap: 1.25rem;
  margin-bottom: 0.4rem;
}

.stat {
  flex: 0 0 auto;
}

.stat-value {
  font-size: 1.18rem;
  font-weight: 600;
  color: var(--aw-vis-text, #3c4257);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}

.stat-label {
  font-size: 11px;
  color: var(--aw-vis-subtext, #6b7280);
}

.small {
  font-size: 11.5px;
}
</style>

<script lang="ts">
import * as d3 from 'd3';
import _ from 'lodash';
import moment from 'moment';

import {
  fetchCategorizedWindowEvents,
  sessionsFromEvents,
  FocusSession,
} from '~/util/windowAnalysis';
import { getCategoryColorFromString } from '~/util/color';
import { seconds_to_duration } from '~/util/time';
import { useActivityStore } from '~/stores/activity';

const barH = 120;

export default {
  name: 'aw-focus-sessions',
  data() {
    return {
      loaded: false,
      sessions: null as FocusSession[] | null,
      // A 25min default is too strict for heavily-switching users (their
      // longest same-category run can be well under that); 15min is a more
      // informative default and the threshold is user-adjustable above.
      minMinutes_: 15,
      allSessions: [] as FocusSession[],
      barH,
    };
  },
  computed: {
    longestRun(): string | null {
      if (this.allSessions.length === 0) return null;
      return shortDur(Math.max(...this.allSessions.map(s => s.duration)));
    },
    stats() {
      const s = this.sessions || [];
      const durations = s.map(x => x.duration);
      return {
        count: s.length,
        longest: s.length ? shortDur(Math.max(...durations)) : '—',
        avg: s.length ? shortDur(_.sum(durations) / s.length) : '—',
        total: s.length ? shortDur(_.sum(durations)) : '—',
      };
    },
  },
  watch: {
    minMinutes_() {
      this.applyThreshold();
    },
    // Re-run when the selected day changes.
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
      try {
        const events = await fetchCategorizedWindowEvents(start, end);
        // Compute at the finest threshold once, then re-slice on threshold
        // changes without re-querying.
        this.allSessions = sessionsFromEvents(events, 1);
      } catch (e) {
        console.error('aw-focus-sessions failed:', e);
        this.allSessions = [];
      }
      this.applyThreshold();
      this.loaded = true;
    },
    applyThreshold() {
      this.sessions = this.allSessions.filter(s => s.duration >= this.minMinutes_ * 60);
      this.$nextTick(() => this.render());
    },
    render() {
      const svgEl = this.$refs.svg as SVGSVGElement;
      if (!svgEl || !this.sessions || this.sessions.length === 0) return;
      svgEl.innerHTML = '';
      const svg = d3.select(svgEl);
      const width = Math.max((svgEl.parentElement as HTMLElement).clientWidth - 4, 260);
      const margin = { top: 6, right: 8, bottom: 18, left: 34 };
      const iw = width - margin.left - margin.right;
      const ih = barH - margin.top - margin.bottom;
      const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

      // Sessions as horizontal bars along the day, sorted by start time.
      const sessions = _.orderBy(this.sessions, s => moment(s.start).valueOf());
      const t0 = moment(sessions[0].start).startOf('hour');
      const t1 = moment(sessions[sessions.length - 1].end)
        .clone()
        .add(1, 'hour')
        .startOf('hour');
      const x = d3.scaleTime().domain([t0.toDate(), t1.toDate()]).range([0, iw]);
      const y = d3
        .scaleLinear()
        .domain([0, d3.max(sessions, s => s.duration) as number])
        .nice()
        .range([ih, 0]);

      g.append('g')
        .call(
          d3
            .axisLeft(y)
            .ticks(4)
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
            .ticks(6)
            .tickFormat(d => moment(d as Date).format('HH:mm'))
        )
        .attr('font-size', 10.5)
        .style('color', 'var(--aw-vis-subtext, #6B7280)');

      const barW = Math.max(iw / Math.max(sessions.length * 1.6, 8), 3);

      // Color by category via the same string-hash palette as Top Apps.
      g.selectAll('rect')
        .data(sessions)
        .enter()
        .append('rect')
        .attr('x', s => (x(moment(s.start).toDate()) as number) - barW / 2)
        .attr('y', s => y(s.duration))
        .attr('width', barW)
        .attr('height', s => Math.max(ih - y(s.duration), 1.5))
        .attr('rx', 2)
        .attr('fill', s => getCategoryColorFromString(s.category))
        .style('opacity', 0.9)
        .on('mouseenter', function () {
          d3.select(this).style('opacity', 1);
        })
        .on('mouseleave', function () {
          d3.select(this).style('opacity', 0.9);
        })
        .append('title')
        .text(
          s =>
            `${moment(s.start).format('HH:mm')}–${moment(s.end).format('HH:mm')} · ${
              s.category
            }\n${seconds_to_duration(s.duration)}`
        );
    },
  },
};

function shortDur(seconds: number): string {
  const m = seconds_to_duration(seconds).match(/^(\d+d)?\s*(\d+h)?\s*(\d+m)?/);
  return m ? m[0].trim() || '<1m' : '<1m';
}
</script>
