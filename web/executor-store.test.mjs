import {mkdtemp, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createExecutorStore, DEFAULT_EXECUTOR_ROLES, detectedExecutorOptions, executorFingerprint} from './executor-store.mjs';
import {createExecutorRouter} from './executor-routes.mjs';
import {commitConfigFiles, saveAgentConfig} from './config-store.mjs';
import {parse} from 'yaml';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))); });

async function fixture() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'frameflow-executors-'));
  roots.push(repoRoot);
  const inventory = {agents: [
    {id: 'pi', name: 'Pi', installed: true, executablePath: '/bin/pi', version: '0.85.1'},
    {id: 'claude', name: 'Claude Code', installed: true, executablePath: '/bin/claude', version: '2.1.92'},
    {id: 'hermes', name: 'Hermes', installed: true, executablePath: '/bin/hermes', version: '0.11.0'},
    {id: 'gemini', name: 'Gemini', installed: false}],
    applications: [{id: 'cursor', name: 'Cursor', path: '/Applications/Cursor.app', version: '3'}],
    customAgents: [{id: 'main', name: 'OpenClaw main', path: '/profiles/main', source: 'openclaw'}]};
  const config = {sections: {llm: {model_provider: 'openai', model: 'text-model', base_url: 'https://example.test/v1', api_key: 'test-private-secret'}}};
  const manager = {list: vi.fn(async () => inventory), scan: vi.fn(async () => inventory), test: vi.fn()};
  const onSaved = vi.fn();
  const store = createExecutorStore({repoRoot, manager, configReader: async () => config, env: {}, onSaved});
  return {repoRoot, inventory, config, manager, onSaved, store};
}

function draft(snapshot, roles = {}) {
  return {roles: {...snapshot.roles, ...roles},
    imageInput: Object.fromEntries(snapshot.options.map((option) => [option.id, option.imageInput])),
    fingerprints: Object.fromEntries(snapshot.options.map((option) => [option.id, option.fingerprint]))};
}

async function selectionFixture(options = {}) {
  const setup = await fixture();
  await mkdir(path.join(setup.repoRoot, 'configs'));
  await writeFile(path.join(setup.repoRoot, 'configs', 'agent.local.yaml'), [
    'llm:', '  model_provider: openai', '  model: text-model', '  base_url: https://example.test/v1', '  api_key: llm-private-key',
    'image:', '  api_provider: openrouter', '  model: image-model', '  base_url: https://openrouter.ai/api/v1', '  api_key: image-private-key',
    'video:', '  model: video-model', '  base_url: https://openrouter.ai/api/v1', '  api_key: video-private-key', '',
  ].join('\n'));
  setup.store = createExecutorStore({repoRoot: setup.repoRoot, manager: setup.manager, onSaved: setup.onSaved, env: {}, ...options});
  setup.configPath = path.join(setup.repoRoot, 'configs', 'agent.local.yaml');
  setup.settingsPath = path.join(setup.repoRoot, '.vimax', 'role-executors.json');
  return setup;
}

function selection(snapshot, role, executorId, extra = {}) {
  return {role, executorId, expectedFingerprint: snapshot.options.find((option) => option.id === executorId)?.fingerprint || '', ...extra};
}

