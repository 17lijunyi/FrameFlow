import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {commitConfigFiles, prepareAgentConfig, readAgentConfig, SECTION_FIELDS, withAgentConfigTransaction} from './config-store.mjs';

export const EXECUTOR_ROLES = ['assistant', 'script', 'storyboard', 'vision', 'image', 'video'];
export const DEFAULT_EXECUTOR_ROLES = {assistant: 'api', script: 'inherit', storyboard: 'inherit', vision: 'api', image: 'image_api', video: 'video_api'};
const IMAGE_INPUTS = new Set(['unknown', 'text_only', 'vision']);
const IMAGE_GENERATION = new Set(['unknown', 'available', 'unavailable']);
const ADAPTERS = new Set(['codex', 'claude', 'pi']);
const MAX_FILE_BYTES = 256 * 1024;

export function executorFingerprint(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function detectedExecutorOptions(snapshot, config, env = process.env) {
  const llm = config.sections.llm;
  const configured = (value) => typeof value === 'string' && !/^<YOUR_[A-Z0-9_]+>$/.test(value.trim()) ? value.trim() : '';
  const apiIdentity = [configured(env.VIMAX_LLM_MODEL_PROVIDER) || configured(llm.model_provider) || 'openai',
    configured(env.VIMAX_LLM_MODEL) || configured(llm.model) || 'gpt-5.5', configured(env.VIMAX_LLM_BASE_URL) || configured(llm.base_url) || 'https://yunwu.ai/v1'];
  const options = [{id: 'api', name: '模型 API', kind: 'api', available: true,
    provider: apiIdentity[0], model: apiIdentity[1], baseUrl: apiIdentity[2],
    hasApiKey: Boolean(configured(env.VIMAX_LLM_API_KEY) || configured(env.VIMAX_API_KEY) || llm.has_api_key),
    fingerprint: executorFingerprint(apiIdentity), adapterAvailable: true, imageTransport: true}];
  for (const mediaKind of ['image', 'video']) {
    const section = config.sections[mediaKind] || {};
    const prefix = mediaKind.toUpperCase();
    const explicitProvider = (configured(env[`VIMAX_${prefix}_PROVIDER`]) || configured(section.api_provider)).toLowerCase();
    const baseUrl = configured(env[`VIMAX_${prefix}_BASE_URL`]) || configured(section.base_url)
      || (mediaKind === 'image' ? 'https://yunwu.ai' : explicitProvider === 'aliyun' ? 'https://dashscope.aliyuncs.com/api/v1' : 'https://openrouter.ai/api/v1');
    const provider = explicitProvider || providerFromUrl(baseUrl);
    const aliyunVideo = mediaKind === 'video' && provider === 'aliyun';
    const model = configured(env[`VIMAX_${prefix}_MODEL`]) || configured(section.model)
      || (mediaKind === 'image' ? 'gemini-3.1-flash-image-preview' : aliyunVideo ? 'wan2.6-i2v-flash' : 'google/veo-3.1-fast');
    const hasApiKey = aliyunVideo
      ? Boolean(configured(env.VIMAX_VIDEO_API_KEY) || configured(env.DASHSCOPE_API_KEY) || section.has_api_key)
      : Boolean(configured(env[`VIMAX_${prefix}_API_KEY`]) || configured(env.VIMAX_LLM_API_KEY)
        || configured(env.VIMAX_API_KEY) || section.has_api_key || llm.has_api_key);
    options.push({id: `${mediaKind}_api`, name: mediaKind === 'image' ? '图像 API' : '视频 API', kind: 'api', mediaKind,
      model, baseUrl, provider, hasApiKey, available: true, adapterAvailable: ['openrouter', 'yunwu'].includes(provider) || (aliyunVideo && model === 'wan2.6-i2v-flash'),
      imageTransport: false, imageGenerationTransport: mediaKind === 'image' && ['openrouter', 'yunwu'].includes(provider),
      fingerprint: executorFingerprint([mediaKind, provider, model, baseUrl])});
  }
  for (const agent of snapshot.agents || []) {
    if (!agent.installed) continue;
    options.push({id: `cli:${agent.id}`, name: agent.name, kind: 'cli', agentId: agent.id,
      executablePath: agent.executablePath, version: agent.version || '', available: true,
      fingerprint: executorFingerprint(['cli', agent.id, agent.executablePath, agent.version || '']),
      adapterAvailable: ADAPTERS.has(agent.id), imageTransport: ADAPTERS.has(agent.id), imageGenerationTransport: ADAPTERS.has(agent.id)});
  }
  for (const application of snapshot.applications || []) {
    options.push({id: `application:${application.id}:${executorFingerprint([application.path]).slice(0, 12)}`,
      name: application.name, kind: 'application', available: true, adapterAvailable: false, imageTransport: false,
      fingerprint: executorFingerprint(['application', application.id, application.path, application.version || ''])});
  }
  for (const agent of snapshot.customAgents || []) {
    options.push({id: `custom:${agent.id}:${executorFingerprint([agent.path]).slice(0, 12)}`,
      name: agent.name, kind: 'custom', available: true, adapterAvailable: false, imageTransport: false,
      fingerprint: executorFingerprint(['custom', agent.id, agent.path, agent.source || ''])});
  }
  return options;
}

export function createExecutorStore({repoRoot, manager, configReader = readAgentConfig, env = process.env, onSaved = () => {}, commitFiles = commitConfigFiles}) {
  const settingsPath = path.join(repoRoot, '.vimax', 'role-executors.json');

  async function load() {
    let buffer;
    try { buffer = await readFile(settingsPath); }
    catch (error) {
      if (error.code === 'ENOENT') return {schemaVersion: 1, roles: {...DEFAULT_EXECUTOR_ROLES}, executors: {}, capabilities: {}};
      throw requestError('无法读取执行者设置，请检查本地文件权限', 500);
    }
    try {
      if (buffer.length > MAX_FILE_BYTES) throw new Error();
      const value = JSON.parse(buffer.toString('utf8'));
      if (value.schemaVersion !== 1 || !isRecord(value.roles) || !isRecord(value.executors) || !isRecord(value.capabilities)) throw new Error();
      value.roles = {...value.roles,
        image: Object.hasOwn(value.roles, 'image') ? value.roles.image : 'image_api',
        video: Object.hasOwn(value.roles, 'video') ? value.roles.video : 'video_api'};
      if (EXECUTOR_ROLES.some((role) => !validId(value.roles[role]) || (value.roles[role] === 'inherit' && !['script', 'storyboard'].includes(role)))) throw new Error();
      if (value.roles.video !== 'video_api' || ['api', 'video_api', 'inherit'].includes(value.roles.image)) throw new Error();
      return value;
    } catch { throw requestError('执行者设置格式有误，请修正 .vimax/role-executors.json 后重试', 500); }
  }

  async function snapshot(scan = false) {
    const [saved, inventory, config] = await Promise.all([load(), scan ? manager.scan() : manager.list(), configReader(repoRoot)]);
    const options = detectedExecutorOptions(inventory, config, env);
    // A disappeared selection stays visible; it must never silently turn into an API selection.
    for (const id of new Set(Object.values(saved.roles))) {
      if (id === 'inherit' || options.some((option) => option.id === id)) continue;
      const previous = saved.executors[id];
      options.push({id, name: typeof previous?.name === 'string' ? previous.name : '未检测到的执行者',
        kind: ['cli', 'application', 'custom'].includes(previous?.kind) ? previous.kind : 'custom',
        fingerprint: '', available: false, adapterAvailable: false, imageTransport: false});
    }
    for (const option of options) {
      const declaration = saved.capabilities[option.id];
      option.imageInput = declaration?.fingerprint === option.fingerprint && option.available && IMAGE_INPUTS.has(declaration?.imageInput)
        ? declaration.imageInput : 'unknown';
      option.imageGeneration = option.id === 'image_api' ? 'available'
        : declaration?.fingerprint === option.fingerprint && option.available && IMAGE_GENERATION.has(declaration?.imageGeneration)
          ? declaration.imageGeneration : 'unknown';
    }
    return {schemaVersion: 1, roles: saved.roles, options};
  }

  async function save(input) {
    if (!isRecord(input) || !isRecord(input.roles) || !isRecord(input.imageInput) || !isRecord(input.fingerprints)
      || (input.imageGeneration !== undefined && !isRecord(input.imageGeneration))) {
      throw requestError('缺少执行者设置', 400);
    }
    const current = await snapshot();
    const byId = new Map(current.options.map((option) => [option.id, option]));
    const roles = {};
    for (const role of EXECUTOR_ROLES) {
      const legacyMedia = ['image', 'video'].includes(role) && !Object.hasOwn(input.roles, role);
      const id = legacyMedia ? current.roles[role] : input.roles[role];
      if (!validId(id) || (id === 'inherit' ? !['script', 'storyboard'].includes(role) : !byId.has(id))) {
        throw requestError('请选择已检测到的执行者', 400);
      }
      if (role === 'video' && id !== 'video_api') throw requestError('视频生成请选择视频 API 接口', 400);
      if (role === 'image' && id !== 'image_api' && byId.get(id)?.kind === 'api') throw requestError('图像生成请选择图像 API 或 Agent', 400);
      if (!['image', 'video'].includes(role) && id !== 'inherit' && byId.get(id)?.kind === 'api' && id !== 'api') {
        throw requestError('文字与看图任务请选择模型 API 或 Agent', 400);
      }
      if (id !== 'inherit' && !legacyMedia && input.fingerprints[id] !== byId.get(id).fingerprint) {
        throw requestError('执行者配置已变化，请重新检测并确认图片能力', 409);
      }
      roles[role] = id;
    }
    const capabilities = {};
    const executors = {};
    for (const option of current.options) {
      const declared = input.imageInput[option.id] ?? option.imageInput;
      if (!IMAGE_INPUTS.has(declared)) throw requestError('图片能力设置无效', 400);
      if (input.imageInput[option.id] !== undefined && input.fingerprints[option.id] !== option.fingerprint) {
        throw requestError('执行者配置已变化，请重新检测并确认图片能力', 409);
      }
      const generation = input.imageGeneration?.[option.id] ?? option.imageGeneration;
      if (!IMAGE_GENERATION.has(generation)) throw requestError('生图工具能力设置无效', 400);
      if (input.imageGeneration?.[option.id] !== undefined && input.fingerprints[option.id] !== option.fingerprint) {
        throw requestError('执行者配置已变化，请重新确认生图工具能力', 409);
      }
      const {imageInput: _imageInput, imageGeneration: _generation, ...metadata} = option;
      executors[option.id] = metadata;
      capabilities[option.id] = {imageInput: option.available ? declared : 'unknown',
        imageGeneration: option.id === 'image_api' ? 'available' : option.available ? generation : 'unknown', fingerprint: option.fingerprint};
    }
    if (capabilities[roles.vision]?.imageInput === 'text_only') {
      throw requestError('该执行者已标为仅文字，请为看图与审片选择支持图片的执行者', 400);
    }
    if (capabilities[roles.image]?.imageGeneration === 'unavailable') throw requestError('该 Agent 已标为不能生图，请选择生图 Agent 或图像 API', 400);
    const saved = {schemaVersion: 1, roles, executors, capabilities};
    await commitFiles([{path: settingsPath, data: JSON.stringify(saved, null, 2) + '\n'}]);
    await onSaved();
    return snapshot();
  }

  async function saveSelection(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => !['role', 'executorId', 'expectedFingerprint', 'config', 'imageInput', 'imageGeneration'].includes(key))
      || !EXECUTOR_ROLES.includes(input.role) || !validId(input.executorId) || typeof input.expectedFingerprint !== 'string') {
      throw requestError('缺少有效的执行者选择', 400);
    }
    const saved = await load();
    const current = await snapshot();
    const byId = new Map(current.options.map((option) => [option.id, option]));
    const {role, executorId: id} = input;
    validateRoleSelection(role, id, byId);
    let option = id === 'inherit' ? null : byId.get(id);
    if (input.expectedFingerprint !== (option?.fingerprint || '')) throw requestError('执行者配置已变化，请重新打开选择面板后保存', 409);
    if (input.imageInput !== undefined && !IMAGE_INPUTS.has(input.imageInput)) throw requestError('图片能力设置无效', 400);
    if (input.imageGeneration !== undefined && !IMAGE_GENERATION.has(input.imageGeneration)) throw requestError('生图工具能力设置无效', 400);
    if (!option && (input.imageInput !== undefined || input.imageGeneration !== undefined)) throw requestError('沿用创作协调不需要单独设置能力', 400);
    if (input.imageGeneration !== undefined && option?.kind !== 'cli') throw requestError('生图工具能力仅适用于 Agent', 400);

    let prepared = null;
    if (input.config !== undefined) {
      const section = ['image', 'video'].includes(role) ? role : 'llm';
      if (option?.kind !== 'api' || !isRecord(input.config) || Object.keys(input.config).length !== 1
        || !Object.hasOwn(input.config, section) || !isRecord(input.config[section])
        || Object.keys(input.config[section]).some((key) => ![...SECTION_FIELDS[section], 'api_key'].includes(key))) {
        throw requestError('当前选择只能保存对应 API 的模型配置', 400);
      }
      prepared = await prepareAgentConfig(repoRoot, {sections: input.config});
      option = detectedExecutorOptions({}, prepared.config, env).find((entry) => entry.id === id);
    }

    const next = {schemaVersion: 1, roles: {...saved.roles, [role]: id}, executors: {...saved.executors}, capabilities: {...saved.capabilities}};
    if (option) {
      const prior = isRecord(saved.capabilities[id]) && saved.capabilities[id].fingerprint === option.fingerprint
        ? saved.capabilities[id] : {};
      const imageInput = input.imageInput ?? (IMAGE_INPUTS.has(prior.imageInput) ? prior.imageInput : 'unknown');
      const imageGeneration = input.imageGeneration ?? (IMAGE_GENERATION.has(prior.imageGeneration) ? prior.imageGeneration : 'unknown');
      const capability = {fingerprint: option.fingerprint, imageInput: option.available ? imageInput : 'unknown',
        imageGeneration: id === 'image_api' ? 'available' : option.available ? imageGeneration : 'unknown'};
      if (next.roles.vision === id && capability.imageInput === 'text_only') throw requestError('该执行者已标为仅文字，请为看图与审片选择支持图片的执行者', 400);
      if (next.roles.image === id && capability.imageGeneration === 'unavailable') throw requestError('该 Agent 已标为不能生图，请选择生图 Agent 或图像 API', 400);
      const {imageInput: _imageInput, imageGeneration: _generation, ...metadata} = option;
      next.executors[id] = metadata;
      next.capabilities[id] = capability;
    }
    const updates = prepared ? [{path: prepared.configPath, data: prepared.data}] : [];
    updates.push({path: settingsPath, data: JSON.stringify(next, null, 2) + '\n'});
    await commitFiles(updates);
    await onSaved();
    return {executors: await snapshot(), config: prepared?.config || await readAgentConfig(repoRoot)};
  }

  return {
    read: () => withAgentConfigTransaction(repoRoot, () => snapshot()),
    scan: () => withAgentConfigTransaction(repoRoot, () => snapshot(true)),
    save: (input) => withAgentConfigTransaction(repoRoot, () => save(input)),
    saveSelection: (input) => withAgentConfigTransaction(repoRoot, () => saveSelection(input)),
  };
}

function validateRoleSelection(role, id, byId) {
  if (id === 'inherit' ? !['script', 'storyboard'].includes(role) : !byId.has(id)) throw requestError('请选择已检测到的执行者', 400);
  if (role === 'video' && id !== 'video_api') throw requestError('视频生成请选择视频 API 接口', 400);
  if (role === 'image' && id !== 'image_api' && byId.get(id)?.kind === 'api') throw requestError('图像生成请选择图像 API 或 Agent', 400);
  if (!['image', 'video'].includes(role) && id !== 'inherit' && byId.get(id)?.kind === 'api' && id !== 'api') throw requestError('文字与看图任务请选择模型 API 或 Agent', 400);
}

function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value); }
function providerFromUrl(value) {
  try { const host = new URL(value).hostname; return host === 'openrouter.ai' || host.endsWith('.openrouter.ai') ? 'openrouter'
    : host === 'yunwu.ai' || host.endsWith('.yunwu.ai') ? 'yunwu'
    : ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host)
      || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host) ? 'aliyun' : ''; }
  catch { return ''; }
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requestError(message, statusCode) { return Object.assign(new Error(message), {statusCode, code: 'executor_config', action: 'open_settings'}); }
