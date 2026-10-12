import {localizeRuntimeText} from './events';
import type {AgentConfig, ConfigSection} from './types';

export type ExecutorRole = 'assistant' | 'script' | 'storyboard' | 'vision' | 'image' | 'video';
export type ExecutorImageInput = 'unknown' | 'text_only' | 'vision';
export type ExecutorImageGeneration = 'unknown' | 'available' | 'unavailable';
export type ExecutorOption = {
  id: string; name: string; kind: 'api' | 'cli' | 'application' | 'custom';
  agentId?: string; executablePath?: string; fingerprint: string;
  adapterAvailable: boolean; imageTransport: boolean; imageInput: ExecutorImageInput; available: boolean;
  imageGeneration?: ExecutorImageGeneration; imageGenerationTransport?: boolean;
  mediaKind?: 'image' | 'video'; model?: string; baseUrl?: string; provider?: 'openrouter' | 'yunwu' | 'aliyun' | ''; hasApiKey?: boolean;
};
export type ExecutorRoles = Record<ExecutorRole, string>;
export type ExecutorSnapshot = {schemaVersion: 1; roles: ExecutorRoles; options: ExecutorOption[]};
export type ExecutorDraft = {roles: ExecutorRoles; imageInput: Record<string, ExecutorImageInput>; imageGeneration: Record<string, ExecutorImageGeneration>};
export type ExecutorSelectionDraft = {role: ExecutorRole; executorId: string; expectedFingerprint: string; config?: ConfigSection; imageInput?: ExecutorImageInput; imageGeneration?: ExecutorImageGeneration};
export type ExecutorSelectionResult = {executors: ExecutorSnapshot; config: AgentConfig};
export const DEFAULT_EXECUTOR_ROLES: ExecutorRoles = {assistant: 'api', script: 'inherit', storyboard: 'inherit', vision: 'api', image: 'image_api', video: 'video_api'};

export const EXECUTOR_ROLES: Array<{id: ExecutorRole; title: string; description: string; inherit?: boolean}> = [
  {id: 'assistant', title: '创作协调', description: '对话、任务拆分与创作协调'},
  {id: 'script', title: '剧本策划', description: '故事结构、场景与剧情', inherit: true},
  {id: 'storyboard', title: '分镜提示词', description: '镜头描述、运镜与画面提示词', inherit: true},
  {id: 'vision', title: '看图与审片', description: '默认需要文字与图片输入'},
  {id: 'image', title: '图像生成', description: '图像 API 或 Agent 的生图工具'},
  {id: 'video', title: '视频生成', description: '视频服务 API'},
];
export const EXECUTOR_KIND_LABELS: Record<ExecutorOption['kind'], string> = {
  api: '模型 API', cli: '命令行 Agent', application: '桌面与 IDE 应用', custom: '自定义 Agent',
};
export const EXECUTOR_IMAGE_LABELS: Record<ExecutorImageInput, string> = {
  unknown: '未确认', text_only: '仅文字', vision: '可读取图片',
};
export const EXECUTOR_GENERATION_LABELS: Record<ExecutorImageGeneration, string> = {
  unknown: '未确认', available: '可通过工具生图', unavailable: '不可生图',
};

export function normalizeExecutorSnapshot(snapshot: Omit<ExecutorSnapshot, 'roles'> & {roles: Partial<ExecutorRoles>}): ExecutorSnapshot {
  return {...snapshot, roles: {...DEFAULT_EXECUTOR_ROLES, ...snapshot.roles}};
}

