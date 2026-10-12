import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createLocalAgentManager, runLocalCommand} from './local-agents.mjs';
import {LOCAL_AGENT_DEFINITIONS, staticAgentVersion} from './local-agent-catalog.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))));

const HELP = {
  codex: 'Codex CLI\nCommands: exec app-server login\n--ask-for-approval',
  codexExec: 'Usage: codex exec\n--json --sandbox --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check',
  claude: 'Claude Code\n--print --output-format json stream-json --tools --disallowedTools --strict-mcp-config --setting-sources --no-session-persistence',
  gemini: 'Gemini CLI\n--prompt --output-format json stream-json --policy --approval-mode --extensions --allowed-mcp-server-names',
};

async function fixture(installed = ['codex', 'claude', 'gemini']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameflow-discovery-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const files = {};
  for (const id of installed) {
    const candidate = path.join(bin, id);
    await writeFile(candidate, '#!/bin/sh\nexit 0\n');
    await chmod(candidate, 0o755);
    files[await realpath(candidate)] = id;
  }
  const runner = vi.fn(async (executablePath, args) => {
    const id = files[executablePath];
    if (!id) return {exitCode: 1, stdout: '', stderr: ''};
    if (args[0] === '--version') return {exitCode: 0, stdout: id === 'gemini' ? '0.63.0' : `${id} 2.1.290`, stderr: ''};
    if (args.join(' ') === 'exec --help') return {exitCode: 0, stdout: HELP.codexExec, stderr: ''};
    if (args[0] === '--help') return {exitCode: 0, stdout: HELP[id], stderr: ''};
    if (args.join(' ') === 'login status') return {exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT'};
    if (args.join(' ') === 'auth status') return {exitCode: 0, stdout: JSON.stringify({loggedIn: true, email: 'private@example.test', token: 'never-return-this-token'}), stderr: ''};
    return {exitCode: 1, stdout: '', stderr: ''};
  });
  const options = {repoRoot: root, homeDir: root, env: {PATH: bin}, runCommand: runner, applicationDirectories: [], systemDirectories: [], inventoryScanner: async () => ({applications: [], customAgents: [], scanLocations: [], scanWarnings: []})};
  return {root, bin, files, runner, options, manager: createLocalAgentManager(options)};
}

describe('local Agent discovery', () => {
  it('discovers interfaces and cached authentication without sending any model prompt', async () => {
    const {manager, runner} = await fixture();
    const result = await manager.scan();
    expect(result.agents.map(({id, installed, authStatus}) => ({id, installed, authStatus}))).toEqual([
      {id: 'codex', installed: true, authStatus: 'logged_in'},
      {id: 'claude', installed: true, authStatus: 'logged_in'},
      {id: 'gemini', installed: true, authStatus: 'unknown'},
    ]);
    expect(result.agents.every(({interfaceStatus}) => interfaceStatus === 'available')).toBe(true);
    expect(runner.mock.calls.every(([, args]) => !args.some((arg) => arg.includes('FRAMEFLOW_OK')))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private@example|never-return-this-token/);
    const callCount = runner.mock.calls.length;
    result.agents[0].name = 'mutated';
    expect((await manager.list()).agents[0].name).toBe('Codex CLI');
    expect(runner.mock.calls).toHaveLength(callCount);
  });

  it('returns a missing installation without requiring the Agent to be running', async () => {
    const {manager} = await fixture([]);
    const result = await manager.check('gemini');
    expect(result.agents.find(({id}) => id === 'gemini')).toMatchObject({installed: false, authStatus: 'unknown'});
  });

  it('does not treat auth command errors as logged out or infer login from files', async () => {
    const {manager, runner, root} = await fixture(['codex']);
    await mkdir(path.join(root, '.codex'));
    await writeFile(path.join(root, '.codex/auth.json'), '{"token":"do-not-read"}');
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => args[1].join(' ') === 'login status'
      ? {exitCode: 1, stdout: '', stderr: 'unknown command'} : implementation(...args));
    expect((await manager.check('codex')).agents[0].authStatus).toBe('unknown');
  });

  it('recognizes documented logged-out statuses', async () => {
    const {manager, runner} = await fixture();
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => {
      if (args[1].join(' ') === 'login status') return {exitCode: 1, stdout: '', stderr: 'Not logged in'};
      if (args[1].join(' ') === 'auth status') return {exitCode: 1, stdout: '{"loggedIn":false}', stderr: ''};
      return implementation(...args);
    });
    const result = await manager.scan();
    expect(result.agents.slice(0, 2).map(({authStatus}) => authStatus)).toEqual(['logged_out', 'logged_out']);
  });

  it('limits discovery to executable files and validates program identity', async () => {
    const {manager, root, runner} = await fixture([]);
    const directory = path.join(root, 'directory');
    await mkdir(directory);
    await expect(manager.scan({agentId: 'codex', executablePath: directory})).rejects.toMatchObject({statusCode: 400});
    const impostor = path.join(root, 'unrelated');
    await writeFile(impostor, '#!/bin/sh\nexit 0\n');
    await chmod(impostor, 0o755);
    runner.mockResolvedValue({exitCode: 0, stdout: 'Unrelated program 1.2.3', stderr: 'secret-value'});
    await expect(manager.scan({agentId: 'codex', executablePath: impostor})).rejects.toMatchObject({statusCode: 400});
    expect(JSON.stringify(await manager.list())).not.toContain('secret-value');
    await expect(manager.scan({agentId: 'unknown'})).rejects.toMatchObject({statusCode: 400});
    await expect(manager.scan({agentId: 'codex', executablePath: 'relative/path'})).rejects.toMatchObject({statusCode: 400});
  });

  it('persists only verified manual paths and resolves symlinks', async () => {
    const {manager, root, bin, options, runner} = await fixture(['codex']);
    const alias = path.join(root, 'codex-custom');
    await symlink(path.join(bin, 'codex'), alias);
    const result = await manager.scan({agentId: 'codex', executablePath: alias});
    expect(result.agents[0].executablePath).toBe(await realpath(path.join(bin, 'codex')));
    const saved = JSON.parse(await readFile(path.join(root, '.vimax/local-agents.json'), 'utf8'));
    expect(saved).toEqual({manualPaths: {codex: alias}});
    expect((await stat(path.join(root, '.vimax/local-agents.json'))).mode & 0o777).toBe(0o600);
    const restarted = createLocalAgentManager({...options, env: {PATH: ''}, runCommand: runner});
    expect((await restarted.check('codex')).agents[0].installed).toBe(true);
  });

  it('reports timeout failures without echoing raw output', async () => {
    const {manager, runner} = await fixture(['gemini']);
    runner.mockResolvedValue({exitCode: null, timedOut: true, stdout: 'token-sensitive-text', stderr: ''});
    const result = await manager.check('gemini');
    expect(result.agents[2].statusMessage).toContain('超时');
    expect(JSON.stringify(result)).not.toContain('token-sensitive-text');
  });

  it('falls back to automatic discovery if the saved manual path disappears', async () => {
    const {manager, root, bin, files} = await fixture(['codex']);
    const custom = path.join(root, 'custom-codex');
    await writeFile(custom, '#!/bin/sh\nexit 0\n');
    await chmod(custom, 0o755);
    files[await realpath(custom)] = 'codex';
    await manager.scan({agentId: 'codex', executablePath: custom});
    await rm(custom);
    expect((await manager.scan()).agents[0].executablePath).toBe(await realpath(path.join(bin, 'codex')));
  });

  it('completes discovery of other Agents after checking a single Agent first', async () => {
    const {manager} = await fixture();
    await manager.check('codex');
    expect((await manager.list()).agents.every((agent) => agent.installed)).toBe(true);
  });

  it('does not equate a working executable with a supported structured interface', async () => {
    const {manager, runner} = await fixture(['claude']);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => args[1][0] === '--help'
      ? {exitCode: 0, stdout: 'Claude Code --print', stderr: ''} : implementation(...args));
    const result = (await manager.check('claude')).agents[1];
    expect(result.installed).toBe(true);
    expect(result.interfaceStatus).toBe('unavailable');
  });

  it('deduplicates simultaneous checks and rejects a test while a check is pending', async () => {
    const {manager, runner} = await fixture(['codex']);
    const first = manager.check('codex');
    const duplicate = manager.check('codex');
    await expect(manager.test('codex')).rejects.toMatchObject({statusCode: 409});
    await Promise.all([first, duplicate]);
    const versionCalls = runner.mock.calls.filter(([, args]) => args[0] === '--version');
    expect(versionCalls).toHaveLength(1);
    const [codex, claude] = await Promise.all([manager.check('codex'), manager.check('claude')]);
    expect(codex.agents[0].installed).toBe(true);
    expect(claude.agents[0].installed).toBe(true);
  });

  it('tests Codex only on explicit request, in a disposable read-only workspace', async () => {
    const {manager, runner, root} = await fixture(['codex']);
    const implementation = runner.getMockImplementation();
    let testCwd;
    runner.mockImplementation(async (...args) => {
      if (!args[1].some((arg) => arg.includes('FRAMEFLOW_OK'))) return implementation(...args);
      testCwd = args[2].cwd;
      expect(testCwd.startsWith(root)).toBe(false);
      expect(args[1]).toContain('read-only');
      expect(args[1]).toContain('--ignore-user-config');
      expect(args[1].slice(0, 3)).toEqual(['--ask-for-approval', 'never', 'exec']);
      return {exitCode: 0, stdout: [
        {type: 'item.completed', item: {type: 'agent_message', text: 'FRAMEFLOW_OK'}},
        {type: 'turn.completed', usage: {input_tokens: 20}},
      ].map((event) => JSON.stringify(event)).join('\n'), stderr: 'private-debug-info'};
    });
    await manager.scan();
    expect(runner.mock.calls.some(([, args]) => args.some((arg) => arg.includes('FRAMEFLOW_OK')))).toBe(false);
    const result = await manager.test('codex');
    expect(result.agents[0].lastTest.status).toBe('passed');
    expect(JSON.stringify(result)).not.toContain('private-debug-info');
    await expect(stat(testCwd)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('requires a successful completion, not a marker echoed by a tool or failed process', async () => {
    const {manager, runner} = await fixture(['codex']);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => args[1].some((arg) => arg.includes('FRAMEFLOW_OK'))
      ? {exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"command_execution","text":"FRAMEFLOW_OK"}}', stderr: ''}
      : implementation(...args));
    expect((await manager.test('codex')).agents[0].lastTest.status).toBe('failed');
  });

  it('blocks Claude tools, MCP and user hooks while testing', async () => {
    const {manager, runner} = await fixture(['claude']);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => {
      if (!args[1].some((arg) => arg.includes('FRAMEFLOW_OK'))) return implementation(...args);
      expect(args[1]).toContain('--strict-mcp-config');
      expect(args[1]).toContain('{"mcpServers":{}}');
      expect(args[1][args[1].indexOf('--tools') + 1]).toBe('');
      expect(args[1][args[1].indexOf('--setting-sources') + 1]).toBe('');
      return {exitCode: 0, stdout: '{"type":"result","is_error":false,"result":"FRAMEFLOW_OK"}', stderr: ''};
    });
    expect((await manager.test('claude')).agents[1].lastTest.status).toBe('passed');
  });

  it('tests Gemini with a per-call deny policy and never changes global settings', async () => {
    const {manager, runner, root} = await fixture(['gemini']);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => {
      if (!args[1].some((arg) => arg.includes('FRAMEFLOW_OK'))) return implementation(...args);
      const policyFile = args[1][args[1].indexOf('--policy') + 1];
      expect(await readFile(policyFile, 'utf8')).toContain('decision = "deny"');
      const settings = JSON.parse(await readFile(path.join(args[2].cwd, '.gemini/settings.json'), 'utf8'));
      expect(settings.tools.core).toEqual([]);
      expect(settings.hooksConfig.enabled).toBe(false);
      expect(args[1][args[1].indexOf('--approval-mode') + 1]).toBe('default');
      return {exitCode: 0, stdout: '{"response":"FRAMEFLOW_OK","stats":{}}', stderr: ''};
    });
    expect((await manager.test('gemini')).agents[2].lastTest.status).toBe('passed');
    await expect(stat(path.join(root, '.gemini'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('invalidates a previous test result when switching executables', async () => {
    const {manager, runner, root, files} = await fixture(['claude']);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (...args) => args[1].some((arg) => arg.includes('FRAMEFLOW_OK'))
      ? {exitCode: 0, stdout: '{"type":"result","result":"FRAMEFLOW_OK"}', stderr: ''} : implementation(...args));
    expect((await manager.test('claude')).agents[1].lastTest.status).toBe('passed');
    const replacement = path.join(root, 'another-claude');
    await writeFile(replacement, '#!/bin/sh\nexit 0\n');
    await chmod(replacement, 0o755);
    files[await realpath(replacement)] = 'claude';
    expect((await manager.scan({agentId: 'claude', executablePath: replacement})).agents[1].lastTest).toBeUndefined();
  });

  it('aborts active commands on dispose and starts no subsequent probe', async () => {
    const {manager, runner} = await fixture(['codex']);
    runner.mockImplementation((executablePath, args, {signal}) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({exitCode: null, errorCode: 'CANCELLED', stdout: '', stderr: ''}));
    }));
    const pending = manager.check('codex');
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    manager.dispose();
    await pending;
    expect(runner.mock.calls).toHaveLength(1);
    await expect(manager.scan()).rejects.toMatchObject({statusCode: 503});
  });

  it('inventories Pi and Hermes from public package metadata without executing either CLI', async () => {
    const {manager, root, bin, runner} = await fixture([]);
    const piRoot = path.join(root, '.local/lib/node_modules/@earendil-works/pi-coding-agent');
    const piCli = path.join(piRoot, 'dist/bundle/cli.js');
    await mkdir(path.dirname(piCli), {recursive: true});
    await writeFile(path.join(piRoot, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '0.85.1', bin: {pi: 'dist/bundle/cli.js'}}));
    await writeFile(piCli, '#!/usr/bin/env node\n'); await chmod(piCli, 0o755); await symlink(piCli, path.join(bin, 'pi'));
    const hermesRoot = path.join(root, '.hermes/hermes-agent');
    const hermesCli = path.join(hermesRoot, 'venv/bin/hermes');
    await mkdir(path.dirname(hermesCli), {recursive: true});
    await writeFile(path.join(hermesRoot, 'pyproject.toml'), '[project]\nname = "hermes-agent"\nversion = "0.11.0"\n[project.scripts]\nhermes = "hermes_cli.main:main"\n');
    await writeFile(hermesCli, '#!/usr/bin/env python3\n'); await chmod(hermesCli, 0o755);
    const snapshot = await manager.scan();
    expect(snapshot.agents.map(({id}) => id)).toEqual(['codex', 'claude', 'gemini', 'pi', 'hermes']);
    expect(snapshot.agents.find(({id}) => id === 'pi')).toMatchObject({installed: true, version: '0.85.1', connectionSupport: 'discovery_only', interfaceStatus: 'unknown', capabilities: {headless: false, structuredOutput: false}, statusMessage: '已发现安装入口，可在执行者设置中使用；连接测试尚未适配'});
    expect(snapshot.agents.find(({id}) => id === 'hermes')).toMatchObject({installed: true, version: '0.11.0', authStatus: 'unknown'});
    expect(runner).not.toHaveBeenCalled();
    await expect(manager.test('pi')).rejects.toMatchObject({statusCode: 400});
    await expect(manager.test('hermes')).rejects.toMatchObject({statusCode: 400});
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports all distinct installations but deduplicates symlink aliases of the same executable', async () => {
    const {manager, root, bin, files, runner, options} = await fixture(['codex']);
    const secondBin = path.join(root, 'second-bin'); await mkdir(secondBin);
    const second = path.join(secondBin, 'codex'); await writeFile(second, '#!/bin/sh\nexit 0\n'); await chmod(second, 0o755); files[await realpath(second)] = 'codex';
    const aliasBin = path.join(root, 'alias-bin'); await mkdir(aliasBin); await symlink(path.join(bin, 'codex'), path.join(aliasBin, 'codex'));
    const expanded = createLocalAgentManager({...options, env: {PATH: [bin, aliasBin, secondBin].join(path.delimiter)}});
    let agent = (await expanded.scan()).agents[0];
    expect(agent.executablePath).toBe(await realpath(path.join(bin, 'codex')));
    expect(agent.installations.map(({path: candidate}) => candidate)).toEqual([await realpath(path.join(bin, 'codex')), await realpath(second)]);
    expect(runner.mock.calls.filter(([, args]) => args[0] === '--version')).toHaveLength(2);
    agent = (await expanded.scan({agentId: 'codex', executablePath: second})).agents[0];
    expect(agent.executablePath).toBe(await realpath(second));
    expect(agent.installations).toHaveLength(2);
  });

  it('includes only discovered or manually registered extras and retains missing manual paths for repair', async () => {
    const {manager, root, runner} = await fixture([]);
    expect((await manager.scan()).agents).toHaveLength(3);
    const manual = path.join(root, 'outside-path', 'opencode'); await mkdir(path.dirname(manual)); await writeFile(manual, '#!/bin/sh\n'); await chmod(manual, 0o755);
    let snapshot = await manager.scan({agentId: 'opencode', executablePath: manual});
    expect(snapshot.agents.find(({id}) => id === 'opencode')).toMatchObject({installed: true, connectionSupport: 'discovery_only'});
    expect(runner).not.toHaveBeenCalled();
    await rm(manual); snapshot = await manager.scan();
    expect(snapshot.agents.find(({id}) => id === 'opencode')).toMatchObject({installed: false, statusMessage: '保存的程序路径不可用，请重新选择'});
    expect(snapshot.scanLocations).toContain(path.dirname(manual));
    expect(snapshot.scanLocations).toContain(path.join(root, '.hermes/hermes-agent/venv/bin'));
    expect(snapshot.scanLocations).toContain(path.join(root, '.cursor-agent/bin'));
  });

  it('rejects unrelated manual executables without persisting or altering the previous snapshot', async () => {
    const {manager, root, runner} = await fixture([]);
    const before = await manager.scan();
    const unrelated = path.join(root, 'unrelated'); await writeFile(unrelated, '#!/bin/sh\n'); await chmod(unrelated, 0o755);
    await expect(manager.scan({agentId: 'hermes', executablePath: unrelated})).rejects.toMatchObject({statusCode: 400, message: '无法确认所选程序的 Agent 身份，请选择实际程序入口'});
    expect(await manager.list()).toEqual(before);
    await expect(readFile(path.join(root, '.vimax/local-agents.json'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(runner).not.toHaveBeenCalled();
  });

  it('accepts a manual alias when matching public package metadata identifies the Agent', async () => {
    const {manager, root, runner} = await fixture([]);
    const packageRoot = path.join(root, 'public-pi-package'); await mkdir(packageRoot);
    const cli = path.join(packageRoot, 'cli.js'); await writeFile(cli, '#!/usr/bin/env node\n'); await chmod(cli, 0o755);
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '0.85.1'}));
    const alias = path.join(root, 'custom-agent-alias'); await symlink(cli, alias);
    const snapshot = await manager.scan({agentId: 'pi', executablePath: alias});
    expect(snapshot.agents.find(({id}) => id === 'pi')).toMatchObject({installed: true, version: '0.85.1', connectionSupport: 'discovery_only'});
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects symlinked, non-file and oversized public metadata without following private targets', async () => {
    const {root, runner} = await fixture([]);
    const definition = LOCAL_AGENT_DEFINITIONS.find(({id}) => id === 'pi');
    const packageRoot = path.join(root, 'public-package'); await mkdir(packageRoot);
    const cli = path.join(packageRoot, 'cli.js'); await writeFile(cli, '#!/usr/bin/env node\n');
    const metadata = path.join(packageRoot, 'package.json');
    const privateTarget = path.join(root, 'private-target.json');
    await writeFile(privateTarget, JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '9.9.9', api_key: 'never-read-this'}));
    await symlink(privateTarget, metadata);
    expect(await staticAgentVersion(definition, cli)).toBe('');
    await rm(metadata); await mkdir(metadata);
    expect(await staticAgentVersion(definition, cli)).toBe('');
    await rm(metadata, {recursive: true});
    await writeFile(metadata, JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '9.9.9', padding: 'x'.repeat(256 * 1024)}));
    expect(await staticAgentVersion(definition, cli)).toBe('');
    expect(runner).not.toHaveBeenCalled();
  });

  it('discovers bundled harness entries and Docker Agent while excluding IDE launch wrappers', async () => {
    const {root, bin, options, runner} = await fixture([]);
    const apps = path.join(root, 'Applications');
    const bundled = {
      dsh: 'DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      lorca: 'Orbi Dev.app/Contents/Resources/bin/lorca',
      aioncore: 'Foundry.app/Contents/Resources/bundled-aioncore/darwin-arm64/aioncore',
      cagent: 'Docker.app/Contents/Resources/cli-plugins/docker-agent',
    };
    for (const relative of Object.values(bundled)) { const cli = path.join(apps, relative); await mkdir(path.dirname(cli), {recursive: true}); await writeFile(cli, '#!/bin/sh\n'); await chmod(cli, 0o755); }
    for (const name of ['cursor', 'trae', 'gpt']) { const cli = path.join(bin, name); await writeFile(cli, '#!/bin/sh\n'); await chmod(cli, 0o755); }
    const inventoryScanner = vi.fn(async () => ({applications: [{id: 'dsh-app', name: 'DeepSeek Harness', path: path.join(apps, 'DeepSeek Harness.app'), version: '0.2.0-rc.2'}], customAgents: [{id: 'defined-agent', name: 'main', path: path.join(root, '.openclaw/agents/main'), source: 'OpenClaw', kind: 'definition'}], scanLocations: [apps], scanWarnings: []}));
    const expanded = createLocalAgentManager({...options, applicationDirectories: [apps], inventoryScanner});
    const snapshot = await expanded.scan();
    expect(snapshot.agents.filter(({installed}) => installed).map(({id}) => id)).toEqual(['cagent', 'dsh', 'lorca', 'aioncore']);
    // An app UI version is not evidence of the embedded CLI version.
    expect(snapshot.agents.find(({id}) => id === 'dsh').version).toBe('');
    expect(snapshot.applications[0].version).toBe('0.2.0-rc.2');
    expect(snapshot.agents.some(({id}) => id === 'cursor')).toBe(false);
    expect(snapshot.applications).toHaveLength(1); expect(snapshot.customAgents).toHaveLength(1); expect(snapshot.scanLocations).toContain(apps);
    expect(inventoryScanner).toHaveBeenCalledTimes(1); expect(runner).not.toHaveBeenCalled();
    await expanded.check('cagent'); expect(inventoryScanner).toHaveBeenCalledTimes(1);
    expect((await expanded.list()).customAgents).toEqual(snapshot.customAgents);
  });

  it('keeps CLI discoveries available when the application inventory fails', async () => {
    const {options} = await fixture(['codex']);
    const expanded = createLocalAgentManager({...options, inventoryScanner: async () => { throw new Error('private-config-path'); }});
    const snapshot = await expanded.scan();
    expect(snapshot.agents[0].installed).toBe(true);
    expect(snapshot.scanWarnings).toEqual(['桌面应用和自定义 Agent 目录盘点未完成，请重新扫描']);
    expect(JSON.stringify(snapshot)).not.toContain('private-config-path');
  });
});

describe('bounded local process runner', () => {
  it('terminates a process that exceeds its timeout', async () => {
    const result = await runLocalCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: os.tmpdir(), env: process.env, timeoutMs: 50, maxOutputBytes: 1024,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('stops oversized output without retaining the excess', async () => {
    const result = await runLocalCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000));setInterval(() => {}, 1000)'], {
      cwd: os.tmpdir(), env: process.env, timeoutMs: 2000, maxOutputBytes: 1024,
    });
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });
});
