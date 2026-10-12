import {describe, expect, it} from 'vitest';
import {canSelectImageExecutor, canSelectVisionExecutor, DEFAULT_EXECUTOR_ROLES, effectiveExecutorId, executorApiSection, executorApiSummary, executorDeclaredGeneration, executorDraft, executorOptionLabel, executorOptionsForRole, executorRoleStatus, executorSavePayload, isExecutorDraftDirty, normalizeExecutorSnapshot, reconcileExecutorScan, validateExecutorDraft} from './executors';
import type {ExecutorOption, ExecutorSnapshot} from './executors';
import {createExecutorSelection, executorSelectionPayload, mergeConfigAfterSelection, orderedExecutorOptions, roleForConfigurationError, updateExecutorSelectionConfig, validateExecutorSelection} from './executors';
import type {AgentConfig} from './types';

function option(overrides: Partial<ExecutorOption> = {}): ExecutorOption {
  return {id: 'api', name: '模型 API', kind: 'api', fingerprint: 'api-current', adapterAvailable: true, imageTransport: true, imageInput: 'unknown', available: true, ...overrides};
}
function snapshot(options: ExecutorOption[] = [option(), option({id: 'cli:pi', name: 'Pi', kind: 'cli', fingerprint: 'pi-current', adapterAvailable: false, imageTransport: false})]): ExecutorSnapshot {
  return {schemaVersion: 1, roles: {...DEFAULT_EXECUTOR_ROLES}, options: [...options,
    option({id: 'image_api', name: '图像API', mediaKind: 'image', fingerprint: 'image-current', imageGeneration: 'available', imageGenerationTransport: true}),
    option({id: 'video_api', name: '视频API', mediaKind: 'video', fingerprint: 'video-current'}),
  ]};
}

describe('executor role selection', () => {
  it('inherits only script/storyboard coordination and preserves an explicitly selected vision executor', () => {
    const roles = {...snapshot().roles, assistant: 'cli:pi', storyboard: 'api'};
    expect(effectiveExecutorId('script', roles)).toBe('cli:pi');
    expect(effectiveExecutorId('storyboard', roles)).toBe('api');
    expect(effectiveExecutorId('vision', roles)).toBe('api');
  });

  it('does not infer visual input from a product name or an adapted image transport, including API', () => {
    const saved = snapshot([option({name: '视觉 Agent'})]);
    const draft = executorDraft(saved);
    expect(draft.imageInput.api).toBe('unknown');
    expect(executorRoleStatus('vision', saved, draft)).toMatchObject({label: '待确认视觉', tone: 'warning'});
    expect(canSelectVisionExecutor(saved.options[0], draft)).toBe(true);
    expect(executorRoleStatus('vision', saved, {...draft, imageInput: {api: 'vision'}})).toMatchObject({label: '已声明视觉'});
  });

  it('keeps text-only executors usable for text roles and rejects them only for vision selection/save', () => {
    const saved = snapshot([option({imageInput: 'text_only'})]);
    const draft = executorDraft(saved);
    expect(executorRoleStatus('assistant', saved, draft).label).toBe('已适配调用');
    expect(executorRoleStatus('script', saved, draft).label).toBe('已适配调用');
    expect(canSelectVisionExecutor(saved.options[0], draft)).toBe(false);
    expect(validateExecutorDraft(saved, draft)).toContain('不能保存');
  });

  it('allows saving a pending discovered agent without claiming it can execute or silently changing the selection', () => {
    const saved = snapshot();
    const draft = {...executorDraft(saved), roles: {...saved.roles, assistant: 'cli:pi', vision: 'cli:pi'}};
    expect(validateExecutorDraft(saved, draft)).toBe('');
    expect(canSelectVisionExecutor(saved.options[1], draft)).toBe(true);
    expect(executorRoleStatus('vision', saved, draft)).toMatchObject({label: '待适配', tone: 'pending'});
    expect(executorOptionLabel(saved.options[1], 'assistant', draft)).toContain('待适配');
    expect(draft.roles.assistant).toBe('cli:pi');
  });

  it('rejects an adapted executor without image transport even after the user declares a visual model', () => {
    const saved = snapshot([option({imageTransport: false, imageInput: 'vision'})]);
    const draft = executorDraft(saved);
    expect(canSelectVisionExecutor(saved.options[0], draft)).toBe(false);
    expect(validateExecutorDraft(saved, draft)).toContain('无法传图');
  });
});

