<template lang="pug">
div
  div.d-flex.align-items-center.flex-wrap.mb-2
    b-button-group(size="sm")
      b-button(
        v-for="g in granularities",
        :key="g.value",
        :pressed="granularity === g.value",
        variant="outline-secondary",
        @click="granularity = g.value"
      ) {{ g.label }}
    b-button.ml-2(size="sm", variant="primary", :disabled="loading || !apiKey", @click="generate(true)")
      b-spinner.mr-1(v-if="loading", small)
      | {{ loading ? '生成中…' : '生成摘要' }}
    b-button.ml-1(size="sm", variant="link", v-b-toggle.digest-config)
      icon(name="cog")
      span.d-none.d-md-inline.ml-1 配置

  b-collapse(id="digest-config")
    div.p-2.mb-2(config-panel)
      div.row
        div.col-md-3
          label.small.mb-1 Provider
          select.form-control.form-control-sm(v-model="provider")
            option(value="openai") OpenAI 兼容
            option(value="anthropic") Anthropic
        div.col-md-3
          label.small.mb-1 Model
          input.form-control.form-control-sm(v-model="model", placeholder="gpt-4o-mini", @change="persist")
        div.col-md-3
          label.small.mb-1 Base URL（可选）
          input.form-control.form-control-sm(v-model="baseUrl", placeholder="https://api.openai.com", @change="persist")
        div.col-md-3
          label.small.mb-1 API Key
          input.form-control.form-control-sm(type="password", v-model="apiKey", @change="persist")
      div.form-check.mt-2
        input.form-check-input(type="checkbox", id="digest-remember-key", v-model="rememberKey", @change="persist")
        label.form-check-label.small(for="digest-remember-key")
          | 在本机记住 API Key（每周自动摘要需要开启；Key 只存在本机浏览器中）

  b-alert(v-if="error", variant="danger", show, dismissible, @dismissed="error = ''") {{ error }}

  div(v-if="text")
    div.digest-text {{ text }}
    div.small.text-muted.mt-1(v-if="generatedAt") 生成于 {{ generatedAt }} · 数据只发送给你配置的 LLM 端点
  div.small.text-muted(v-else-if="!apiKey") 在上方配置 API Key 后即可生成 AI 时间摘要（2-3 句话）。
</template>

<style scoped lang="scss">
.config-panel {
  background: var(--aw-vis-track, #edf1f6);
  border-radius: 8px;
}

.digest-text {
  font-size: 0.95rem;
  line-height: 1.65;
  color: var(--aw-vis-text, #3c4257);
  white-space: pre-wrap;
}

.small {
  font-size: 12px;
}
</style>

<script lang="ts">
import moment from 'moment';
import 'vue-awesome/icons/cog';

import { getDigest, saveDigestConfig, DigestGranularity, getCachedDigest } from '~/util/digest';
import { loadLLMConfig, LLMProvider } from '~/util/aiSummary';

export default {
  name: 'aw-digest-card',
  data() {
    const saved = loadLLMConfig();
    return {
      granularities: [
        { value: 'day', label: '日' },
        { value: 'week', label: '周' },
        { value: 'month', label: '月' },
        { value: 'year', label: '年' },
      ] as { value: DigestGranularity; label: string }[],
      granularity: 'day' as DigestGranularity,
      provider: (saved.provider || 'openai') as LLMProvider,
      model: saved.model || '',
      baseUrl: saved.baseUrl || '',
      apiKey: saved.apiKey || '',
      rememberKey: !!saved.apiKey,
      loading: false,
      error: '',
      text: '',
      generatedAt: '' as string,
    };
  },
  watch: {
    granularity() {
      this.loadCached();
    },
  },
  mounted() {
    this.loadCached();
  },
  methods: {
    loadCached() {
      const cached = getCachedDigest(this.granularity);
      this.text = cached ? cached.text : '';
      this.generatedAt = cached ? moment(cached.at).format('MM-DD HH:mm') : '';
    },
    persist() {
      saveDigestConfig(
        {
          provider: this.provider,
          model: this.model,
          baseUrl: this.baseUrl,
          apiKey: this.apiKey,
        },
        this.rememberKey
      );
    },
    async generate(force = false) {
      this.loading = true;
      this.error = '';
      this.persist();
      try {
        this.text = await getDigest(this.granularity, force);
        this.generatedAt = moment().format('MM-DD HH:mm');
      } catch (e) {
        this.error = (e as Error).message || String(e);
      }
      this.loading = false;
    },
  },
};
</script>
