import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {parse, stringify} from 'yaml';

export const SECTION_FIELDS = {
  llm: ['model_provider', 'model', 'base_url'],
  image: ['api_provider', 'model', 'base_url'],
  video: ['api_provider', 'model', 'base_url'],
  embedding: ['model_provider', 'model', 'base_url'],
  reranker: ['model', 'base_url'],
};

const transactionTails = new Map();
const fileIO = {mkdir, readFile, rename, rm, writeFile};

// Every configuration/role mutation for a repository enters this queue once.
// Callers inside the callback use prepare/commit directly, never saveAgentConfig.
export function withAgentConfigTransaction(repoRoot, operation) {
  const key = path.resolve(repoRoot);
  const previous = transactionTails.get(key) || Promise.resolve();
  const next = previous.then(operation);
  const settled = next.catch(() => {});
  transactionTails.set(key, settled);
  settled.finally(() => { if (transactionTails.get(key) === settled) transactionTails.delete(key); });
  return next;
}

const SECTION_TITLES = {
  llm: '创作助手',
  image: '图像生成',
  video: '视频生成',
  embedding: '文本向量模型',
  reranker: '检索排序',
};

export async function readAgentConfig(repoRoot) {
  const {payload} = await loadConfig(repoRoot);
  return publicConfig(payload);
}

export async function saveAgentConfig(repoRoot, input) {
  return withAgentConfigTransaction(repoRoot, async () => {
    const prepared = await prepareAgentConfig(repoRoot, input);
    await commitConfigFiles([{path: prepared.configPath, data: prepared.data}]);
    return prepared.config;
  });
}

export async function prepareAgentConfig(repoRoot, input) {
  if (!isConfigObject(input) || (!('sections' in input) && !('novel_retrieval' in input))) {
    throw new Error('缺少配置内容');
  }
  if ('sections' in input && !isConfigObject(input.sections)) {
    throw new Error('模型配置必须是配置对象');
  }
  let retrievalMode;
  if ('novel_retrieval' in input) {
    if (!isConfigObject(input.novel_retrieval) || !('mode' in input.novel_retrieval)) {
      throw new Error('小说检索配置必须包含有效的检索方式');
    }
    retrievalMode = validatedNovelRetrievalMode(input.novel_retrieval.mode);
  }
  const {configPath, payload} = await loadConfig(repoRoot);
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const update = input.sections?.[section];
    if (!update || typeof update !== 'object') continue;
    const current = payload[section] && typeof payload[section] === 'object' ? payload[section] : {};
    const previousOrigin = serviceOrigin(current.base_url);
    const nextBaseUrl = 'base_url' in update
      ? validatedValue(update.base_url, `${section}.base_url`, 2_048)
      : current.base_url;
    const hasStoredKey = typeof current.api_key === 'string' && Boolean(current.api_key.trim());
    const hasNewKey = typeof update.api_key === 'string' && Boolean(update.api_key.trim());
    if (hasStoredKey && !hasNewKey && serviceOrigin(nextBaseUrl) !== previousOrigin) {
      throw new Error(`${SECTION_TITLES[section]}已更换服务地址，请填写新服务的 API 密钥`);
    }
    for (const field of fields) {
      if (!(field in update)) continue;
      const apiProviders = section === 'video' ? ['', 'openrouter', 'yunwu', 'aliyun'] : ['', 'openrouter', 'yunwu'];
      if (field === 'api_provider' && !apiProviders.includes(update[field])) {
        throw new Error(`${SECTION_TITLES[section]}请选择支持的 API 接口`);
      }
      current[field] = validatedValue(update[field], `${section}.${field}`, 2_048);
    }
    if (typeof update.api_key === 'string' && update.api_key.trim()) {
      current.api_key = validatedValue(update.api_key, `${section}.api_key`, 8_192);
    }
    payload[section] = current;
  }
  if (retrievalMode !== undefined) {
    const current = isConfigObject(payload.novel_retrieval) ? payload.novel_retrieval : {};
    payload.novel_retrieval = {...current, mode: retrievalMode};
  }
  return {configPath, data: Buffer.from(stringify(payload, {lineWidth: 0})), config: publicConfig(payload)};
}