describe('role executor configuration', () => {
  it('lists every discovered category, without claiming any current model can see images', async () => {
    const {store, manager} = await fixture();
    const result = await store.read();
    expect(result.roles).toEqual(DEFAULT_EXECUTOR_ROLES);
    expect(result.options.map((option) => option.name)).toEqual(['模型 API', '图像 API', '视频 API', 'Pi', 'Claude Code', 'Hermes', 'Cursor', 'OpenClaw main']);
    expect(result.options.every((option) => option.imageInput === 'unknown')).toBe(true);
    expect(result.options.find((option) => option.id === 'cli:pi')).toMatchObject({adapterAvailable: true, imageTransport: true});
    expect(result.options.find((option) => option.id === 'cli:hermes')).toMatchObject({adapterAvailable: false});
    expect(manager.test).not.toHaveBeenCalled();
  });

  it('keeps a text-only Pi for writing while a separately confirmed Claude handles images', async () => {
    const {store, repoRoot, onSaved} = await fixture();
    const input = draft(await store.read(), {assistant: 'cli:pi', vision: 'cli:claude'});
    input.imageInput['cli:pi'] = 'text_only';
    input.imageInput['cli:claude'] = 'vision';
    const result = await store.save(input);
    expect(result.roles).toMatchObject({assistant: 'cli:pi', vision: 'cli:claude', script: 'inherit'});
    expect(result.options.find((option) => option.id === 'cli:pi').imageInput).toBe('text_only');
    expect(result.options.find((option) => option.id === 'cli:claude').imageInput).toBe('vision');
    const filename = path.join(repoRoot, '.vimax', 'role-executors.json');
    const raw = await readFile(filename, 'utf8');
    expect(raw).not.toContain('test-private-secret');
    expect(JSON.parse(raw).executors['cli:pi'].executablePath).toBe('/bin/pi');
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('rejects a declared text-only vision selection before changing settings', async () => {
    const {store, onSaved} = await fixture();
    const input = draft(await store.read(), {vision: 'cli:pi'});
    input.imageInput['cli:pi'] = 'text_only';
    await expect(store.save(input)).rejects.toMatchObject({statusCode: 400});
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('invalidates image confirmation after API model or Agent version changes', async () => {
    const {store, config, inventory} = await fixture();
    const input = draft(await store.read(), {assistant: 'cli:pi', vision: 'api'});
    input.imageInput.api = 'vision';
    input.imageInput['cli:pi'] = 'vision';
    await store.save(input);
    config.sections.llm.model = 'different-model';
    inventory.agents[0].version = '0.86.0';
    const result = await store.read();
    expect(result.options.find((option) => option.id === 'api').imageInput).toBe('unknown');
    expect(result.options.find((option) => option.id === 'cli:pi').imageInput).toBe('unknown');
    await expect(store.save(input)).rejects.toMatchObject({statusCode: 409});
  });

  it('keeps disappeared and pending selections explicit instead of replacing them with API', async () => {
    const {store, inventory} = await fixture();
    await store.save(draft(await store.read(), {assistant: 'cli:hermes'}));
    inventory.agents = [];
    const result = await store.read();
    expect(result.roles.assistant).toBe('cli:hermes');
    expect(result.options.find((option) => option.id === 'cli:hermes')).toMatchObject({available: false, adapterAvailable: false, imageInput: 'unknown'});
  });

  it('refuses corrupted preferences rather than silently enabling an API fallback', async () => {
    const {store, repoRoot} = await fixture();
    await mkdir(path.join(repoRoot, '.vimax'));
    await writeFile(path.join(repoRoot, '.vimax', 'role-executors.json'), '{invalid-private-value');
    await expect(store.read()).rejects.toThrow('执行者设置格式有误');
    await expect(store.read()).rejects.not.toThrow('private-value');
  });

  it('fingerprints the effective API model including environment overrides', async () => {
    const {repoRoot, manager, config} = await fixture();
    const env = {VIMAX_LLM_MODEL: 'env-model', VIMAX_LLM_BASE_URL: 'https://override.test/v1', VIMAX_LLM_API_KEY: 'env-private-secret'};
    const store = createExecutorStore({repoRoot, manager, configReader: async () => config, env});
    const snapshot = await store.read();
    expect(snapshot.options[0]).toMatchObject({model: 'env-model', baseUrl: 'https://override.test/v1', hasApiKey: true,
      fingerprint: executorFingerprint(['openai', 'env-model', 'https://override.test/v1'])});
    expect(JSON.stringify(snapshot)).not.toContain('env-private-secret');
  });

  it('ignores template placeholders in both saved fields and environment overrides', async () => {
    const {repoRoot, manager} = await fixture();
    const config = {sections: {llm: {model_provider: '<YOUR_PROVIDER>', model: '<YOUR_MODEL>', base_url: '<YOUR_URL>'}}};
    const store = createExecutorStore({repoRoot, manager, configReader: async () => config,
      env: {VIMAX_LLM_MODEL: '<YOUR_MODEL>', VIMAX_LLM_BASE_URL: '<YOUR_URL>'}});
    expect((await store.read()).options[0].fingerprint).toBe(executorFingerprint(['openai', 'gpt-5.5', 'https://yunwu.ai/v1']));
  });

  it('lets a text-only Agent generate through separately confirmed tools', async () => {
    const {store} = await fixture();
    const input = draft(await store.read(), {image: 'cli:pi', vision: 'cli:claude'});
    input.imageInput['cli:pi'] = 'text_only';
    input.imageInput['cli:claude'] = 'vision';
    input.imageGeneration = {'cli:pi': 'available'};
    const saved = await store.save(input);
    expect(saved.roles.image).toBe('cli:pi');
    expect(saved.options.find((option) => option.id === 'cli:pi')).toMatchObject({imageGeneration: 'available', imageInput: 'text_only'});
  });

  it('rejects Agent video execution and unrelated API interfaces', async () => {
    const {store} = await fixture();
    const snapshot = await store.read();
    for (const roles of [{video: 'cli:pi'}, {video: 'api'}, {image: 'api'}, {vision: 'image_api'}]) {
      await expect(store.save(draft(snapshot, roles))).rejects.toMatchObject({statusCode: 400});
    }
    const input = draft(snapshot, {image: 'cli:pi'});
    input.imageGeneration = {'cli:pi': 'unavailable'};
    await expect(store.save(input)).rejects.toMatchObject({statusCode: 400});
  });

  it('keeps existing four-role selections while adding default media interfaces', async () => {
    const {store, repoRoot} = await fixture();
    const input = draft(await store.read(), {assistant: 'cli:pi', vision: 'cli:claude'});
    await store.save(input);
    const filename = path.join(repoRoot, '.vimax', 'role-executors.json');
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    delete saved.roles.image;
    delete saved.roles.video;
    await writeFile(filename, JSON.stringify(saved));
    const result = await store.read();
    expect(result.roles).toMatchObject({assistant: 'cli:pi', vision: 'cli:claude', image: 'image_api', video: 'video_api'});
  });

  it('uses separate media models, compatible API transports, and never exposes keys', async () => {
    const {store, config} = await fixture();
    config.sections.image = {model: 'image-model', api_provider: 'openrouter', base_url: 'https://relay.test/v1', has_api_key: true};
    config.sections.video = {model: 'video-model', api_provider: 'yunwu', base_url: 'https://video-relay.test', has_api_key: false};
    const snapshot = await store.read();
    expect(snapshot.options.find((option) => option.id === 'image_api')).toMatchObject({model: 'image-model', provider: 'openrouter', hasApiKey: true,
      imageGeneration: 'available', fingerprint: executorFingerprint(['image', 'openrouter', 'image-model', 'https://relay.test/v1'])});
    expect(snapshot.options.find((option) => option.id === 'video_api')).toMatchObject({provider: 'yunwu', imageGenerationTransport: false});
    expect(JSON.stringify(snapshot)).not.toContain('test-private-secret');
    config.sections.image.model = 'other-image';
    await expect(store.save(draft(snapshot))).rejects.toMatchObject({statusCode: 409});
  });

  it('normalizes explicit media protocols consistently with the Python runtime', async () => {
    const {repoRoot, manager, config} = await fixture();
    config.sections.image = {model: 'image-model', base_url: 'https://relay.test/v1'};
    config.sections.video = {model: 'video-model', base_url: 'https://yunwu.ai'};
    const store = createExecutorStore({repoRoot, manager, configReader: async () => config,
      env: {VIMAX_IMAGE_PROVIDER: ' OpenRouter ', VIMAX_VIDEO_PROVIDER: ' <YOUR_PROVIDER> '}});
    const snapshot = await store.read();
    expect(snapshot.options.find((option) => option.id === 'image_api')).toMatchObject({provider: 'openrouter', adapterAvailable: true,
      fingerprint: executorFingerprint(['image', 'openrouter', 'image-model', 'https://relay.test/v1'])});
    expect(snapshot.options.find((option) => option.id === 'video_api')).toMatchObject({provider: 'yunwu', adapterAvailable: true});
  });
});

describe('Aliyun video executor readiness', () => {
  const configFor = (video = {}, llm = {}) => ({sections: {llm, video: {api_provider: 'aliyun', ...video}}});
  const videoOption = (config, env = {}) => detectedExecutorOptions({}, config, env).find((option) => option.id === 'video_api');

  it('uses the supported model and Beijing endpoint by default and never adapts Aliyun for images', () => {
    const config = configFor();
    config.sections.image = {api_provider: 'aliyun', model: 'wan2.6-i2v-flash', base_url: 'https://dashscope.aliyuncs.com/api/v1'};
    const options = detectedExecutorOptions({}, config, {});
    expect(options.find((option) => option.id === 'video_api')).toMatchObject({provider: 'aliyun', model: 'wan2.6-i2v-flash',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1', adapterAvailable: true, hasApiKey: false});
    expect(options.find((option) => option.id === 'image_api')).toMatchObject({provider: 'aliyun', adapterAvailable: false, imageGenerationTransport: false});
    for (const model of ['wan2.6-i2v', 'wan2.6-t2v', 'wan2.6-i2v-flash-custom']) {
      expect(videoOption(configFor({model})).adapterAvailable).toBe(false);
    }
    expect(videoOption(config, {VIMAX_VIDEO_MODEL: ' wan2.6-i2v-flash '}).adapterAvailable).toBe(true);
  });

  it('recognizes only official DashScope and regional workspace endpoints when a protocol is absent', () => {
    for (const host of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com',
      'workspace-123.cn-beijing.maas.aliyuncs.com', 'workspace.ap-southeast-1.maas.aliyuncs.com']) {
      expect(videoOption(configFor({api_provider: '', base_url: `https://${host}/api/v1`})))
        .toMatchObject({provider: 'aliyun', model: 'wan2.6-i2v-flash', adapterAvailable: true});
    }
    for (const host of ['dashscope.aliyuncs.com.external.test', 'arbitrary.aliyuncs.com', 'evil.dashscope.aliyuncs.com',
      'workspace.eu-central-1.maas.aliyuncs.com', '-invalid.cn-beijing.maas.aliyuncs.com']) {
      expect(videoOption(configFor({api_provider: '', base_url: `https://${host}/api/v1`})))
        .toMatchObject({provider: '', adapterAvailable: false});
    }
    expect(videoOption(configFor(), {VIMAX_VIDEO_PROVIDER: 'openrouter'}).provider).toBe('openrouter');
  });

  it('uses only video-specific or DashScope credentials for Aliyun readiness without exposing their contents', () => {
    for (const env of [{VIMAX_API_KEY: 'shared-private'}, {VIMAX_LLM_API_KEY: 'llm-private'},
      {DASHSCOPE_API_KEY: ' '}, {VIMAX_VIDEO_API_KEY: '<YOUR_KEY>'}, {DASHSCOPE_API_KEY: '<YOUR_API_KEY>'}]) {
      expect(videoOption(configFor({}, {has_api_key: true}), env).hasApiKey).toBe(false);
    }
    for (const env of [{VIMAX_VIDEO_API_KEY: 'video-private'}, {DASHSCOPE_API_KEY: 'dashscope-private'},
      {VIMAX_VIDEO_API_KEY: 'video-private', DASHSCOPE_API_KEY: 'dashscope-private'}]) {
      const result = videoOption(configFor(), env);
      expect(result.hasApiKey).toBe(true);
      expect(JSON.stringify(result)).not.toContain('-private');
    }
    expect(videoOption(configFor({has_api_key: true})).hasApiKey).toBe(true);
    const others = detectedExecutorOptions({}, {sections: {llm: {}, video: {api_provider: 'openrouter'}, image: {api_provider: 'yunwu'}}},
      {DASHSCOPE_API_KEY: 'dashscope-private'});
    expect(others.every((option) => !option.hasApiKey)).toBe(true);
  });

  it('saves an Aliyun video choice independently while preserving other roles, services, and secret redaction', async () => {
    const {store, configPath, manager} = await selectionFixture();
    const beforeConfig = parse(await readFile(configPath, 'utf8'));
    const initial = await store.read();
    const result = await store.saveSelection(selection(initial, 'video', 'video_api', {config: {video: {
      api_provider: 'aliyun', model: 'wan2.6-i2v-flash', base_url: 'https://dashscope.aliyuncs.com/api/v1', api_key: 'aliyun-private-key',
    }}}));
    expect(result.executors.roles).toEqual(initial.roles);
    expect(result.executors.options.find((option) => option.id === 'video_api'))
      .toMatchObject({provider: 'aliyun', model: 'wan2.6-i2v-flash', adapterAvailable: true, hasApiKey: true});
    const afterConfig = parse(await readFile(configPath, 'utf8'));
    expect(afterConfig.llm).toEqual(beforeConfig.llm);
    expect(afterConfig.image).toEqual(beforeConfig.image);
    expect(result.config.sections.video).toMatchObject({api_key: '', has_api_key: true});
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(manager.test).not.toHaveBeenCalled();
  });
});

describe('executor settings HTTP boundary', () => {
  it('keeps discovery separate from inference and blocks cross-origin mutations', async () => {
    const {store, manager} = await fixture();
    const sendJson = vi.fn();
    const router = createExecutorRouter({store, sendJson, readJsonBody: async (request) => request.body});
    const response = {setHeader: vi.fn()};
    await router({method: 'POST', headers: {}}, response, new URL('http://127.0.0.1:4173/api/executors/scan'));
    expect(manager.scan).toHaveBeenCalledOnce();
    expect(manager.test).not.toHaveBeenCalled();
    await expect(router({method: 'PUT', headers: {origin: 'https://external.test', 'content-type': 'application/json'}, body: {}}, response,
      new URL('http://127.0.0.1:4173/api/executors'))).rejects.toMatchObject({statusCode: 403});
  });

  it('routes a single selection and blocks cross-origin or non-JSON writes first', async () => {
    const store = {saveSelection: vi.fn(async () => ({executors: {}, config: {}})), save: vi.fn()};
    const sendJson = vi.fn();
    const readJsonBody = vi.fn(async (request) => request.body);
    const router = createExecutorRouter({store, sendJson, readJsonBody});
    const response = {setHeader: vi.fn()};
    const url = new URL('http://127.0.0.1:4173/api/executors/selection');
    const body = {role: 'image', executorId: 'image_api', expectedFingerprint: 'old'};
    for (const headers of [{origin: 'https://external.test', 'content-type': 'application/json'},
      {'sec-fetch-site': 'cross-site', 'content-type': 'application/json'}, {'content-type': 'text/plain'}]) {
      await expect(router({method: 'PUT', headers, body}, response, url)).rejects.toHaveProperty('statusCode');
    }
    expect(store.saveSelection).not.toHaveBeenCalled();
    expect(readJsonBody).not.toHaveBeenCalled();
    await router({method: 'PUT', headers: {'content-type': 'application/json', origin: url.origin}, body}, response, url);
    expect(store.saveSelection).toHaveBeenCalledWith(body);
    expect(store.save).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledWith(response, 200, {executors: {}, config: {}});
  });
});

describe('single-role selection transaction', () => {
  it('updates one role and its API section while preserving professional roles and other declarations', async () => {
    const {store, configPath, settingsPath, onSaved} = await selectionFixture();
    const initial = draft(await store.read(), {assistant: 'cli:pi', storyboard: 'cli:claude', vision: 'cli:claude', image: 'cli:pi'});
    initial.imageInput['cli:claude'] = 'vision';
    initial.imageInput['cli:pi'] = 'text_only';
    initial.imageGeneration = {'cli:pi': 'available'};
    await store.save(initial);
    const beforeConfig = parse(await readFile(configPath, 'utf8'));
    const beforeSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
    onSaved.mockClear();
    const snapshot = await store.read();
    const result = await store.saveSelection(selection(snapshot, 'image', 'image_api', {config: {image: {
      model: 'new-image', api_provider: 'yunwu', base_url: 'https://new-service.test', api_key: 'new-private-key',
    }}}));
    expect(result.executors.roles).toEqual({...beforeSettings.roles, image: 'image_api'});
    const config = parse(await readFile(configPath, 'utf8'));
    expect(config.llm).toEqual(beforeConfig.llm);
    expect(config.video).toEqual(beforeConfig.video);
    expect(config.image).toMatchObject({model: 'new-image', api_key: 'new-private-key'});
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(saved.capabilities['cli:pi']).toEqual(beforeSettings.capabilities['cli:pi']);
    expect(saved.capabilities['cli:claude']).toEqual(beforeSettings.capabilities['cli:claude']);
    expect(result.executors.options.find((option) => option.id === 'image_api').fingerprint)
      .toBe(executorFingerprint(['image', 'yunwu', 'new-image', 'https://new-service.test']));
    expect(result.config.sections.image).toMatchObject({api_key: '', has_api_key: true});
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(onSaved).toHaveBeenCalledOnce();
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
  });

  it('invalidates a previous API vision declaration unless the new model is explicitly confirmed', async () => {
    const {store, settingsPath} = await selectionFixture();
    const initial = draft(await store.read());
    initial.imageInput.api = 'vision';
    await store.save(initial);
    const before = await store.read();
    const result = await store.saveSelection(selection(before, 'assistant', 'api', {config: {llm: {model: 'new-model'}}}));
    const api = result.executors.options.find((option) => option.id === 'api');
    expect(api.fingerprint).not.toBe(before.options.find((option) => option.id === 'api').fingerprint);
    expect(api.imageInput).toBe('unknown');
    expect(result.executors.roles.vision).toBe('api');
    const confirmed = await store.saveSelection(selection(result.executors, 'vision', 'api', {config: {llm: {model: 'third-model'}}, imageInput: 'vision'}));
    expect(confirmed.executors.options.find((option) => option.id === 'api').imageInput).toBe('vision');
    expect(JSON.parse(await readFile(settingsPath, 'utf8')).capabilities.api.fingerprint)
      .toBe(confirmed.executors.options.find((option) => option.id === 'api').fingerprint);
  });

  it('rejects stale identities and invalid role/config/capability combinations before writing', async () => {
    const {store, configPath, settingsPath, onSaved} = await selectionFixture();
    await store.save(draft(await store.read()));
    const stale = await store.read();
    await saveAgentConfig(path.dirname(path.dirname(configPath)), {sections: {llm: {model: 'external-change'}}});
    const beforeConfig = await readFile(configPath, 'utf8');
    const beforeSettings = await readFile(settingsPath, 'utf8');
    onSaved.mockClear();
    await expect(store.saveSelection(selection(stale, 'assistant', 'api', {config: {llm: {api_key: 'never-write-private'}}}))).rejects.toMatchObject({statusCode: 409});
    const current = await store.read();
    const invalid = [selection(current, 'assistant', 'cli:pi', {config: {llm: {api_key: 'never-write-private'}}}),
      selection(current, 'image', 'image_api', {config: {llm: {model: 'wrong-section'}}}),
      selection(current, 'vision', 'api', {config: {llm: {model: 'invalid-new-model'}}, imageInput: 'text_only'}),
      selection(current, 'image', 'cli:pi', {imageGeneration: 'unavailable'}),
      selection(current, 'image', 'cli:pi', {imageGeneration: 'incorrect'}),
      selection(current, 'video', 'cli:pi'), selection(current, 'image', 'image_api', {config: {image: {private: 'invalid-field'}}})];
    for (const input of invalid) await expect(store.saveSelection(input)).rejects.toMatchObject({statusCode: 400});
    expect(await readFile(configPath, 'utf8')).toBe(beforeConfig);
    expect(await readFile(settingsPath, 'utf8')).toBe(beforeSettings);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('saves pending choices and tool declarations without claiming a connection or reassigning other roles', async () => {
    const {store, manager} = await selectionFixture();
    const initial = await store.read();
    const pending = await store.saveSelection(selection(initial, 'script', 'cli:hermes'));
    expect(pending.executors.roles).toEqual({...initial.roles, script: 'cli:hermes'});
    expect(pending.executors.options.find((option) => option.id === 'cli:hermes')).toMatchObject({adapterAvailable: false, imageInput: 'unknown'});
    const image = await store.saveSelection(selection(pending.executors, 'image', 'cli:pi', {imageInput: 'text_only', imageGeneration: 'available'}));
    expect(image.executors.roles.vision).toBe(initial.roles.vision);
    expect(image.executors.options.find((option) => option.id === 'cli:pi')).toMatchObject({imageInput: 'text_only', imageGeneration: 'available'});
    const inherited = await store.saveSelection(selection(image.executors, 'script', 'inherit'));
    expect(inherited.executors.roles.script).toBe('inherit');
    expect(manager.test).not.toHaveBeenCalled();
  });

  it('rolls back both files after a second rename failure and never returns a key or stops the agent', async () => {
    let armed = false;
    const setup = await selectionFixture({commitFiles: (updates) => commitConfigFiles(updates, {filesystem: {
      rename: async (source, target) => {
        if (armed && target.endsWith('role-executors.json')) { armed = false; throw new Error('PRIVATE_FILESYSTEM_KEY'); }
        return rename(source, target);
      },
    }})});
    const {store, configPath, settingsPath, onSaved} = setup;
    await store.save(draft(await store.read()));
    const beforeConfig = await readFile(configPath, 'utf8');
    const beforeSettings = await readFile(settingsPath, 'utf8');
    onSaved.mockClear();
    armed = true;
    const request = store.saveSelection(selection(await store.read(), 'image', 'image_api', {config: {image: {model: 'never-commit', api_key: 'never-private-key'}}}));
    await expect(request).rejects.toMatchObject({statusCode: 500, code: 'config_save_failed'});
    await expect(request).rejects.not.toThrow('PRIVATE_FILESYSTEM_KEY');
    expect(await readFile(configPath, 'utf8')).toBe(beforeConfig);
    expect(await readFile(settingsPath, 'utf8')).toBe(beforeSettings);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('serializes legacy config saves after a rollback so unrelated updates cannot be lost', async () => {
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    let reached;
    const entered = new Promise((resolve) => { reached = resolve; });
    let armed = false;
    const setup = await selectionFixture({commitFiles: (updates) => commitConfigFiles(updates, {filesystem: {
      rename: async (source, target) => {
        if (armed && target.endsWith('role-executors.json')) {
          armed = false;
          reached();
          await barrier;
          throw new Error('simulated failure');
        }
        return rename(source, target);
      },
    }})});
    const {repoRoot, store, configPath} = setup;
    await store.save(draft(await store.read()));
    const snapshot = await store.read();
    armed = true;
    const combined = store.saveSelection(selection(snapshot, 'image', 'image_api', {config: {image: {model: 'rolled-back-image'}}}));
    const failed = expect(combined).rejects.toMatchObject({statusCode: 500});
    await entered;
    let legacyFinished = false;
    const legacy = saveAgentConfig(repoRoot, {sections: {llm: {model: 'concurrent-text-update'}}}).then(() => { legacyFinished = true; });
    await Promise.resolve();
    expect(legacyFinished).toBe(false);
    release();
    await failed;
    await legacy;
    const config = parse(await readFile(configPath, 'utf8'));
    expect(config.llm.model).toBe('concurrent-text-update');
    expect(config.image.model).toBe('image-model');
  });
});
