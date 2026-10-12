import {mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {parse, stringify} from 'yaml';
import {commitConfigFiles, readAgentConfig, saveAgentConfig} from './config-store.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vimax-config-'));
  roots.push(root);
  await mkdir(path.join(root, 'configs'), {recursive: true});
  await writeFile(path.join(root, 'configs', 'agent.local.yaml'), [
    'llm:',
    '  model_provider: openai',
    '  model: existing-model',
    '  base_url: https://example.test/v1',
    '  api_key: secret-value',
    '',
  ].join('\n'));
  return root;
}

describe('agent config store', () => {
  it('saves Aliyun only for video and never returns its API key', async () => {
    const root = await fixture();
    const saved = await saveAgentConfig(root, {sections: {video: {
      api_provider: 'aliyun', model: 'wan2.6-i2v-flash',
      base_url: 'https://dashscope.aliyuncs.com/api/v1', api_key: 'private-wan-key',
    }}});
    expect(saved.sections.video).toMatchObject({api_provider: 'aliyun', model: 'wan2.6-i2v-flash', api_key: '', has_api_key: true});
    expect(JSON.stringify(saved)).not.toContain('private-wan-key');
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const before = await readFile(configPath, 'utf8');
    expect(parse(before).video.api_key).toBe('private-wan-key');
    await expect(saveAgentConfig(root, {sections: {image: {api_provider: 'aliyun'}}})).rejects.toThrow('请选择支持的 API 接口');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('requires a dedicated replacement key when moving video from OpenRouter to Aliyun', async () => {
    const root = await fixture();
    await saveAgentConfig(root, {sections: {video: {
      api_provider: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key: 'private-openrouter-key',
    }}});
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const before = await readFile(configPath, 'utf8');
    const update = {api_provider: 'aliyun', model: 'wan2.6-i2v-flash', base_url: 'https://dashscope.aliyuncs.com/api/v1', api_key: ''};
    await expect(saveAgentConfig(root, {sections: {video: update}})).rejects.toThrow('视频生成已更换服务地址，请填写新服务的 API 密钥');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    const saved = await saveAgentConfig(root, {sections: {video: {...update, api_key: 'private-wan-key'}}});
    expect(JSON.stringify(saved)).not.toContain('private-');
    expect(parse(await readFile(configPath, 'utf8')).video.api_key).toBe('private-wan-key');
  });

  it('does not expose malformed configuration contents in a parse error', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const invalid = 'llm:\n  api_key: [private-test-value\n';
    await writeFile(configPath, invalid);
    await expect(readAgentConfig(root)).rejects.toThrow('模型配置格式有误');
    await expect(readAgentConfig(root)).rejects.not.toThrow('private-test-value');
    expect(await readFile(configPath, 'utf8')).toBe(invalid);
  });

  it('never returns stored API keys', async () => {
    const root = await fixture();
    const config = await readAgentConfig(root);
    expect(config.sections.llm).toMatchObject({model: 'existing-model', api_key: '', has_api_key: true});
    expect(JSON.stringify(config)).not.toContain('secret-value');
    expect(config.novel_retrieval).toEqual({mode: 'assistant'});
  });

  it('saves a retrieval mode alone while preserving services and unknown fields', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const before = parse(await readFile(configPath, 'utf8'));
    before.custom_settings = {enabled: true};
    before.novel_retrieval = {mode: 'api', custom_limit: 12};
    await writeFile(configPath, stringify(before));
    const saved = await saveAgentConfig(root, {novel_retrieval: {mode: 'assistant', ignored: true}});
    expect(saved.novel_retrieval).toEqual({mode: 'assistant'});
    expect(saved.sections.llm).toMatchObject({model: 'existing-model', api_key: '', has_api_key: true});
    const stored = parse(await readFile(configPath, 'utf8'));
    expect(stored.llm).toEqual(before.llm);
    expect(stored.custom_settings).toEqual(before.custom_settings);
    expect(stored.novel_retrieval).toEqual({mode: 'assistant', custom_limit: 12});
    expect(JSON.stringify(saved)).not.toContain('secret-value');
  });

  it('keeps an explicit retrieval mode during model-only saves', async () => {
    const root = await fixture();
    await saveAgentConfig(root, {novel_retrieval: {mode: 'api'}});
    const saved = await saveAgentConfig(root, {sections: {llm: {model: 'updated-text'}}});
    expect(saved.novel_retrieval).toEqual({mode: 'api'});
  });

  it('saves retrieval strategy and both services in one configuration', async () => {
    const root = await fixture();
    const config = await saveAgentConfig(root, {
      novel_retrieval: {mode: 'api'},
      sections: {
        embedding: {model: 'embedding-test', base_url: 'https://embedding.test/v1', api_key: 'embedding-test-key'},
        reranker: {model: 'reranker-test', base_url: 'https://reranker.test', api_key: 'reranker-test-key'},
      },
    });
    expect(config.novel_retrieval).toEqual({mode: 'api'});
    expect(config.sections.embedding).toMatchObject({model: 'embedding-test', has_api_key: true});
    expect(config.sections.reranker).toMatchObject({model: 'reranker-test', has_api_key: true});
    expect(JSON.stringify(config)).not.toContain('test-key');
    const stored = parse(await readFile(path.join(root, 'configs', 'agent.local.yaml'), 'utf8'));
    expect(stored.novel_retrieval.mode).toBe('api');
    expect(stored.embedding.api_key).toBe('embedding-test-key');
    expect(stored.reranker.api_key).toBe('reranker-test-key');
  });

  it('preserves mode and services across concurrent saves', async () => {
    const root = await fixture();
    await Promise.all([
      saveAgentConfig(root, {novel_retrieval: {mode: 'api'}}),
      saveAgentConfig(root, {sections: {embedding: {model: 'parallel-embedding'}}}),
    ]);
    const saved = await readAgentConfig(root);
    expect(saved.novel_retrieval.mode).toBe('api');
    expect(saved.sections.embedding.model).toBe('parallel-embedding');
  });

  it('rejects invalid strategy input without saving any accompanying service changes', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const before = await readFile(configPath, 'utf8');
    for (const strategy of [null, [], 'api', {}, {mode: null}, {mode: false}, {mode: 1}, {mode: 'unknown'}, {mode: ' api '}, {mode: ['api']}]) {
      await expect(saveAgentConfig(root, {novel_retrieval: strategy, sections: {llm: {model: 'never-saved'}}})).rejects.toThrow(/小说检索/);
      expect(await readFile(configPath, 'utf8')).toBe(before);
    }
    for (const sections of [null, [], 'invalid']) {
      await expect(saveAgentConfig(root, {sections, novel_retrieval: {mode: 'api'}})).rejects.toThrow(/配置对象/);
    }
    await expect(saveAgentConfig(root, {})).rejects.toThrow('缺少配置内容');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('does not partially save strategy when a service field fails validation', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const before = await readFile(configPath, 'utf8');
    await expect(saveAgentConfig(root, {novel_retrieval: {mode: 'api'}, sections: {
      embedding: {model: 'never-saved'}, reranker: {base_url: 'file:///invalid'},
    }})).rejects.toThrow(/http/);
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('rejects malformed stored strategy without exposing its value', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    for (const strategy of [null, [], 'private-strategy-value', {mode: null}, {mode: 'private-strategy-value'}]) {
      await writeFile(configPath, stringify({novel_retrieval: strategy}));
      await expect(readAgentConfig(root)).rejects.toThrow(/小说检索/);
      await expect(readAgentConfig(root)).rejects.not.toThrow('private-strategy-value');
    }
    await writeFile(configPath, stringify({novel_retrieval: {custom_limit: 12}}));
    expect((await readAgentConfig(root)).novel_retrieval.mode).toBe('assistant');
  });

  it('keeps a stored key when a blank key is saved', async () => {
    const root = await fixture();
    await saveAgentConfig(root, {sections: {llm: {model: 'new-model', api_key: ''}}});
    const saved = await readFile(path.join(root, 'configs', 'agent.local.yaml'), 'utf8');
    expect(saved).toContain('model: new-model');
    expect(saved).toContain('api_key: secret-value');
  });

  it('shows template values as blank without changing the stored configuration', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    await writeFile(configPath, 'llm:\n  model: <YOUR_LLM_MODEL>\n  base_url: <YOUR_BASE_URL>\n  api_key: secret-value\n');
    const config = await readAgentConfig(root);
    expect(config.sections.llm).toMatchObject({model: '', base_url: '', has_api_key: true});
    const stored = await readFile(configPath, 'utf8');
    expect(stored).toContain('<YOUR_LLM_MODEL>');
    expect(stored).toContain('secret-value');
  });

  it('rejects invalid base URLs', async () => {
    const root = await fixture();
    await expect(saveAgentConfig(root, {sections: {llm: {base_url: 'file:///tmp/key'}}})).rejects.toThrow(/http/);
  });

  it('requires a new key when switching services and leaves the saved config intact', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const before = await readFile(configPath, 'utf8');
    await expect(saveAgentConfig(root, {sections: {llm: {
      model: 'google/gemini-3.1-flash-lite',
      base_url: 'https://openrouter.ai/api/v1',
      api_key: '',
    }}})).rejects.toThrow('创作助手已更换服务地址，请填写新服务的 API 密钥');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('keeps a stored key when changing the path on the same service', async () => {
    const root = await fixture();
    await saveAgentConfig(root, {sections: {llm: {
      base_url: 'https://example.test/api/v1', api_key: '',
    }}});
    expect(await readFile(path.join(root, 'configs', 'agent.local.yaml'), 'utf8'))
      .toContain('api_key: secret-value');
  });

  it('accepts a replacement key for a new service without returning it', async () => {
    const root = await fixture();
    const config = await saveAgentConfig(root, {sections: {llm: {
      base_url: 'https://openrouter.ai/api/v1', api_key: 'replacement-key',
    }}});
    const saved = await readFile(path.join(root, 'configs', 'agent.local.yaml'), 'utf8');
    expect(saved).toContain('api_key: replacement-key');
    expect(saved).not.toContain('secret-value');
    expect(config.sections.llm).toMatchObject({api_key: '', has_api_key: true});
    expect(JSON.stringify(config)).not.toContain('replacement-key');
  });

  it('preserves independent sections across concurrent legacy saves', async () => {
    const root = await fixture();
    await Promise.all([
      saveAgentConfig(root, {sections: {llm: {model: 'new-text'}}}),
      saveAgentConfig(root, {sections: {image: {api_provider: 'openrouter', model: 'new-image', base_url: 'https://openrouter.ai/api/v1', api_key: 'private-image-key'}}}),
    ]);
    const saved = await readAgentConfig(root);
    expect(saved.sections.llm.model).toBe('new-text');
    expect(saved.sections.image.model).toBe('new-image');
    expect(JSON.stringify(saved)).not.toContain('private-image-key');
    expect((await stat(path.join(root, 'configs', 'agent.local.yaml'))).mode & 0o777).toBe(0o600);
  });

  it('cleans up staged files and preserves both originals when a staging write fails', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'agent.local.yaml');
    const rolePath = path.join(root, 'configs', 'roles.json');
    await writeFile(rolePath, 'original roles');
    const before = await readFile(configPath, 'utf8');
    const commit = commitConfigFiles([{path: configPath, data: 'never-private-key'}, {path: rolePath, data: 'new roles'}], {
      filesystem: {writeFile: async (target, data, options) => {
        if (target.startsWith(`${rolePath}.`)) throw new Error('PRIVATE_STAGING_DETAILS');
        return writeFile(target, data, options);
      }},
    });
    await expect(commit).rejects.toMatchObject({statusCode: 500});
    await expect(commit).rejects.not.toThrow('PRIVATE_STAGING_DETAILS');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(await readFile(rolePath, 'utf8')).toBe('original roles');
    expect((await readdir(path.dirname(configPath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes a newly created config file if the role commit fails', async () => {
    const root = await fixture();
    const configPath = path.join(root, 'configs', 'new-config.yaml');
    const rolePath = path.join(root, 'configs', 'roles.json');
    await writeFile(rolePath, 'original roles');
    await expect(commitConfigFiles([{path: configPath, data: 'new private key'}, {path: rolePath, data: 'new roles'}], {
      filesystem: {rename: async (source, target) => {
        if (target === rolePath) throw new Error('simulated role failure');
        return rename(source, target);
      }},
    })).rejects.toMatchObject({statusCode: 500});
    await expect(readFile(configPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(rolePath, 'utf8')).toBe('original roles');
    expect((await readdir(path.dirname(configPath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
