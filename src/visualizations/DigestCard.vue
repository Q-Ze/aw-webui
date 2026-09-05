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
    b-button.ml-1(size="sm", variant="link", v-b-toggle.digest-debug, v-if="text || error")
      span 调试

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
        div.col-md-3.mt-2
          label.small.mb-1 Max Tokens（生成上限）
          input.form-control.form-control-sm(type="number", min="256", step="256", v-model.number="maxTokens", placeholder="2048", @change="persist")
        div.col-md.mt-2
          label.small.mb-1 思考模式
          select.form-control.form-control-sm(v-model="thinking", @change="persist")
            option(value="") 默认（不发送）
            option(value="enabled") 开启
            option(value="disabled") 关闭
        div.col-md.mt-2
          label.small.mb-1 思考强度
          select.form-control.form-control-sm(v-model="reasoningEffort", @change="persist")
            option(value="") 默认（不发送）
            option(value="low") low
            option(value="high") high
            option(value="max") max
      div.form-check.mt-2
        input.form-check-input(type="checkbox", id="digest-remember-key", v-model="rememberKey", @change="persist")
        label.form-check-label.small(for="digest-remember-key")
          | 在本机记住 API Key（每周自动摘要需要开启；Key 只存在本机浏览器中）
      div.form-check.mt-1
        input.form-check-input(type="checkbox", id="digest-include-titles", v-model="includeTitles", @change="onTitlesChange")
        label.form-check-label.small(for="digest-include-titles")
          | 摘要包含窗口标题（更具体地回顾"做了什么"；窗口标题会发送给你配置的 LLM 端点）

  b-alert(v-if="error", variant="danger", show, dismissible, @dismissed="error = ''") {{ error }}

  b-collapse(id="digest-debug", v-if="text || error")
    div.p-2.mb-2(debug-panel)
      div.small.mb-1(v-if="debug")
        | {{ debugTime }} · {{ debug.model }} @ {{ debug.endpoint }} ·
        | {{ debug.ok ? 'HTTP 成功' : 'HTTP 失败' }}
      div.small.mb-1(v-else) 本次页面会话还没有发起过 LLM 请求（显示的是缓存）。
      div.small.mb-1
        b Request（完整 prompt + 数据）:
      pre.debug-pre {{ debug ? debug.request : '（无）' }}
      div.small.mb-1.mt-2
        b Response（原始响应体）:
      pre.debug-pre {{ debug ? debug.responseRaw : '（无）' }}

  div(v-if="text")
    div.digest-text {{ text }}
    div.small.text-muted.mt-1(v-if="generatedAt")
      | {{ fromCache ? '本机缓存' : '生成于' }} {{ generatedAt }} · 统计范围 {{ rangeLabel }} ·
      | 数据（{{ includeTitles ? '含窗口标题' : '仅应用与分类统计' }}）只发送给你配置的 LLM 端点 ·
      | 点"生成摘要"强制刷新
  div.small.text-muted(v-else-if="!apiKey") 在上方配置 API Key 后即可生成 AI 时间回顾。
</template>

<style scoped lang="scss">
.config-panel {
  background: var(--aw-vis-track, #edf1f6);
  border-radius: 8px;
}

.debug-panel {
  background: var(--aw-vis-track, #edf1f6);
  border-radius: 8px;
}

.debug-pre {
  max-height: 240px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  font-size: 11px;
  line-height: 1.45;
  background: var(--aw-card-bg, #fff);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
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

import {
  getDigest,
  saveDigestConfig,
  DigestGranularity,
  getCachedDigest,
  GRANULARITY_DAYS,
  rangeStart,
  getIncludeTitles,
  setIncludeTitles,
  getLastDigestDebug,
} from '~/util/digest';
import { loadLLMConfig, LLMProvider, DEFAULT_MAX_TOKENS } from '~/util/aiSummary';

export default {
  name: 'aw-digest-card',
  props: {
    timeperiodStart: { type: String, default: null },
    timeperiodLength: { type: Array, default: () => [1, 'day'] },
  },
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
      maxTokens: saved.maxTokens || DEFAULT_MAX_TOKENS,
      thinking: (saved.thinking || '') as string,
      reasoningEffort: (saved.reasoningEffort || '') as string,
      rememberKey: !!saved.apiKey,
      includeTitles: getIncludeTitles(),
      loading: false,
      error: '',
      text: '',
      fromCache: false,
      generatedAt: '' as string,
      rangeLabel: '',
      debug: null as ReturnType<typeof getLastDigestDebug>,
    };
  },
  computed: {
    anchor(): moment.Moment {
      return this.timeperiodStart ? moment(this.timeperiodStart) : moment();
    },
    debugTime(): string {
      return this.debug ? moment(this.debug.at).format('MM-DD HH:mm:ss') : '';
    },
  },
  watch: {
    granularity() {
      this.loadCached();
    },
    timeperiodStart() {
      this.loadCached();
    },
  },
  mounted() {
    this.loadCached();
  },
  methods: {
    loadCached() {
      const cached = getCachedDigest(this.granularity, this.anchor);
      this.text = cached ? cached.text : '';
      this.fromCache = !!cached;
      this.generatedAt = cached ? moment(cached.at).format('MM-DD HH:mm') : '';
      this.updateRangeLabel();
    },
    updateRangeLabel() {
      const start = rangeStart(this.granularity, this.anchor);
      this.rangeLabel = `${start.format('YYYY-MM-DD')} 起 ${GRANULARITY_DAYS[this.granularity]} 天`;
    },
    onTitlesChange() {
      setIncludeTitles(this.includeTitles);
      this.loadCached();
    },
    persist() {
      saveDigestConfig(
        {
          provider: this.provider,
          model: this.model,
          baseUrl: this.baseUrl,
          apiKey: this.apiKey,
          maxTokens:
            Number.isFinite(this.maxTokens) && this.maxTokens >= 1 ? this.maxTokens : undefined,
          thinking:
            this.thinking === 'enabled' || this.thinking === 'disabled' ? this.thinking : undefined,
          reasoningEffort: ['low', 'high', 'max'].includes(this.reasoningEffort)
            ? this.reasoningEffort
            : undefined,
        },
        this.rememberKey
      );
    },
    async generate(force = false) {
      this.loading = true;
      this.error = '';
      this.persist();
      try {
        this.text = await getDigest(this.granularity, force, this.anchor);
        this.fromCache = false;
        this.generatedAt = moment().format('MM-DD HH:mm');
        this.updateRangeLabel();
      } catch (e) {
        // Keep showing the previous/cached text; surface why it failed.
        this.error = `生成失败：${(e as Error).message || String(e)}${
          this.text ? '（仍显示之前的内容）' : ''
        }`;
      }
      this.debug = getLastDigestDebug();
      this.loading = false;
    },
  },
};
</script>
