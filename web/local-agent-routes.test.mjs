import {describe, expect, it, vi} from 'vitest';
import {createLocalAgentRouter} from './local-agent-routes.mjs';

function fixture() {
  const snapshot = {checkedAt: '2026-10-08T01:00:00Z', agents: [{id: 'codex', installed: true}]};
  const manager = Object.fromEntries(['list', 'scan', 'check', 'test'].map((name) => [name, vi.fn(async () => snapshot)]));
  const sendJson = vi.fn();
  const router = createLocalAgentRouter({manager, readJsonBody: async (request) => request.body, sendJson});
  const response = {setHeader: vi.fn()};
  return {manager, router, response, sendJson, snapshot};
}

const localUrl = (pathname) => new URL(`http://127.0.0.1:4173${pathname}`);
const post = (body, extraHeaders = {}) => ({method: 'POST', headers: {'content-type': 'application/json', ...extraHeaders}, body});

describe('local agent HTTP routes', () => {
  it('discovery never launches a task test', async () => {
    const {router, response, manager, sendJson, snapshot} = fixture();
    expect(await router({method: 'GET', headers: {}}, response, localUrl('/api/local-agents'))).toBe(true);
    expect(sendJson).toHaveBeenCalledWith(response, 200, snapshot);
    expect(manager.test).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('passes an explicitly requested custom path to scanning', async () => {
    const {router, response, manager} = fixture();
    const options = {agentId: 'codex', executablePath: '/custom/codex'};
    await router(post(options), response, localUrl('/api/local-agents/scan'));
    expect(manager.scan).toHaveBeenCalledWith(options);
    expect(manager.test).not.toHaveBeenCalled();
  });

  it('returns the selected agent after an explicit connection test', async () => {
    const {router, response, manager, sendJson, snapshot} = fixture();
    await router(post({agentId: 'codex'}), response, localUrl('/api/local-agents/test'));
    expect(manager.test).toHaveBeenCalledWith('codex');
    expect(sendJson).toHaveBeenCalledWith(response, 200, {agent: snapshot.agents[0]});
  });

  it('rejects cross-origin commands before calling a process operation', async () => {
    const {router, response, manager} = fixture();
    await expect(router(post({agentId: 'codex'}, {origin: 'https://example.com'}), response, localUrl('/api/local-agents/test')))
      .rejects.toMatchObject({statusCode: 403});
    expect(manager.test).not.toHaveBeenCalled();
  });

  it('requires JSON and an explicit agent for test requests', async () => {
    const {router, response, manager} = fixture();
    await expect(router(post({agentId: 'codex'}, {'content-type': 'text/plain'}), response, localUrl('/api/local-agents/test')))
      .rejects.toMatchObject({statusCode: 415});
    await expect(router(post({}), response, localUrl('/api/local-agents/test')))
      .rejects.toMatchObject({statusCode: 400});
    expect(manager.test).not.toHaveBeenCalled();
  });

  it('leaves unrelated routes to the server', async () => {
    const {router, response, manager} = fixture();
    expect(await router({method: 'GET', headers: {}}, response, localUrl('/api/config'))).toBe(false);
    expect(manager.list).not.toHaveBeenCalled();
  });
});
