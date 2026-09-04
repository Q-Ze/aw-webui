<template lang="pug">
b-alert.digest-weekly(v-if="visible", variant="info", show, dismissible, @dismissed="dismiss")
  div.d-flex.align-items-start
    icon.mr-2.mt-1(name="robot")
    div
      strong 本周时间摘要
      div.digest-text(v-if="state && state.text") {{ state.text }}
      div.small.text-muted(v-else-if="running") 正在生成本周摘要…
      div.small.text-muted(v-else-if="failed") 自动生成失败（检查 AI 摘要配置）。
      div.small.mt-1(v-if="state && state.text")
        router-link(:to="{ name: 'activity-view', params: { host: '', periodLength: 'day', date: '', view_id: 'summary' } }") 查看活动数据 →
</template>

<style scoped lang="scss">
.digest-text {
  font-size: 0.92rem;
  line-height: 1.6;
  margin-top: 0.25rem;
  white-space: pre-wrap;
}

.small {
  font-size: 12px;
}
</style>

<script lang="ts">
import 'vue-awesome/icons/robot';
import { autoWeeklyIfNeeded, readWeeklyState } from '~/util/digest';

const DISMISS_KEY = 'aw-digest-weekly-dismissed-at';

export default {
  name: 'aw-digest-weekly',
  data() {
    return {
      state: readWeeklyState(),
      running: false,
      failed: false,
      dismissedAt: 0,
    };
  },
  computed: {
    visible(): boolean {
      // Show while running, or once a fresh result is in, until dismissed
      // for this cycle.
      if (this.running) return true;
      if (!this.state || !this.state.text) return false;
      return this.dismissedAt < this.state.at;
    },
  },
  async mounted() {
    this.dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10) || 0;
    if (!this.visible) {
      this.running = true;
      try {
        const s = await autoWeeklyIfNeeded();
        if (s) this.state = s;
      } catch {
        this.failed = true;
      }
      this.running = false;
    }
  },
  methods: {
    dismiss() {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    },
  },
};
</script>
