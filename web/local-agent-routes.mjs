const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ACTIONS = new Set(['scan', 'check', 'test']);

export function createLocalAgentRouter({manager, readJsonBody, sendJson}) {
  return async function routeLocalAgents(request, response, url) {
    if (url.pathname !== '/api/local-agents' && !url.pathname.startsWith('/api/local-agents/')) return false;
    validateRequestOrigin(request, url);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/api/local-agents' && request.method === 'GET') {
      sendJson(response, 200, await manager.list());
      return true;
    }
    const action = url.pathname.slice('/api/local-agents/'.length);
    if (!ACTIONS.has(action)) {
      sendJson(response, 404, {error: '未找到本地 Agent 接口'});
      return true;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, {error: '此操作需要使用 POST 请求'});
      return true;
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      throw requestError('请求内容必须为 JSON', 415);
    }
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError('请求内容无效', 400);
    if (action !== 'scan' && typeof body.agentId !== 'string') throw requestError('请选择本地 Agent', 400);
    const snapshot = action === 'scan'
      ? await manager.scan({agentId: body.agentId, executablePath: body.executablePath})
      : await manager[action](body.agentId);
    if (action === 'scan') sendJson(response, 200, snapshot);
    else {
      const agent = snapshot.agents.find((item) => item.id === body.agentId);
      if (!agent) throw requestError('不支持此本地 Agent', 400);
      sendJson(response, 200, {agent});
    }
    return true;
  };
}

function validateRequestOrigin(request, url) {
  const origin = request.headers.origin;
  if (!LOCAL_HOSTS.has(url.hostname) || (origin && origin !== url.origin)
      || request.headers['sec-fetch-site'] === 'cross-site') {
    throw requestError('本地 Agent 操作仅允许来自 FrameFlow 本地页面', 403);
  }
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), {statusCode});
}