describe('executor save payload and dirty state', () => {
  it('sends role choices, explicit declarations and detection fingerprints without sending paths or settings credentials', () => {
    const saved = snapshot([option({executablePath: '/opt/homebrew/bin/agent'})]);
    const draft = {...executorDraft(saved), imageInput: {api: 'vision' as const}};
    const payload = executorSavePayload(saved, draft);
    expect(payload).toEqual({roles: saved.roles, imageInput: {api: 'vision', image_api: 'unknown', video_api: 'unknown'}, imageGeneration: {api: 'unknown', image_api: 'available', video_api: 'unknown'}, fingerprints: {api: 'api-current', image_api: 'image-current', video_api: 'video-current'}});
    expect(JSON.stringify(payload)).not.toContain('/opt/homebrew');
    expect(isExecutorDraftDirty(saved, draft)).toBe(true);
    expect(isExecutorDraftDirty(saved, executorDraft(saved))).toBe(false);
  });

  it('does not substitute API when a saved or draft executor is absent', () => {
    const saved = snapshot();
    const draft = {...executorDraft(saved), roles: {...saved.roles, assistant: 'removed-agent'}};
    expect(validateExecutorDraft(saved, draft)).toContain('创作协调');
    expect(executorRoleStatus('assistant', saved, draft).label).toBe('未检测到');
    expect(draft.roles.assistant).toBe('removed-agent');
  });
});