async function executorRequest<T = ExecutorSnapshot>(method = 'GET', path = '', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/executors${path}`, {
      method, headers: {'Content-Type': 'application/json'}, cache: 'no-store',
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  } catch {
    throw new Error('无法连接本地服务，请稍后重试。当前执行者选择仍保留在草稿中。');
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error('执行者设置返回了无法识别的结果，请重新载入。'); }
  if (!response.ok) {
    const error = payload as {error?: string | {message?: string}; message?: string};
    throw new Error(localizeRuntimeText(typeof error.error === 'string' ? error.error : error.error?.message || error.message || `请求失败（HTTP ${response.status}）`));
  }
  return payload as T;
}
export const getExecutors = async () => normalizeExecutorSnapshot(await executorRequest());
export const scanExecutors = async () => normalizeExecutorSnapshot(await executorRequest('POST', '/scan', {}));
export const saveExecutors = async (snapshot: ExecutorSnapshot, draft: ExecutorDraft) => normalizeExecutorSnapshot(await executorRequest('PUT', '', executorSavePayload(snapshot, draft)));
export async function saveExecutorSelection(snapshot: ExecutorSnapshot, selection: ExecutorSelectionDraft): Promise<ExecutorSelectionResult> {
  const result = await executorRequest<ExecutorSelectionResult>('PUT', '/selection', executorSelectionPayload(snapshot, selection));
  return {...result, executors: normalizeExecutorSnapshot(result.executors)};
}

export function createExecutorSelection(snapshot: ExecutorSnapshot, role: ExecutorRole, executorId: string, config?: AgentConfig): ExecutorSelectionDraft {
  const option = snapshot.options.find((item) => item.id === executorId);
  const section = executorApiSection(option);
  return {role, executorId, expectedFingerprint: option?.fingerprint || '',
    ...(section && config ? {config: {...config.sections[section], api_key: ''}} : {}),
    ...(role === 'vision' && option ? {imageInput: option.imageInput || 'unknown'} : {}),
    ...(role === 'image' && option?.kind === 'cli' ? {imageGeneration: option.imageGeneration || 'unknown'} : {}),
  };
}

export function updateExecutorSelectionConfig(selection: ExecutorSelectionDraft, config: ConfigSection): ExecutorSelectionDraft {
  const previous = selection.config;
  const identityChanged = previous && (previous.model !== config.model || previous.base_url !== config.base_url || previous.model_provider !== config.model_provider || previous.api_provider !== config.api_provider);
  return {...selection, config, ...(identityChanged && selection.role === 'vision' ? {imageInput: 'unknown' as const} : {})};
}

export function executorSelectionPayload(snapshot: ExecutorSnapshot, selection: ExecutorSelectionDraft) {
  const option = snapshot.options.find((item) => item.id === selection.executorId);
  const section = executorApiSection(option);
  const fields = selection.config;
  const config = fields && section ? {
    model: fields.model, base_url: fields.base_url, api_key: fields.api_key,
    ...(section === 'llm' ? {model_provider: fields.model_provider} : {api_provider: fields.api_provider}),
  } : undefined;
  return {role: selection.role, executorId: selection.executorId, expectedFingerprint: selection.expectedFingerprint,
    ...(section && config ? {config: {[section]: config}} : {}),
    ...(selection.role === 'vision' && selection.imageInput !== undefined ? {imageInput: selection.imageInput} : {}),
    ...(selection.role === 'image' && option?.kind === 'cli' && selection.imageGeneration !== undefined ? {imageGeneration: selection.imageGeneration} : {}),
  };
}

export function validateExecutorSelection(snapshot: ExecutorSnapshot, selection: ExecutorSelectionDraft): string {
  if (selection.executorId === 'inherit' && (selection.role === 'script' || selection.role === 'storyboard')) return '';
  const option = executorOptionsForRole(selection.role, snapshot.options).find((item) => item.id === selection.executorId);
  if (!option) return '该执行者未检测到，请重新选择。';
  if (option.fingerprint !== selection.expectedFingerprint) return '该执行者配置已变化，请重新选择后保存。';
  if (selection.role === 'vision' && (selection.imageInput === 'text_only' || (option.adapterAvailable && !option.imageTransport))) return '看图与审片需要图片输入，请改选支持看图的执行者。';
  if (selection.role === 'image' && option.kind !== 'api' && selection.imageGeneration === 'unavailable') return '该 Agent 已声明不可生图，请选择其他 Agent 或图像API。';
  return '';
}

export function orderedExecutorOptions(role: ExecutorRole, options: ExecutorOption[]): ExecutorOption[] {
  const score = (option: ExecutorOption) => option.adapterAvailable && option.available && (role !== 'image' || option.kind === 'api' || option.imageGenerationTransport) && (role !== 'vision' || option.imageTransport) ? 0 : 1;
  return executorOptionsForRole(role, options).map((option, index) => ({option, index})).sort((a, b) => score(a.option) - score(b.option) || a.index - b.index).map(({option}) => option);
}

/** A single-role save replaces its API section while preserving unrelated management drafts. */
export function mergeConfigAfterSelection(draft: AgentConfig | undefined, previous: AgentConfig | undefined, saved: AgentConfig, touchedSection?: 'llm' | 'image' | 'video'): AgentConfig {
  if (!draft || !previous) return saved;
  const sections = {...saved.sections};
  for (const section of Object.keys(sections) as Array<keyof AgentConfig['sections']>) {
    const fields: Array<keyof ConfigSection> = ['model', 'base_url', 'model_provider', 'api_provider', 'api_key'];
    if (section !== touchedSection && fields.some((field) => draft.sections[section][field] !== previous.sections[section][field])) sections[section] = {...draft.sections[section], has_api_key: saved.sections[section].has_api_key};
  }
  return {...saved, sections};
}

export function roleForConfigurationError(code?: string): ExecutorRole | undefined {
  if (!code) return undefined;
  if (code.includes('vision') || code === 'executor_image_transport_unavailable') return 'vision';
  if (code.includes('image_generation') || code.startsWith('imagegen_') || ['missing_image_api_key', 'unsupported_image_provider', 'executor_image_failed', 'executor_invalid_image'].includes(code)) return 'image';
  if (code === 'missing_video_api_key' || code.startsWith('video_') || code === 'unsupported_video_provider') return 'video';
  if (code === 'missing_llm_api_key' || code.startsWith('llm_')) return 'assistant';
  return undefined;
}

export function executorDraft(snapshot: ExecutorSnapshot): ExecutorDraft {
  return {roles: {...DEFAULT_EXECUTOR_ROLES, ...snapshot.roles}, imageInput: Object.fromEntries(snapshot.options.map((option) => [option.id, option.imageInput || 'unknown'])), imageGeneration: Object.fromEntries(snapshot.options.map((option) => [option.id, option.id === 'image_api' ? 'available' : option.imageGeneration || 'unknown']))};
}

export function effectiveExecutorId(role: ExecutorRole, roles: ExecutorRoles): string {
  return (role === 'script' || role === 'storyboard') && roles[role] === 'inherit' ? roles.assistant : roles[role];
}

export function executorDeclaredInput(option: ExecutorOption, draft: ExecutorDraft): ExecutorImageInput {
  return draft.imageInput[option.id] || option.imageInput || 'unknown';
}

export function canSelectVisionExecutor(option: ExecutorOption, draft: ExecutorDraft): boolean {
  return executorDeclaredInput(option, draft) !== 'text_only' && !(option.adapterAvailable && !option.imageTransport);
}

export function executorDeclaredGeneration(option: ExecutorOption, draft: ExecutorDraft): ExecutorImageGeneration {
  return option.id === 'image_api' ? 'available' : draft.imageGeneration[option.id] || option.imageGeneration || 'unknown';
}

export function executorOptionsForRole(role: ExecutorRole, options: ExecutorOption[]): ExecutorOption[] {
  if (role === 'video') return options.filter((option) => option.id === 'video_api' && option.kind === 'api');
  if (role === 'image') return options.filter((option) => option.kind !== 'api' || option.id === 'image_api');
  return options.filter((option) => option.kind !== 'api' || option.id === 'api');
}

export function canSelectImageExecutor(option: ExecutorOption, draft: ExecutorDraft): boolean {
  return executorDeclaredGeneration(option, draft) !== 'unavailable';
}

export function executorApiSummary(option: ExecutorOption): string {
  const provider = option.provider === 'openrouter' ? 'OpenRouter' : option.provider === 'yunwu' ? '云雾' : option.provider === 'aliyun' ? '阿里云百炼' : '未选择平台';
  let host = '';
  try { host = option.baseUrl ? new URL(option.baseUrl).hostname : ''; } catch { /* Do not expose an arbitrary invalid URL in the compact summary. */ }
  if (option.id === 'api' && !option.model && !option.baseUrl && option.hasApiKey === undefined) return '使用创作助手接口配置';
  return [option.id === 'api' ? '' : provider, host, option.model || '未设置模型', option.hasApiKey === undefined ? '' : option.hasApiKey ? '密钥已配置' : '密钥未配置'].filter(Boolean).join(' · ');
}

export function executorApiSection(option?: ExecutorOption): 'llm' | 'image' | 'video' | undefined {
  return option?.kind === 'api' ? option.id === 'api' ? 'llm' : option.id === 'image_api' ? 'image' : option.id === 'video_api' ? 'video' : undefined : undefined;
}

export function executorOptionLabel(option: ExecutorOption, role: ExecutorRole, draft: ExecutorDraft): string {
  const suffix: string[] = [];
  if (!option.adapterAvailable) suffix.push('待适配');
  if (!option.available) suffix.push('未就绪');
  if (role === 'vision' && executorDeclaredInput(option, draft) === 'text_only') suffix.push('仅文字');
  else if (role === 'vision' && option.adapterAvailable && !option.imageTransport) suffix.push('暂不能传图');
  if (role === 'image' && executorDeclaredGeneration(option, draft) === 'unavailable') suffix.push('不可生图');
  else if (role === 'image' && option.kind !== 'api' && option.adapterAvailable && !option.imageGenerationTransport) suffix.push('生图待适配');
  const name = option.id === 'api' ? '模型API' : option.id === 'image_api' ? '图像API' : option.id === 'video_api' ? '视频API' : option.name;
  return suffix.length ? `${name} · ${suffix.join(' · ')}` : name;
}

export function executorRoleStatus(role: ExecutorRole, snapshot: ExecutorSnapshot, draft: ExecutorDraft): {label: string; message: string; tone: 'ready' | 'pending' | 'warning'} {
  const option = snapshot.options.find((item) => item.id === effectiveExecutorId(role, draft.roles));
  if (!option) return {label: '未检测到', message: '请重新检测或改选。', tone: 'warning'};
  if (role === 'image' && option.kind !== 'api') {
    const generation = executorDeclaredGeneration(option, draft);
    if (generation === 'unavailable') return {label: '不可生图', message: '请改选图像API或有生图工具的Agent。', tone: 'warning'};
    if (!option.adapterAvailable || !option.imageGenerationTransport) return {label: '待适配', message: '可保存选择，尚不能自动执行生图。', tone: 'pending'};
    if (!option.available) return {label: '未就绪', message: '请检查安装与登录。', tone: 'warning'};
    if (generation === 'unknown') return {label: '待确认生图', message: '请确认下方生图工具能力。', tone: 'warning'};
    return {label: '已声明生图', message: '', tone: 'ready'};
  }
  if ((role === 'image' || role === 'video') && option.kind === 'api') {
    if (option.hasApiKey === false) return {label: '密钥未配置', message: '请展开配置接口填写密钥。', tone: 'warning'};
    if (option.provider !== 'openrouter' && option.provider !== 'yunwu' && !(role === 'video' && option.provider === 'aliyun')) return {label: '协议待设置', message: '请选择支持的接口平台协议。', tone: 'warning'};
    if (option.hasApiKey !== true) return {label: '接口待确认', message: '请检查密钥配置状态。', tone: 'warning'};
    if (!option.adapterAvailable || !option.available) return {label: '接口未就绪', message: '请检查模型与接口配置。', tone: 'warning'};
    return {label: '接口已配置', message: '', tone: 'ready'};
  }
  if (option.kind === 'api' && option.hasApiKey === false) return {label: '密钥未配置', message: '请展开配置接口填写密钥。', tone: 'warning'};
  if (!option.adapterAvailable) return {label: '待适配', message: '可保存选择，尚不能自动执行。', tone: 'pending'};
  if (!option.available) return {label: '未就绪', message: option.kind === 'api' ? '请配置接口。' : '请检查安装与登录。', tone: 'warning'};
  if (role === 'vision') {
    if (!option.imageTransport) return {label: '暂不能传图', message: '请改选支持图片输入的执行者。', tone: 'warning'};
    const input = executorDeclaredInput(option, draft);
    if (input === 'text_only') return {label: '仅文字', message: '看图需要图片输入，请改选。', tone: 'warning'};
    if (input === 'unknown') return {label: '待确认视觉', message: '请确认下方图片输入能力。', tone: 'warning'};
    return {label: '已声明视觉', message: '', tone: 'ready'};
  }
  return {label: '已适配调用', message: '', tone: 'ready'};
}

export function isExecutorDraftDirty(snapshot: ExecutorSnapshot, draft: ExecutorDraft): boolean {
  return EXECUTOR_ROLES.some((role) => snapshot.roles[role.id] !== draft.roles[role.id])
    || snapshot.options.some((option) => (option.imageInput || 'unknown') !== executorDeclaredInput(option, draft)
      || (option.id === 'image_api' ? 'available' : option.imageGeneration || 'unknown') !== executorDeclaredGeneration(option, draft));
}

export function validateExecutorDraft(snapshot: ExecutorSnapshot, draft: ExecutorDraft): string {
  for (const role of EXECUTOR_ROLES) {
    const id = effectiveExecutorId(role.id, draft.roles);
    if (!snapshot.options.some((option) => option.id === id)) return `“${role.title}”所选执行者未检测到，请重新检测或改选。`;
    if (!executorOptionsForRole(role.id, snapshot.options).some((option) => option.id === id)) return `“${role.title}”不能使用所选接口，请选择对应的执行者或生成服务 API。`;
  }
  const vision = snapshot.options.find((option) => option.id === draft.roles.vision)!;
  if (!canSelectVisionExecutor(vision, draft)) return '“看图与审片”需要图片输入，不能保存仅文字或无法传图的执行者，请改选。';
  const image = snapshot.options.find((option) => option.id === draft.roles.image)!;
  if (!canSelectImageExecutor(image, draft)) return '“图像生成”所选 Agent 已声明不可生图，请改选图像 API 或有生图工具的 Agent。';
  return '';
}

export function executorSavePayload(snapshot: ExecutorSnapshot, draft: ExecutorDraft) {
  return {roles: {...draft.roles}, imageInput: Object.fromEntries(snapshot.options.map((option) => [option.id, executorDeclaredInput(option, draft)])), imageGeneration: Object.fromEntries(snapshot.options.map((option) => [option.id, executorDeclaredGeneration(option, draft)])), fingerprints: Object.fromEntries(snapshot.options.map((option) => [option.id, option.fingerprint]))};
}

/** Scans replace discovery metadata while preserving the latest unsaved choices. */
export function reconcileExecutorScan(previous: ExecutorSnapshot, next: ExecutorSnapshot, draft: ExecutorDraft, keepDraft: boolean): {snapshot: ExecutorSnapshot; draft: ExecutorDraft; reconfirmedIds: string[]} {
  const working = keepDraft ? draft : executorDraft(next);
  const oldOptions = new Map(previous.options.map((option) => [option.id, option]));
  const options = [...next.options];
  const retained = new Set(Object.values(working.roles).filter((id) => id !== 'inherit'));
  for (const id of retained) {
    if (options.some((option) => option.id === id)) continue;
    const old = oldOptions.get(id);
    if (old) options.push({...old, available: false, imageInput: 'unknown', imageGeneration: 'unknown'});
  }
  const inputs: Record<string, ExecutorImageInput> = {};
  const generation: Record<string, ExecutorImageGeneration> = {};
  const reconfirmedIds: string[] = [];
  for (const option of options) {
    const old = oldOptions.get(option.id);
    const changed = !!old && (old.fingerprint !== option.fingerprint || !next.options.some((item) => item.id === option.id));
    if (changed) {
      inputs[option.id] = 'unknown';
      generation[option.id] = option.id === 'image_api' ? 'available' : 'unknown';
      if ((draft.imageInput[option.id] && draft.imageInput[option.id] !== 'unknown') || (option.id !== 'image_api' && draft.imageGeneration[option.id] && draft.imageGeneration[option.id] !== 'unknown')) reconfirmedIds.push(option.id);
    } else {
      inputs[option.id] = working.imageInput[option.id] || option.imageInput || 'unknown';
      generation[option.id] = option.id === 'image_api' ? 'available' : working.imageGeneration[option.id] || option.imageGeneration || 'unknown';
    }
  }
  return {snapshot: {...next, options}, draft: {roles: {...working.roles}, imageInput: inputs, imageGeneration: generation}, reconfirmedIds};
}
