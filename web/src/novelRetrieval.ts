import type {AgentConfig, ConfigSection} from './types';

export type NovelRetrievalDraft = Pick<AgentConfig['sections'], 'embedding' | 'reranker'>;
export type NovelRetrievalMode = 'assistant' | 'api';

export function novelRetrievalMode(config?: AgentConfig): NovelRetrievalMode {
  return config?.novel_retrieval?.mode ?? 'assistant';
}

const retrievalSections = ['embedding', 'reranker'] as const;
const labels = {embedding: '文本向量模型', reranker: '检索排序模型'};

export function createNovelRetrievalDraft(config: AgentConfig): NovelRetrievalDraft {
  return {
    embedding: {...config.sections.embedding, api_key: ''},
    reranker: {...config.sections.reranker, api_key: ''},
  };
}

export function novelRetrievalStatus(config?: AgentConfig): {ready: boolean; label: string; missing: string[]} {
  if (!config) return {ready: false, label: '未读取', missing: []};
  if (novelRetrievalMode(config) === 'assistant') return {ready: true, label: '沿用创作助手', missing: []};
  const missing = retrievalSections.filter((section) => !config?.sections[section].has_api_key || !isHttpUrl(config.sections[section].base_url)).map((section) => labels[section]);
  return {ready: missing.length === 0, label: missing.length === 0 ? '检索 API · 已配置' : '检索 API · 待配置', missing};
}

export function validateNovelRetrievalDraft(draft: NovelRetrievalDraft, mode: NovelRetrievalMode): string {
  if (mode === 'assistant') return '';
  for (const section of retrievalSections) {
    if (!isHttpUrl(draft[section].base_url)) return `请填写${labels[section]}的有效服务地址，地址须以 http:// 或 https:// 开头。`;
    if (!draft[section].has_api_key && !draft[section].api_key.trim()) return `请填写${labels[section]}的接口密钥。`;
  }
  return '';
}

export function novelRetrievalSavePayload(draft: NovelRetrievalDraft, mode: NovelRetrievalMode) {
  if (mode === 'assistant') return {novel_retrieval: {mode}};
  const fields = (section: ConfigSection) => ({model: section.model, base_url: section.base_url, api_key: section.api_key});
  return {novel_retrieval: {mode}, sections: {
    embedding: {...fields(draft.embedding), ...(draft.embedding.model_provider === undefined ? {} : {model_provider: draft.embedding.model_provider})},
    reranker: fields(draft.reranker),
  }};
}

export function mergeConfigAfterNovelRetrieval(draftConfig: AgentConfig | undefined, previousConfig: AgentConfig | undefined, savedConfig: AgentConfig): AgentConfig {
  if (!draftConfig || !previousConfig) return savedConfig;
  const sections = {...savedConfig.sections};
  const editableFields: Array<keyof ConfigSection> = ['model', 'base_url', 'model_provider', 'api_provider', 'api_key'];
  for (const section of ['llm', 'image', 'video'] as const) {
    if (editableFields.some((field) => draftConfig.sections[section][field] !== previousConfig.sections[section][field])) sections[section] = {...draftConfig.sections[section], has_api_key: savedConfig.sections[section].has_api_key};
  }
  return {...savedConfig, sections};
}

export function isNovelRetrievalError(code?: string): boolean {
  return code === 'missing_novel_retrieval_config';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
  } catch { return false; }
}