describe('separate generation roles', () => {
  it('normalizes legacy four-role snapshots to distinct image and video APIs without changing text choices', () => {
    const saved = snapshot();
    const next = normalizeExecutorSnapshot({...saved, roles: {assistant: 'cli:pi', script: 'inherit', storyboard: 'api', vision: 'api'}});
    expect(next.roles).toEqual({...DEFAULT_EXECUTOR_ROLES, assistant: 'cli:pi', storyboard: 'api'});
    expect(executorApiSection(saved.options[0])).toBe('llm');
    expect(executorApiSection(saved.options.find((item) => item.id === 'image_api'))).toBe('image');
    expect(executorApiSection(saved.options.find((item) => item.id === 'video_api'))).toBe('video');
  });

  it('keeps video generation on its dedicated API while keeping media APIs out of text roles', () => {
    const saved = snapshot();
    expect(executorOptionsForRole('assistant', saved.options).map((item) => item.id)).toEqual(['api', 'cli:pi']);
    expect(executorOptionsForRole('image', saved.options).map((item) => item.id)).toEqual(['cli:pi', 'image_api']);
    expect(executorOptionsForRole('video', saved.options).map((item) => item.id)).toEqual(['video_api']);
    const draft = executorDraft(saved);
    expect(validateExecutorDraft(saved, {...draft, roles: {...draft.roles, image: 'api'}})).toContain('图像生成');
    expect(validateExecutorDraft(saved, {...draft, roles: {...draft.roles, video: 'cli:pi'}})).toContain('视频生成');
    expect(validateExecutorDraft(saved, {...draft, roles: {...draft.roles, video: 'image_api'}})).toContain('视频生成');
  });

  it('allows text-only Agents to generate through declared tools without claiming they can read images', () => {
    const saved = snapshot([option(), option({id: 'cli:pi', name: 'Pi', kind: 'cli', imageInput: 'text_only', imageGeneration: 'available', imageGenerationTransport: true})]);
    const draft = {...executorDraft(saved), roles: {...saved.roles, image: 'cli:pi'}};
    expect(canSelectVisionExecutor(saved.options[1], draft)).toBe(false);
    expect(canSelectImageExecutor(saved.options[1], draft)).toBe(true);
    expect(executorRoleStatus('image', saved, draft)).toMatchObject({label: '已声明生图', tone: 'ready'});
    expect(validateExecutorDraft(saved, draft)).toBe('');
    expect(draft.imageInput['cli:pi']).toBe('text_only');
  });

  it('does not infer image generation from visual input or override an unavailable declaration', () => {
    const saved = snapshot([option(), option({id: 'cli:pi', name: 'Pi', kind: 'cli', imageInput: 'vision', imageGenerationTransport: true})]);
    const draft = {...executorDraft(saved), roles: {...saved.roles, image: 'cli:pi'}};
    expect(executorDeclaredGeneration(saved.options[1], draft)).toBe('unknown');
    expect(executorRoleStatus('image', saved, draft).label).toBe('待确认生图');
    const unavailable = {...draft, imageGeneration: {...draft.imageGeneration, 'cli:pi': 'unavailable' as const}};
    expect(canSelectImageExecutor(saved.options[1], unavailable)).toBe(false);
    expect(validateExecutorDraft(saved, unavailable)).toContain('不可生图');
    expect(executorDeclaredGeneration(saved.options.find((item) => item.id === 'image_api')!, draft)).toBe('available');
  });

  it('keeps detected Agents selectable for image while declaring unavailable generation adapters pending', () => {
    const saved = snapshot([option(), option({id: 'cli:pi', name: 'Pi', kind: 'cli', imageGeneration: 'available', imageGenerationTransport: false})]);
    const draft = {...executorDraft(saved), roles: {...saved.roles, image: 'cli:pi'}};
    expect(validateExecutorDraft(saved, draft)).toBe('');
    expect(executorRoleStatus('image', saved, draft)).toMatchObject({label: '待适配', tone: 'pending'});
    expect(executorOptionLabel(saved.options[1], 'image', draft)).toContain('待适配');
  });

  it('resets both independent Agent declarations when its fingerprint changes while preserving selected roles', () => {
    const agent = option({id: 'cli:pi', name: 'Pi', kind: 'cli', fingerprint: 'old', imageInput: 'vision', imageGeneration: 'available', imageGenerationTransport: true});
    const previous = snapshot([option(), agent]);
    const draft = {...executorDraft(previous), roles: {...previous.roles, image: 'cli:pi', vision: 'cli:pi'}};
    const next = snapshot([option(), {...agent, fingerprint: 'new'}]);
    const result = reconcileExecutorScan(previous, next, draft, true);
    expect(result.draft.roles).toEqual(draft.roles);
    expect(result.draft.imageInput['cli:pi']).toBe('unknown');
    expect(result.draft.imageGeneration['cli:pi']).toBe('unknown');
    expect(result.reconfirmedIds).toEqual(['cli:pi']);
    expect(result.draft.imageGeneration.image_api).toBe('available');
  });

  it('uses saved model/platform/key-state metadata for API summaries without exposing URL credentials', () => {
    const value = option({id: 'image_api', provider: 'yunwu', model: 'image-model', baseUrl: 'https://user:secret@compatible.example/path?key=secret', hasApiKey: true});
    expect(executorApiSummary(value)).toBe('云雾 · compatible.example · image-model · 密钥已配置');
    expect(executorOptionLabel(value, 'image', executorDraft(snapshot()))).toBe('图像API');
    expect(executorApiSummary({...value, id: 'video_api', provider: 'aliyun', model: 'wan2.6-i2v-flash'}))
      .toBe('阿里云百炼 · compatible.example · wan2.6-i2v-flash · 密钥已配置');
  });

  it.each([
    {role: 'video' as const, hasApiKey: true, adapterAvailable: true, model: 'wan2.6-i2v-flash', label: '接口已配置', tone: 'ready'},
    {role: 'video' as const, hasApiKey: false, adapterAvailable: true, model: 'wan2.6-i2v-flash', label: '密钥未配置', tone: 'warning'},
    {role: 'video' as const, hasApiKey: true, adapterAvailable: false, model: 'unsupported-wan-model', label: '接口未就绪', tone: 'warning'},
    {role: 'image' as const, hasApiKey: true, adapterAvailable: true, model: 'wan2.6-i2v-flash', label: '协议待设置', tone: 'warning'},
  ])('shows Aliyun $role readiness as $label without treating it as an image platform', ({role, hasApiKey, adapterAvailable, model, label, tone}) => {
    const base = snapshot();
    const saved = {...base, options: base.options.map((item) => item.id === `${role}_api`
      ? {...item, provider: 'aliyun' as const, model, hasApiKey, adapterAvailable} : item)};
    expect(executorRoleStatus(role, saved, executorDraft(saved))).toMatchObject({label, tone});
  });

  it('marks media APIs ready only after key, supported protocol and adapter readiness are confirmed', () => {
    const base = snapshot();
    function status(overrides: Partial<ExecutorOption>) {
      const saved = {...base, options: base.options.map((item) => item.id === 'image_api' ? {...item, provider: 'openrouter' as const, hasApiKey: true, ...overrides} : item)};
      return executorRoleStatus('image', saved, executorDraft(saved));
    }
    expect(status({hasApiKey: false})).toMatchObject({label: '密钥未配置', tone: 'warning'});
    expect(status({provider: ''})).toMatchObject({label: '协议待设置', tone: 'warning'});
    expect(status({hasApiKey: undefined})).toMatchObject({label: '接口待确认', tone: 'warning'});
    expect(status({adapterAvailable: false})).toMatchObject({label: '接口未就绪', tone: 'warning'});
    expect(status({available: false})).toMatchObject({label: '接口未就绪', tone: 'warning'});
    expect(status({})).toMatchObject({label: '接口已配置', tone: 'ready'});
    const text = snapshot([option({hasApiKey: false})]);
    expect(executorRoleStatus('assistant', text, executorDraft(text))).toMatchObject({label: '密钥未配置', tone: 'warning'});
  });
});

