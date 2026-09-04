<template lang="pug">
div
  h3.mb-2 Time Spiral
  div.d-flex.align-items-center.mb-3.flex-wrap
    span.small.text-muted.mr-3 每圈一天（24 小时，0 点在正上方），中心是最近的一天，向外回溯过去
    b-button-group(size="sm", style="width: auto;")
      b-button(
        v-for="d in [7, 14, 30]",
        :key="d",
        :pressed="days === d",
        variant="outline-secondary",
        @click="days = d"
      ) {{ d }} 天
    span.small.text-muted.ml-3(v-if="loading") 加载中…
    span.small.text-muted.ml-3(v-else-if="events.length === 0 && loaded") 该时间段没有窗口事件（需要 window/afk watcher）。

  Timespiral(:events="events", :days="days")
</template>

<script lang="ts">
import moment from 'moment';

import Timespiral from '~/visualizations/TimespiralRewrite.vue';
import { fetchCategorizedWindowEvents } from '~/util/windowAnalysis';
import { IEvent } from '~/util/interfaces';

export default {
  name: 'TimespiralView',
  components: {
    Timespiral,
  },
  data() {
    return {
      days: 14,
      events: [] as IEvent[],
      loading: false,
      loaded: false,
    };
  },
  watch: {
    days() {
      this.load();
    },
  },
  async mounted() {
    await this.load();
  },
  methods: {
    async load() {
      this.loading = true;
      try {
        const evts = await fetchCategorizedWindowEvents(
          moment()
            .startOf('day')
            .subtract(this.days - 1, 'days'),
          moment()
        );
        // eslint-disable-next-line no-console
        console.log(
          '[timespiral] events:',
          evts.length,
          'first:',
          JSON.stringify(evts[0]).slice(0, 250)
        );
        this.events = evts;
      } catch (e) {
        console.error('timespiral failed:', e);
        this.events = [];
      }
      this.loading = false;
      this.loaded = true;
    },
  },
};
</script>
