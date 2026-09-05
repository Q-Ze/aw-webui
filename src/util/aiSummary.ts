export interface AppUsage {
  app: string;
  duration: number; // seconds
}

export interface ActivitySummaryData {
  topApps: AppUsage[];
  totalDuration: number; // seconds
  periodDays: number;
}

export function aggregateEvents(events: any[]): AppUsage[] {
  const byApp: Record<string, number> = {};
  for (const event of events) {
    const app = event.data?.app || event.data?.title || 'unknown';
    byApp[app] = (byApp[app] || 0) + (event.duration || 0);
  }
  return Object.entries(byApp)
    .map(([app, duration]) => ({ app, duration }))
    .sort((a, b) => b.duration - a.duration);
}

export function formatDurationHuman(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function buildSummaryText(data: ActivitySummaryData): string {
  const lines: string[] = [
    `Activity summary — past ${data.periodDays} day(s):`,
    `Total tracked time: ${formatDurationHuman(data.totalDuration)}`,
    '',
    'Top applications by time:',
  ];
  for (const item of data.topApps.slice(0, 20)) {
    lines.push(`  ${item.app}: ${formatDurationHuman(item.duration)}`);
  }
  return lines.join('\n');
}

export type LLMProvider = 'openai' | 'anthropic';
export type ThinkingMode = 'enabled' | 'disabled';
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  /** Override the provider's default API endpoint (e.g. an OpenAI-compatible proxy). */
  baseUrl?: string;
  /** Response token cap for digest generation (default 2048). */
  maxTokens?: number;
  /** Thinking mode switch: {"thinking":{"type":...}} (DeepSeek-style, shared body field). */
  thinking?: ThinkingMode;
  /** Reasoning effort: reasoning_effort (OpenAI format) / output_config.effort (Anthropic format). */
  reasoningEffort?: ReasoningEffort;
}

const LS_KEY = 'aw-ai-summary-llm-config';
export const DEFAULT_MAX_TOKENS = 2048;

export function loadLLMConfig(): Partial<LLMConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const config: Partial<LLMConfig> = raw ? JSON.parse(raw) : {};
    if (config.provider !== 'openai' && config.provider !== 'anthropic') {
      delete config.provider;
      delete config.model;
    }
    if (
      typeof config.maxTokens !== 'number' ||
      !Number.isFinite(config.maxTokens) ||
      config.maxTokens < 1
    ) {
      delete config.maxTokens;
    }
    if (config.thinking !== 'enabled' && config.thinking !== 'disabled') {
      delete config.thinking;
    }
    if (!['low', 'high', 'max'].includes(config.reasoningEffort as string)) {
      delete config.reasoningEffort;
    }
    return config;
  } catch {
    return {};
  }
}

export function saveLLMConfig(config: Partial<LLMConfig>, rememberKey = false): void {
  const persistedConfig = { ...config };
  // The API key is only persisted when the user explicitly opts in (it is
  // required for the weekly auto-digest to run without re-entering it).
  if (!rememberKey) {
    delete persistedConfig.apiKey;
  }
  localStorage.setItem(LS_KEY, JSON.stringify(persistedConfig));
}

export interface LLMRawExchange {
  endpoint: string;
  model: string;
  requestBody: string;
  responseRaw: string;
  ok: boolean;
  at: number;
}

export async function callLLM(
  config: LLMConfig,
  userMessage: string,
  onRaw?: (exchange: LLMRawExchange) => void
): Promise<string> {
  if (!config.apiKey) throw new Error('API key is required');

  const attempt = async (): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      return await callLLMOnce(config, userMessage, controller.signal, onRaw);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const text = await attempt();
    if (!text || !text.trim()) throw new Error('LLM 返回了空内容（请重试，或换一个模型）');
    return text;
  } catch (e) {
    // One retry for network hiccups / flaky relays — these are the exact
    // failures that made digests "sometimes silently not arrive".
    const msg = (e as Error).message || String(e);
    const retryable = /Failed to fetch|NetworkError|aborted|timeout|5\d\d|ECONN/i.test(msg);
    if (!retryable) throw e;
    await new Promise(r => setTimeout(r, 1500));
    const text = await attempt();
    if (!text || !text.trim()) throw new Error('LLM 返回了空内容（请重试，或换一个模型）');
    return text;
  }
}

async function callLLMOnce(
  config: LLMConfig,
  userMessage: string,
  signal: AbortSignal,
  onRaw?: (exchange: LLMRawExchange) => void
): Promise<string> {
  const parse = async (res: Response, endpoint: string, model: string): Promise<string> => {
    const raw = await res.text();
    onRaw?.({
      endpoint,
      model,
      requestBody: userMessage,
      responseRaw: raw,
      ok: res.ok,
      at: Date.now(),
    });
    if (!res.ok) {
      throw new Error(`LLM request failed (${res.status}): ${raw.slice(0, 200)}`);
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`LLM 响应不是 JSON（前 200 字符）：${raw.slice(0, 200)}`);
    }
    return data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? '';
  };

  // Optional reasoning controls (DeepSeek-style): thinking switch is a shared
  // body field; effort maps to reasoning_effort (OpenAI format) or
  // output_config.effort (Anthropic format). Unset fields are not sent, so
  // the provider default applies.
  const thinkingFields = (provider: LLMProvider): Record<string, unknown> => {
    const fields: Record<string, unknown> = {};
    if (config.thinking) fields.thinking = { type: config.thinking };
    if (config.reasoningEffort) {
      if (provider === 'anthropic') fields.output_config = { effort: config.reasoningEffort };
      else fields.reasoning_effort = config.reasoningEffort;
    }
    return fields;
  };

  if (config.provider === 'openai') {
    const endpoint =
      (config.baseUrl || 'https://api.openai.com').replace(/\/$/, '') + '/v1/chat/completions';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
        ...thinkingFields('openai'),
      }),
    });
    return parse(res, endpoint, config.model || 'gpt-4o-mini');
  }

  if (config.provider === 'anthropic') {
    const endpoint =
      (config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal,
      body: JSON.stringify({
        model: config.model || 'claude-haiku-4-5-20251001',
        max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: userMessage }],
        ...thinkingFields('anthropic'),
      }),
    });
    return parse(res, endpoint, config.model || 'claude-haiku-4-5-20251001');
  }

  throw new Error(`Unknown provider: ${config.provider}`);
}