describe('executor discovery reconciliation', () => {
  it('preserves the latest dirty roles and explicit visual declarations while updating discovery metadata', () => {
    const previous = snapshot();
    const draft = {...executorDraft(previous), roles: {...previous.roles, assistant: 'cli:pi'}, imageInput: {...executorDraft(previous).imageInput, api: 'vision' as const}};
    const next = snapshot([option(), {...previous.options[1], name: 'Pi · 已更新'}]);
    const result = reconcileExecutorScan(previous, next, draft, true);
    expect(result.draft.roles.assistant).toBe('cli:pi');
    expect(result.draft.imageInput.api).toBe('vision');
    expect(result.snapshot.options[1].name).toBe('Pi · 已更新');
    expect(isExecutorDraftDirty(result.snapshot, result.draft)).toBe(true);
    expect(previous.options[1].name).toBe('Pi');
  });

  it('clears old image capability declarations when detection fingerprints change, even for a clean draft', () => {
    const previous = snapshot([option({imageInput: 'vision'})]);
    const next = snapshot([option({imageInput: 'vision', fingerprint: 'new-installation'})]);
    for (const keepDraft of [true, false]) {
      const result = reconcileExecutorScan(previous, next, executorDraft(previous), keepDraft);
      expect(result.draft.imageInput.api).toBe('unknown');
      expect(result.reconfirmedIds).toEqual(['api']);
      expect(executorRoleStatus('vision', result.snapshot, result.draft).label).toBe('待确认视觉');
    }
  });

  it('retains a disappearing selected option as unavailable instead of replacing the user choice', () => {
    const previous = snapshot();
    const draft = {...executorDraft(previous), roles: {...previous.roles, assistant: 'cli:pi'}};
    const result = reconcileExecutorScan(previous, snapshot([option()]), draft, true);
    expect(result.draft.roles.assistant).toBe('cli:pi');
    expect(result.snapshot.options.find((item) => item.id === 'cli:pi')).toMatchObject({available: false, imageInput: 'unknown'});
    expect(executorRoleStatus('assistant', result.snapshot, result.draft).label).toBe('待适配');
  });

  it('adopts server choices when the editor has no pending changes', () => {
    const previous = snapshot();
    const next = {...snapshot(), roles: {...previous.roles, assistant: 'cli:pi'}};
    const result = reconcileExecutorScan(previous, next, executorDraft(previous), false);
    expect(result.draft.roles.assistant).toBe('cli:pi');
    expect(isExecutorDraftDirty(result.snapshot, result.draft)).toBe(false);
  });
});

function publicConfig(): AgentConfig {
  const section = () => ({model: 'saved-model', base_url: 'https://saved.invalid/v1', api_key: '', has_api_key: true});
  return {sections: {llm: {...section(), model_provider: 'openai'}, image: {...section(), api_provider: 'openrouter'}, video: {...section(), api_provider: 'yunwu'}, embedding: section(), reranker: section()}};
}

