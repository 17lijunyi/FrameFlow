import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAgentBridge} from './agent-bridge.mjs';

const bridges = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  vi.useRealTimers();
});

function fixture({startupTimeoutMs = 1000, readSessions = async () => ({activeSessionId: 'project-1', sessions: []}), spawnFailure} = {}) {
  const events = [];
  const children = [];
  const terminate = vi.fn();
  const spawn = vi.fn(() => {
    if (spawnFailure) throw new Error('private-spawn-diagnostic');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.write = vi.fn(child.stdin.write.bind(child.stdin));
    child.emitJson = (event) => child.stdout.write(JSON.stringify(event) + '\n');
    child.exit = (code, signal = null) => {
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    };
    children.push(child);
    return child;
  });
  const bridge = createAgentBridge({repoRoot: '/private/test-project', resolveCommand: () => ({command: '/fake/python', args: []}),
    readSessions, broadcast: (event) => events.push(event), spawnProcess: spawn,
    terminateProcess: terminate, startupTimeoutMs});
  bridges.push(bridge);
  return {bridge, children, events, spawn, terminate};
}

describe('Agent runtime bridge handshake', () => {
  it('keeps startup pending until a complete explicit ready event arrives', async () => {
    vi.useFakeTimers();
    const {bridge, children} = fixture();
    let completed = false;
    const start = bridge.start({sessionId: 'project-1'}).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(400);
    expect(completed).toBe(false);
    expect(bridge.snapshot().status).toBe('starting');
    expect(() => bridge.sendMessage('hello')).toThrow('正在启动');
    children[0].stdout.write('{"type":"rea');
    children[0].stdout.write('dy"}\n');
    await start;
    expect(bridge.snapshot().status).toBe('ready');
    bridge.sendMessage('创作一个故事');
    expect(children[0].stdin.write).toHaveBeenCalledWith('创作一个故事\n');
  });

  it('returns structured missing-key errors and buffers startup stderr as one bounded diagnostic', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    children[0].stderr.write('line one\nline two\n');
    children[0].stderr.write('api_key=sk-privateTokenValue1234\n');
    expect(events.filter(({type}) => type === 'terminal')).toHaveLength(0);
    children[0].emitJson({type: 'error', phase: 'startup', code: 'missing_llm_api_key', action: 'open_settings', message: '请先配置创作助手密钥'});
    await expect(start).rejects.toMatchObject({statusCode: 422, phase: 'startup', code: 'missing_llm_api_key', action: 'open_settings'});
    expect(bridge.snapshot()).toMatchObject({status: 'error', code: 'missing_llm_api_key', action: 'open_settings'});
    const diagnostics = events.filter(({type}) => type === 'terminal');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toContain('line one\nline two');
    expect(JSON.stringify(events)).not.toContain('sk-privateTokenValue1234');
    expect(() => bridge.sendMessage('message')).toThrow('请先配置');
  });

  it('does not declare ready when an unconfigured process creates session metadata then exits', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start({newSession: true});
    children[0].emitJson({type: 'session', session: {active_session_id: 'created-session'}});
    children[0].exit(1);
    await expect(start).rejects.toMatchObject({code: 'runtime_startup_failed', statusCode: 500});
    expect(events.some((event) => event.type === 'bridge_status' && event.status === 'ready')).toBe(false);
    expect(bridge.running).toBe(false);
  });

  it('turns a stalled startup into a bounded timeout and terminates only its own child', async () => {
    vi.useFakeTimers();
    const {bridge, children, terminate} = fixture({startupTimeoutMs: 50});
    const start = bridge.start();
    const rejected = expect(start).rejects.toMatchObject({code: 'agent_start_timeout', statusCode: 504});
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(bridge.snapshot().status).toBe('error');
    expect(terminate).toHaveBeenCalledWith(children[0], 'SIGTERM');
    expect(children[0].stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(terminate).not.toHaveBeenCalledWith(children[0], 'SIGKILL');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(terminate).toHaveBeenCalledWith(children[0], 'SIGKILL');
  });

  it.each(['user', 'config', 'delete', 'shutdown'])('cancels pending startup when stopped for %s', async (reason) => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    bridge.stop(reason);
    await expect(start).rejects.toMatchObject({code: 'agent_start_cancelled', statusCode: 409});
    children[0].emitJson({type: 'ready'});
    expect(bridge.snapshot().status).toBe('stopped');
    expect(events.some((event) => event.type === 'bridge_status' && event.status === 'ready')).toBe(false);
  });

  it('ignores stale ready, session, stderr and exit events after switching projects', async () => {
    const {bridge, children, events} = fixture();
    const first = bridge.start({sessionId: 'old'});
    const second = bridge.start({sessionId: 'new'});
    await expect(first).rejects.toMatchObject({code: 'agent_start_cancelled'});
    children[0].emitJson({type: 'ready'});
    children[0].emitJson({type: 'session', session: {active_session_id: 'old'}});
    children[0].stderr.write('obsolete diagnostic');
    children[0].exit(1);
    expect(bridge.activeSessionId).toBe('new');
    expect(bridge.snapshot().status).toBe('starting');
    expect(events.some((event) => event.line?.includes('obsolete'))).toBe(false);
    children[1].emitJson({type: 'ready'});
    await second;
    expect(bridge.snapshot().status).toBe('ready');
  });

  it('ignores session reads that finish after cancellation', async () => {
    let resolveSessions;
    const {bridge, children, events} = fixture({readSessions: () => new Promise((resolve) => { resolveSessions = resolve; })});
    const start = bridge.start({sessionId: 'current'});
    children[0].emitJson({type: 'ready'});
    await start;
    bridge.stop('delete');
    bridge.activeSessionId = 'remaining';
    resolveSessions({activeSessionId: 'deleted', sessions: []});
    await Promise.resolve();
    expect(bridge.activeSessionId).toBe('remaining');
    expect(events.some((event) => event.type === 'sessions_changed')).toBe(false);
  });

  it('does not flood terminal entries when runtime stderr contains many lines', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    children[0].emitJson({type: 'ready'});
    await start;
    children[0].stderr.write('one\ntwo\nthree\n');
    const diagnostics = events.filter(({type}) => type === 'terminal');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].line).toBe('one\ntwo\nthree\n');
  });

  it('bounds startup diagnostics and reports spawn failures without private exception text', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    children[0].stderr.write('x'.repeat(50_000));
    children[0].emit('error', new Error('private-child-error'));
    await expect(start).rejects.toMatchObject({code: 'agent_spawn_failed'});
    expect(events.find(({type}) => type === 'terminal').line.length).toBeLessThan(12_100);
    expect(JSON.stringify(events)).not.toContain('private-child-error');
    const failed = fixture({spawnFailure: true});
    await expect(failed.bridge.start()).rejects.toMatchObject({code: 'agent_spawn_failed'});
    expect(failed.bridge.snapshot().status).toBe('error');
    expect(JSON.stringify(failed.events)).not.toContain('private-spawn-diagnostic');
  });

  it('updates readiness after runtime exit and refuses writes to disconnected stdin', async () => {
    const {bridge, children} = fixture();
    const start = bridge.start();
    children[0].emitJson({type: 'ready'});
    await start;
    children[0].exit(2);
    expect(bridge.snapshot()).toMatchObject({status: 'error', code: 'agent_runtime_exited'});
    expect(() => bridge.sendMessage('test')).toThrow('意外退出');
  });

  it('rejects incompatible session options without replacing a ready process', async () => {
    const {bridge, children, spawn} = fixture();
    const start = bridge.start();
    children[0].emitJson({type: 'ready'});
    await start;
    await expect(bridge.start({newSession: true, sessionId: 'existing'})).rejects.toMatchObject({statusCode: 400});
    expect(bridge.snapshot().status).toBe('ready');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('drains structured startup errors after exit instead of replacing them with a generic failure', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    children[0].emit('exit', 1, null);
    expect(bridge.snapshot().status).toBe('starting');
    expect(bridge.running).toBe(false);
    children[0].emitJson({type: 'error', phase: 'startup', code: 'missing_llm_api_key',
      action: 'open_settings', message: '请先配置文本模型'});
    children[0].emit('close', 1, null);
    await expect(start).rejects.toMatchObject({code: 'missing_llm_api_key', statusCode: 422, action: 'open_settings'});
    expect(events.filter(({type}) => type === 'error')).toHaveLength(1);
  });

  it('parses a final structured startup error without a trailing newline when stdio closes', async () => {
    const {bridge, children} = fixture();
    const start = bridge.start();
    children[0].emit('exit', 1, null);
    children[0].stdout.write(JSON.stringify({type: 'error', phase: 'startup', code: 'invalid_config',
      action: 'open_settings', message: '请修正模型配置'}));
    children[0].emit('close', 1, null);
    await expect(start).rejects.toMatchObject({code: 'invalid_config', statusCode: 422, action: 'open_settings'});
  });

  it('does not accept a late ready event from a process that has already exited', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    children[0].emit('exit', 0, null);
    children[0].emitJson({type: 'ready'});
    children[0].emit('close', 0, null);
    await expect(start).rejects.toMatchObject({code: 'runtime_startup_failed'});
    expect(events.some((event) => event.type === 'bridge_status' && event.status === 'ready')).toBe(false);
  });

  it('retains final runtime events while refusing writes after exit', async () => {
    const {bridge, children, events} = fixture();
    const start = bridge.start();
    children[0].emitJson({type: 'ready'});
    await start;
    children[0].emit('exit', 0, null);
    expect(() => bridge.sendMessage('late message')).toThrow();
    children[0].emitJson({type: 'done', assistant: 'final response'});
    children[0].emit('close', 0, null);
    expect(events.some((event) => event.type === 'done' && event.assistant === 'final response')).toBe(true);
    expect(bridge.snapshot().status).toBe('stopped');
  });

  it('clears the kill timer after a stopped child closes, including after switching projects', async () => {
    vi.useFakeTimers();
    const {bridge, children, terminate} = fixture();
    const first = bridge.start({sessionId: 'old'});
    const second = bridge.start({sessionId: 'new'});
    await expect(first).rejects.toMatchObject({code: 'agent_start_cancelled'});
    children[0].exit(0, 'SIGTERM');
    children[1].emitJson({type: 'ready'});
    await second;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminate.mock.calls.filter(([child]) => child === children[0])).toEqual([[children[0], 'SIGTERM']]);
    expect(bridge.snapshot().status).toBe('ready');
    bridge.dispose();
    bridge.dispose();
    expect(terminate.mock.calls.filter(([child]) => child === children[1])).toEqual([[children[1], 'SIGTERM']]);
    children[1].exit(0, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(terminate.mock.calls.filter(([child]) => child === children[1])).toEqual([[children[1], 'SIGTERM']]);
  });
});
