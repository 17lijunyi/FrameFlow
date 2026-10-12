import {describe, expect, it} from 'vitest';
import {createNovelRetrievalDraft, isNovelRetrievalError, mergeConfigAfterNovelRetrieval, novelRetrievalMode, novelRetrievalSavePayload, novelRetrievalStatus, validateNovelRetrievalDraft} from './novelRetrieval';
import type {AgentConfigSaveInput} from './api';
import type {AgentConfig, ConfigSection} from './types';

function config(): AgentConfig {
  const section: ConfigSection = {model: '', base_url: 'https://retrieval.example/v1', api_key: '', has_api_key: true};
  return {novel_retrieval: {mode: 'api'}, sections: {llm: {...section, model_provider: 'openai'}, image: {...section}, video: {...section}, embedding: {...section, model_provider: 'openai'}, reranker: {...section}}};
}

describe('novel retrieval draft and validation', () => {
  it('uses the assistant by default without requiring dedicated retrieval credentials', () => {
    const saved = config();
    delete saved.novel_retrieval;
    for (const section of ['embedding', 'reranker'] as const) { saved.sections[section].base_url = ''; saved.sections[section].has_api_key = false; }
    expect(novelRetrievalMode(saved)).toBe('assistant');
    expect(novelRetrievalStatus(saved)).toEqual({ready: true, label: '沿用创作助手', missing: []});
    expect(validateNovelRetrievalDraft(createNovelRetrievalDraft(saved), 'assistant')).toBe('');
  });
  it('copies only the two retrieval sections and clears key drafts without changing the source', () => {
    const saved = config();
    saved.sections.embedding.api_key = 'embedding-draft';
    saved.sections.reranker.api_key = 'reranker-draft';
    const draft = createNovelRetrievalDraft(saved);
    expect(Object.keys(draft)).toEqual(['embedding', 'reranker']);
    expect(draft.embedding.api_key).toBe('');
    expect(draft.reranker.api_key).toBe('');
    expect(draft.embedding.has_api_key).toBe(true);
    draft.embedding.base_url = 'https://other.example/v1';
    expect(saved.sections.embedding.base_url).toBe('https://retrieval.example/v1');
    expect(saved.sections.embedding.api_key).toBe('embedding-draft');
  });

  it('marks services ready using saved key metadata and HTTP addresses, allowing runtime model defaults', () => {
    const saved = config();
    expect(novelRetrievalStatus(saved)).toEqual({ready: true, label: '检索 API · 已配置', missing: []});
    saved.sections.embedding.has_api_key = false;
    saved.sections.embedding.api_key = 'unsaved-key';
    saved.sections.reranker.base_url = '';
    expect(novelRetrievalStatus(saved)).toEqual({ready: false, label: '检索 API · 待配置', missing: ['文本向量模型', '检索排序模型']});
    expect(novelRetrievalStatus()).toEqual({ready: false, label: '未读取', missing: []});
  });

  it('allows blank model names and either existing key metadata or a new key draft', () => {
    const draft = createNovelRetrievalDraft(config());
    expect(validateNovelRetrievalDraft(draft, 'api')).toBe('');
    draft.embedding.has_api_key = false;
    expect(validateNovelRetrievalDraft(draft, 'api')).toContain('文本向量模型的接口密钥');
    draft.embedding.api_key = '  ';
    expect(validateNovelRetrievalDraft(draft, 'api')).not.toBe('');
    draft.embedding.api_key = 'new-key';
    draft.reranker.base_url = 'http://localhost:8000/v1';
    expect(validateNovelRetrievalDraft(draft, 'api')).toBe('');
  });

  it('rejects absent, malformed and non-HTTP service addresses with the affected service named', () => {
    for (const url of ['', 'not-a-url', 'ftp://retrieval.example', 'javascript:alert(1)']) {
      const draft = createNovelRetrievalDraft(config());
      draft.reranker.base_url = url;
      expect(validateNovelRetrievalDraft(draft, 'api')).toContain('检索排序模型的有效服务地址');
    }
    const draft = createNovelRetrievalDraft(config());
    draft.embedding.base_url = ' https://retrieval.example/v1 ';
    expect(validateNovelRetrievalDraft(draft, 'api')).toBe('');
  });
});

describe('isolated novel retrieval save', () => {
  it('saves only the mode when choosing the assistant, leaving API credentials and drafts untouched', () => {
    const draft = createNovelRetrievalDraft(config());
    draft.embedding.api_key = 'unsaved-embedding';
    draft.reranker.base_url = 'invalid-unsaved-url';
    expect(novelRetrievalSavePayload(draft, 'assistant')).toEqual({novel_retrieval: {mode: 'assistant'}});
    expect(draft.embedding.api_key).toBe('unsaved-embedding');
  });
  it('sends only allowed fields for two sections, excluding key metadata and unrelated provider fields', () => {
    const draft = createNovelRetrievalDraft(config());
    draft.embedding.api_key = 'new-embedding-key';
    draft.embedding.api_provider = 'unsupported-extra-field';
    draft.reranker.model_provider = 'unsupported-extra-field';
    draft.reranker.api_provider = 'unsupported-extra-field';
    const payload: AgentConfigSaveInput = novelRetrievalSavePayload(draft, 'api');
    expect(payload).toEqual({novel_retrieval: {mode: 'api'}, sections: {
      embedding: {model: '', base_url: 'https://retrieval.example/v1', api_key: 'new-embedding-key', model_provider: 'openai'},
      reranker: {model: '', base_url: 'https://retrieval.example/v1', api_key: ''},
    }});
    expect(JSON.stringify(payload)).not.toContain('has_api_key');
    expect(Object.keys(payload.sections!)).toEqual(['embedding', 'reranker']);
  });

  it('updates both retrieval sections while preserving unrelated drafts and refreshing saved key metadata', () => {
    const previous = config(), draft = config(), saved = config();
    draft.sections.llm.model = 'unsaved-llm';
    draft.sections.image.api_key = 'unsaved-image-key';
    draft.sections.embedding.model = 'stale-embedding';
    draft.sections.reranker.model = 'stale-reranker';
    saved.sections.llm.has_api_key = false;
    saved.sections.video.model = 'server-video';
    saved.sections.embedding.model = 'saved-embedding';
    saved.sections.reranker.model = 'saved-reranker';
    const merged = mergeConfigAfterNovelRetrieval(draft, previous, saved);
    expect(merged.sections.llm).toMatchObject({model: 'unsaved-llm', has_api_key: false});
    expect(merged.sections.image.api_key).toBe('unsaved-image-key');
    expect(merged.sections.video).toEqual(saved.sections.video);
    expect(merged.sections.embedding).toEqual(saved.sections.embedding);
    expect(merged.sections.reranker).toEqual(saved.sections.reranker);
    expect(merged.novel_retrieval).toEqual(saved.novel_retrieval);
    expect(draft.sections.embedding.model).toBe('stale-embedding');
    expect(mergeConfigAfterNovelRetrieval(undefined, previous, saved)).toBe(saved);
  });

  it('recognizes only the explicit missing-retrieval configuration error', () => {
    expect(isNovelRetrievalError('missing_novel_retrieval_config')).toBe(true);
    for (const code of [undefined, 'missing_llm_api_key', 'novel_render_failed', 'missing_novel_retrieval_config_extra']) expect(isNovelRetrievalError(code)).toBe(false);
  });
});