describe('three-choice selection drafts', () => {
  it('submits only the current role API section and permitted fields, without masked metadata or unrelated drafts', () => {
    const saved = snapshot();
    const selection = createExecutorSelection(saved, 'video', 'video_api', publicConfig());
    selection.config!.api_key = 'draft-only-key';
    expect(executorSelectionPayload(saved, selection)).toEqual({role: 'video', executorId: 'video_api', expectedFingerprint: 'video-current', config: {video: {model: 'saved-model', base_url: 'https://saved.invalid/v1', api_key: 'draft-only-key', api_provider: 'yunwu'}}});
    expect(JSON.stringify(executorSelectionPayload(saved, selection))).not.toContain('has_api_key');
    expect(JSON.stringify(executorSelectionPayload(saved, selection))).not.toContain('embedding');
  });

  it('starts each new choice from the saved configuration and discards the previous option key draft', () => {
    const saved = snapshot();
    const config = publicConfig();
    config.sections.llm.api_key = 'never-copy-a-returned-key';
    const edited = createExecutorSelection(saved, 'assistant', 'api', config);
    edited.config!.api_key = 'discard-on-cancel';
    const agent = createExecutorSelection(saved, 'assistant', 'cli:pi', config);
    expect(agent.config).toBeUndefined();
    const reopened = createExecutorSelection(saved, 'assistant', 'api', config);
    expect(reopened.config!.api_key).toBe('');
    expect(config.sections.llm.api_key).toBe('never-copy-a-returned-key');
  });

  it('keeps image tool confirmation independent from vision and omits it for pending applications/custom Agents', () => {
    const saved = snapshot([option(), option({id: 'cli:pi', kind: 'cli', imageInput: 'text_only', imageGeneration: 'available'}), option({id: 'app:test', kind: 'application', adapterAvailable: false}), option({id: 'custom:test', kind: 'custom', adapterAvailable: false})]);
    const pi = createExecutorSelection(saved, 'image', 'cli:pi');
    expect(pi.imageGeneration).toBe('available');
    expect(pi.imageInput).toBeUndefined();
    expect(validateExecutorSelection(saved, pi)).toBe('');
    for (const id of ['app:test', 'custom:test']) {
      const pending = createExecutorSelection(saved, 'image', id);
      expect(pending.imageGeneration).toBeUndefined();
      expect(executorSelectionPayload(saved, {...pending, imageGeneration: 'available'})).not.toHaveProperty('imageGeneration');
      expect(validateExecutorSelection(saved, pending)).toBe('');
    }
  });

  it('resets explicit visual confirmation when API model identity changes and rejects stale fingerprints', () => {
    const saved = snapshot([option({imageInput: 'vision'})]);
    const selection = createExecutorSelection(saved, 'vision', 'api', publicConfig());
    expect(selection.imageInput).toBe('vision');
    const changed = updateExecutorSelectionConfig(selection, {...selection.config!, model: 'new-model'});
    expect(changed.imageInput).toBe('unknown');
    expect(validateExecutorSelection(saved, changed)).toBe('');
    expect(validateExecutorSelection(saved, {...changed, imageInput: 'text_only'})).toContain('图片输入');
    expect(validateExecutorSelection(saved, {...changed, expectedFingerprint: 'stale'})).toContain('配置已变化');
  });

  it('preserves professional assignments and lists every detected option while sorting executable options first', () => {
    const saved = snapshot([option(), option({id: 'app:test', kind: 'application', adapterAvailable: false}), option({id: 'cli:codex', kind: 'cli', imageTransport: true})]);
    saved.roles.script = 'app:test';
    saved.roles.vision = 'cli:codex';
    expect(orderedExecutorOptions('assistant', saved.options).map((item) => item.id)).toEqual(['api', 'cli:codex', 'app:test']);
    expect(executorSelectionPayload(saved, createExecutorSelection(saved, 'assistant', 'cli:codex'))).not.toHaveProperty('roles');
    expect(saved.roles.script).toBe('app:test');
    expect(saved.roles.vision).toBe('cli:codex');
    expect(validateExecutorSelection(saved, createExecutorSelection(saved, 'script', 'inherit'))).toBe('');
    expect(validateExecutorSelection(saved, createExecutorSelection(saved, 'vision', 'inherit'))).toContain('未检测到');
  });

  it('merges a committed section while preserving only unrelated unsaved management fields', () => {
    const previous = publicConfig(), draft = publicConfig(), saved = publicConfig();
    draft.sections.image.model = 'unsaved-image';
    draft.sections.image.api_key = 'unsaved-image-key';
    draft.sections.llm.model = 'stale-llm-draft';
    saved.sections.llm.model = 'committed-llm';
    saved.sections.image.has_api_key = false;
    saved.novel_retrieval = {mode: 'assistant'};
    const result = mergeConfigAfterSelection(draft, previous, saved, 'llm');
    expect(result.sections.llm.model).toBe('committed-llm');
    expect(result.sections.image.model).toBe('unsaved-image');
    expect(result.sections.image.api_key).toBe('unsaved-image-key');
    expect(result.sections.image.has_api_key).toBe(false);
    expect(result.sections.video).toEqual(saved.sections.video);
    expect(result.novel_retrieval).toEqual({mode: 'assistant'});
  });

  it('opens the relevant choice for configuration errors including visual preflight and generated-image validation', () => {
    for (const code of ['executor_vision_unconfirmed', 'executor_image_transport_unavailable']) expect(roleForConfigurationError(code)).toBe('vision');
    for (const code of ['missing_image_api_key', 'unsupported_image_provider', 'executor_image_failed', 'executor_invalid_image', 'executor_image_generation_unconfirmed']) expect(roleForConfigurationError(code)).toBe('image');
    for (const code of ['missing_video_api_key', 'unsupported_video_provider', 'video_failed']) expect(roleForConfigurationError(code)).toBe('video');
    expect(roleForConfigurationError('missing_llm_api_key')).toBe('assistant');
    expect(roleForConfigurationError('random_error')).toBeUndefined();
  });
});
