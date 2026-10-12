import type {AgentConfig, ConfigSection} from './types';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const ALIYUN_VIDEO_MODEL = 'wan2.6-i2v-flash';
export const MEDIA_PROVIDER_BASE_URLS = {openrouter: OPENROUTER_BASE_URL, yunwu: 'https://yunwu.ai', aliyun: 'https://dashscope.aliyuncs.com/api/v1'} as const;

/** Selects the protocol and its usual address; compatible addresses remain editable afterwards. */
export function applyMediaProvider(section: ConfigSection, provider: keyof typeof MEDIA_PROVIDER_BASE_URLS): ConfigSection {
  const baseUrl = MEDIA_PROVIDER_BASE_URLS[provider];
  return {...section, api_provider: provider, base_url: baseUrl,
    ...(provider === 'aliyun' ? {model: ALIYUN_VIDEO_MODEL} : {}),
    api_key: serviceOrigin(section.base_url) === serviceOrigin(baseUrl) ? section.api_key : ''};
}

export type ModelPreset = {
  id: string;
  title: string;
  description: string;
  recommended: boolean;
  models: Record<'llm' | 'image' | 'video', string>;
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'starter',
    title: '轻量起步',
    description: '先跑通创作流程，使用轻量创作助手和 Veo Lite 视频模型。',
    recommended: true,
    models: {
      llm: 'google/gemini-3.1-flash-lite',
      image: 'openai/gpt-image-2',
      video: 'google/veo-3.1-lite',
    },
  },
  {
    id: 'balanced',
    title: '均衡创作',
    description: '日常创作组合，搭配 GPT-4.1 Mini 和 Veo Fast 视频模型。',
    recommended: false,
    models: {
      llm: 'openai/gpt-4.1-mini',
      image: 'openai/gpt-image-2',
      video: 'google/veo-3.1-fast',
    },
  },
];

/** Changes only the editable draft; existing saved keys are never read. */
export function applyModelPreset(config: AgentConfig, preset: ModelPreset, apiKey = ''): AgentConfig {
  const sections = {...config.sections};
  const sharedKey = apiKey.trim();
  for (const section of ['llm', 'image', 'video'] as const) {
    sections[section] = {
      ...config.sections[section],
      model: preset.models[section],
      base_url: OPENROUTER_BASE_URL,
      ...(section === 'llm' ? {model_provider: 'openai'} : {api_provider: 'openrouter'}),
      api_key: sharedKey || (serviceOrigin(config.sections[section].base_url) === serviceOrigin(OPENROUTER_BASE_URL)
        ? config.sections[section].api_key : ''),
    };
  }
  return {...config, sections};
}

function serviceOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).origin;
  } catch {
    return baseUrl.trim();
  }
}

export function requiresPlatformKey(draft: ConfigSection, savedBaseUrl: string): boolean {
  return draft.has_api_key && !draft.api_key.trim()
    && serviceOrigin(draft.base_url) !== serviceOrigin(savedBaseUrl);
}