export async function commitConfigFiles(updates, {filesystem = {}} = {}) {
  const io = {...fileIO, ...filesystem};
  const staged = [];
  const applied = [];
  let rollbackFailed = false;
  try {
    for (const update of updates) {
      let original = null;
      try { original = await io.readFile(update.path); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await io.mkdir(path.dirname(update.path), {recursive: true});
      const temporaryPath = `${update.path}.${randomUUID()}.tmp`;
      const item = {...update, original, temporaryPath};
      staged.push(item);
      await io.writeFile(temporaryPath, update.data, {mode: 0o600, flag: 'wx'});
    }
    for (const item of staged) {
      await io.rename(item.temporaryPath, item.path);
      applied.push(item);
    }
  } catch {
    for (const item of applied.reverse()) {
      try {
        if (item.original === null) await io.rm(item.path, {force: true});
        else {
          const rollbackPath = `${item.path}.${randomUUID()}.tmp`;
          try {
            await io.writeFile(rollbackPath, item.original, {mode: 0o600, flag: 'wx'});
            await io.rename(rollbackPath, item.path);
          } finally { await io.rm(rollbackPath, {force: true}); }
        }
      } catch { rollbackFailed = true; }
    }
    throw Object.assign(new Error(rollbackFailed ? '配置保存失败且回滚未完成，请检查本地文件权限后重新保存' : '配置保存失败，原有设置已保留，请检查本地文件权限后重试'),
      {statusCode: 500, code: 'config_save_failed', action: 'open_settings'});
  } finally {
    await Promise.all(staged.map((item) => io.rm(item.temporaryPath, {force: true}).catch(() => {})));
  }
}

async function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, 'configs', 'agent.local.yaml');
  let text = '';
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('模型配置无法读取，请检查本地文件权限');
  }
  let payload;
  try {
    payload = text ? parse(text) : {};
  } catch {
    throw new Error('模型配置格式有误，请修正 configs/agent.local.yaml 后重试。');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('configs/agent.local.yaml 必须是有效的 YAML 配置对象');
  }
  return {configPath, payload};
}

function publicConfig(payload) {
  const sections = {};
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const source = payload[section] && typeof payload[section] === 'object' ? payload[section] : {};
    const result = {};
    for (const field of fields) {
      const value = typeof source[field] === 'string' ? source[field] : '';
      result[field] = /^<YOUR_[A-Z0-9_]+>$/.test(value) ? '' : value;
    }
    result.api_key = '';
    result.has_api_key = Boolean(typeof source.api_key === 'string' && source.api_key.trim() && !/^<YOUR_[A-Z0-9_]+>$/.test(source.api_key));
    sections[section] = result;
  }
  if ('novel_retrieval' in payload && !isConfigObject(payload.novel_retrieval)) {
    throw new Error('小说检索配置必须是配置对象');
  }
  const retrieval = payload.novel_retrieval || {};
  const mode = validatedNovelRetrievalMode('mode' in retrieval ? retrieval.mode : 'assistant');
  return {sections, novel_retrieval: {mode}};
}

function isConfigObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validatedNovelRetrievalMode(value) {
  if (value !== 'assistant' && value !== 'api') {
    throw new Error('小说检索方式必须选择创作助手或专用检索 API');
  }
  return value;
}

function validatedValue(value, label, maxLength) {
  if (typeof value !== 'string') throw new Error(`${label} 必须是文本`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} 内容过长`);
  if (label.endsWith('.base_url') && normalized && !/^https?:\/\//i.test(normalized)) {
    throw new Error(`${label} 必须使用 http:// 或 https://`);
  }
  return normalized;
}

function serviceOrigin(value) {
  try {
    return new URL(typeof value === 'string' ? value.trim() : '').origin;
  } catch {
    return null;
  }
}
