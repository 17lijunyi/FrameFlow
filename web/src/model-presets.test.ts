import {describe, expect, it} from 'vitest';
import {ALIYUN_VIDEO_MODEL, applyMediaProvider, applyModelPreset, MEDIA_PROVIDER_BASE_URLS, MODEL_PRESETS, OPENROUTER_BASE_URL, requiresPlatformKey} from './model-presets';
import type {AgentConfig, ConfigSection} from './types';

function exampleConfig(): AgentConfig {
  const section: ConfigSection = {
    model: 'custom-model', base_url: 'https://custom.example/v1', api_key: '', has_api_key: true,
  };
  return {
    sections: {
      llm: {...section, model_provider: 'custom'},
      image: {...section},
      video: {...section},
      embedding: {...section, model: 'custom-embedding'},
      reranker: {...section, model: 'custom-reranker'},
    },
  };
}

describe('recommended model draft', () => {
  it('updates the three creative services without mutating the source or retrieval settings', () => {
    const config = exampleConfig();
    config.novel_retrieval = {mode: 'api'};
    const draft = applyModelPreset(config, MODEL_PRESETS[0]);

    expect(draft.sections.llm).toMatchObject({
      model: 'google/gemini-3.1-flash-lite', model_provider: 'openai', base_url: OPENROUTER_BASE_URL,
    });
    expect(draft.sections.image.model).toBe('openai/gpt-image-2');
    expect(draft.sections.video.model).toBe('google/veo-3.1-lite');
    expect(draft.sections.embedding).toBe(config.sections.embedding);
    expect(draft.sections.reranker).toBe(config.sections.reranker);
    expect(config.sections.llm.model).toBe('custom-model');
    expect(config.sections.llm.base_url).toBe('https://custom.example/v1');
    expect(draft.novel_retrieval).toEqual({mode: 'api'});
  });

  it('fills an optional shared key only into the three creative service drafts', () => {
    const config = exampleConfig();
    const draft = applyModelPreset(config, MODEL_PRESETS[1], '  draft-key  ');

    expect(draft.sections.llm.model).toBe('openai/gpt-4.1-mini');
    expect(draft.sections.video.model).toBe('google/veo-3.1-fast');
    for (const name of ['llm', 'image', 'video'] as const) expect(draft.sections[name].api_key).toBe('draft-key');
    expect(draft.sections.embedding.api_key).toBe('');
    expect(draft.sections.reranker.api_key).toBe('');
    expect(config.sections.llm.api_key).toBe('');
  });

  it('replaces legacy media routing with OpenRouter while preserving the source and retrieval services', () => {
    const config = exampleConfig();
    config.sections.image.api_provider = 'yunwu';
    config.sections.video.api_provider = 'yunwu';
    const original = structuredClone(config);

    const draft = applyModelPreset(config, MODEL_PRESETS[0]);

    for (const name of ['image', 'video'] as const) {
      expect(draft.sections[name]).toMatchObject({api_provider: 'openrouter', base_url: OPENROUTER_BASE_URL});
    }
    expect(draft.sections.llm.model_provider).toBe('openai');
    expect(draft.sections.llm).not.toHaveProperty('api_provider');
    expect(draft.sections.embedding).toBe(config.sections.embedding);
    expect(draft.sections.reranker).toBe(config.sections.reranker);
    expect(config).toEqual(original);
  });

  it('clears another platform’s draft key while retaining a draft for the same platform', () => {
    const config = exampleConfig();
    config.sections.image.api_key = 'manually-entered-key';
    config.sections.video.base_url = 'https://openrouter.ai/api/other-path';
    config.sections.video.api_key = 'openrouter-draft-key';
    const draft = applyModelPreset(config, MODEL_PRESETS[0]);
    expect(draft.sections.image.api_key).toBe('');
    expect(draft.sections.image.has_api_key).toBe(true);
    expect(draft.sections.video.api_key).toBe('openrouter-draft-key');
  });
});

describe('service changes with a saved key', () => {
  it('starts an Aliyun video draft with its supported model and Beijing endpoint without borrowing another platform key', () => {
    const original = {...exampleConfig().sections.video, api_provider: 'openrouter', base_url: OPENROUTER_BASE_URL, api_key: 'openrouter-draft'};
    const before = {...original};
    const next = applyMediaProvider(original, 'aliyun');
    expect(next).toMatchObject({api_provider: 'aliyun', model: ALIYUN_VIDEO_MODEL, base_url: MEDIA_PROVIDER_BASE_URLS.aliyun, api_key: '', has_api_key: true});
    expect(requiresPlatformKey(next, original.base_url)).toBe(true);
    expect(original).toEqual(before);
    expect(applyMediaProvider({...next, api_key: 'aliyun-draft'}, 'aliyun').api_key).toBe('aliyun-draft');
    expect(applyMediaProvider({...next, api_key: 'aliyun-draft'}, 'openrouter').api_key).toBe('');
  });

  it('selects an explicit media protocol and usual address while preserving the model and clearing another origin draft key', () => {
    const original = {...exampleConfig().sections.image, api_key: 'old-platform-draft', api_provider: 'yunwu'};
    const next = applyMediaProvider(original, 'openrouter');
    expect(next).toMatchObject({api_provider: 'openrouter', base_url: OPENROUTER_BASE_URL, model: 'custom-model', api_key: '', has_api_key: true});
    expect(original.api_key).toBe('old-platform-draft');
    expect(applyMediaProvider({...next, api_key: 'openrouter-draft'}, 'openrouter').api_key).toBe('openrouter-draft');
  });
  it('requires a new key for a different origin, including a recommended platform switch', () => {
    const config = exampleConfig();
    const draft = applyModelPreset(config, MODEL_PRESETS[0]);
    expect(requiresPlatformKey(draft.sections.llm, config.sections.llm.base_url)).toBe(true);
    expect(requiresPlatformKey({...draft.sections.llm, api_key: 'new-platform-key'}, config.sections.llm.base_url)).toBe(false);
    expect(requiresPlatformKey({...draft.sections.llm, has_api_key: false}, config.sections.llm.base_url)).toBe(false);
  });

  it('allows paths and trailing slashes to change on the same origin', () => {
    const section = exampleConfig().sections.llm;
    expect(requiresPlatformKey({...section, base_url: 'https://custom.example/api/v2/'}, section.base_url)).toBe(false);
    expect(requiresPlatformKey({...section, base_url: 'https://custom.example:8443/v1'}, section.base_url)).toBe(true);
  });
});
