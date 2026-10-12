import {describe, expect, it} from 'vitest';
import {additionalLocalAgentInstallations, groupLocalAgents, LOCAL_AGENT_OPTIONS, localAgentCommand, localAgentSupportsConnection, localAgentTestAvailability, mergeLocalAgentResult, validateLocalAgentPath} from './localAgents';
import type {LocalAgent, LocalAgentsSnapshot} from './types';

function agent(overrides: Partial<LocalAgent> = {}): LocalAgent {
  return {
    id: 'codex', name: 'Codex', installed: true, executablePath: '/opt/homebrew/bin/codex', version: '1.0.0',
    authStatus: 'logged_in', interfaceStatus: 'available', statusMessage: '接口可用，尚未测试连接',
    capabilities: {headless: true, structuredOutput: true}, ...overrides,
  };
}

describe('local Agent connection eligibility', () => {
  it('does not enable a model task based only on installation or a stale successful test', () => {
    const lastTest = {status: 'passed' as const, checkedAt: '2026-10-08T03:00:00Z', message: '连接测试通过'};
    expect(localAgentTestAvailability(agent({interfaceStatus: 'unknown', lastTest})).enabled).toBe(false);
    expect(localAgentTestAvailability(agent({installed: false, lastTest})).enabled).toBe(false);
    expect(localAgentTestAvailability(agent({authStatus: 'logged_out', lastTest})).enabled).toBe(false);
  });

  it('requires an available headless interface and permits an explicit test when login is unconfirmed', () => {
    expect(localAgentTestAvailability(agent({interfaceStatus: 'unavailable'})).enabled).toBe(false);
    expect(localAgentTestAvailability(agent({capabilities: {headless: false, structuredOutput: true}})).enabled).toBe(false);
    expect(localAgentTestAvailability(agent({authStatus: 'unknown'})).enabled).toBe(true);
    expect(localAgentTestAvailability(agent()).enabled).toBe(true);
  });

  it('never enables discovery-only tools even when old flags or a successful test claim they are usable', () => {
    const lastTest = {status: 'passed' as const, checkedAt: '2026-10-08T03:00:00Z', message: '连接测试通过'};
    expect(localAgentTestAvailability(agent({connectionSupport: 'discovery_only', lastTest}))).toMatchObject({enabled: false});
    expect(localAgentTestAvailability(agent({id: 'pi', connectionSupport: 'discovery_only', lastTest})).enabled).toBe(false);
    expect(localAgentTestAvailability(agent({id: 'hermes', lastTest})).enabled).toBe(false);
    expect(localAgentSupportsConnection(agent({connectionSupport: 'supported'}))).toBe(true);
    expect(localAgentSupportsConnection(agent())).toBe(true);
  });
});

describe('manual local Agent paths', () => {
  it('offers every known tool and preserves executable names that differ from product IDs', () => {
    const ids = LOCAL_AGENT_OPTIONS.map((option) => option.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(localAgentCommand('cursor')).toBe('cursor-agent');
    expect(localAgentCommand('cagent')).toBe('docker-agent');
    expect(LOCAL_AGENT_OPTIONS.find((option) => option.id === 'aioncore')?.command).toBe('aioncore');
  });
  it('accepts an absolute path with spaces and rejects shell-style relative paths', () => {
    expect(validateLocalAgentPath(' /Applications/Local Tools/codex ')).toBe('');
    for (const path of ['', '~/bin/codex', './codex', 'codex']) expect(validateLocalAgentPath(path)).not.toBe('');
  });

  it('rejects multiple lines or embedded null characters', () => {
    expect(validateLocalAgentPath('/opt/homebrew/bin/codex\n/other/path')).not.toBe('');
    expect(validateLocalAgentPath('/opt/homebrew/bin/\0codex')).not.toBe('');
  });
});

describe('local Agent result updates', () => {
  it('keeps desktop, custom discovery, scan scope and warnings unchanged after checking one CLI', () => {
    const snapshot: LocalAgentsSnapshot = {
      checkedAt: '2026-10-08T03:00:00Z', agents: [agent()],
      applications: [{id: 'cursor-app', name: 'Cursor', path: '/Applications/Cursor.app', version: '2', bundleId: 'com.cursor', kind: 'ide', statusMessage: '已发现应用安装'}],
      customAgents: [{id: 'openclaw-main', name: 'main', source: 'OpenClaw', path: '/Users/example/.openclaw/agents/main', kind: 'profile', statusMessage: '已发现运行配置'}],
      scanLocations: ['/Applications'], scanWarnings: ['部分目录未检查'],
    };
    const updated = mergeLocalAgentResult(snapshot, agent({version: '2.0'}));
    expect(updated.applications).toBe(snapshot.applications);
    expect(updated.customAgents).toBe(snapshot.customAgents);
    expect(updated.scanLocations).toBe(snapshot.scanLocations);
    expect(updated.scanWarnings).toBe(snapshot.scanWarnings);
  });

  it('separates installed tools from missing entries without hiding variants or changing order', () => {
    const codex = agent();
    const missing = agent({id: 'claude', installed: false});
    const pi = agent({id: 'pi', connectionSupport: 'discovery_only'});
    expect(groupLocalAgents([missing, codex, pi])).toEqual({installed: [codex, pi], missing: [missing]});
  });

  it('lists distinct additional installations, excluding the primary executable and duplicate paths', () => {
    const original = agent({installations: [
      {path: '/opt/homebrew/bin/codex', version: '1'},
      {path: '/usr/local/bin/codex', version: '2'},
      {path: '/usr/local/bin/codex', version: '2'},
      {path: '', version: ''},
      {path: '/Applications/Tools/codex', version: '3'},
    ]});
    expect(additionalLocalAgentInstallations(original)).toEqual([
      {path: '/usr/local/bin/codex', version: '2'}, {path: '/Applications/Tools/codex', version: '3'},
    ]);
    expect(original.installations).toHaveLength(5);
  });
  it('replaces the checked Agent without changing other results or claiming a new full scan', () => {
    const original = agent();
    const claude = agent({id: 'claude', name: 'Claude'});
    const snapshot: LocalAgentsSnapshot = {checkedAt: '2026-10-08T03:00:00Z', agents: [original, claude]};
    const updated = agent({lastTest: {status: 'failed', checkedAt: '2026-10-08T04:00:00Z', message: '连接超时'}});
    const result = mergeLocalAgentResult(snapshot, updated);

    expect(result.agents).toEqual([updated, claude]);
    expect(result.agents[1]).toBe(claude);
    expect(result.checkedAt).toBe(snapshot.checkedAt);
    expect(snapshot.agents[0]).toBe(original);
    expect(snapshot.agents[0].lastTest).toBeUndefined();
  });

  it('keeps a newly detected Agent when the initial result list was empty', () => {
    const detected = agent();
    expect(mergeLocalAgentResult({checkedAt: '', agents: []}, detected).agents).toEqual([detected]);
  });
});
