import {createDirectorStore, directorError} from './director-store.mjs';
import {createDirectorJobs} from './director-jobs.mjs';

const HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function createDirectorRouter({repoRoot, readJsonBody, sendJson, broadcast = () => {}, resolveCommand, store: injectedStore, jobs: injectedJobs, spawnProcess, queryCapabilities, createSessionCommand} = {}) {
  const store = injectedStore || createDirectorStore({repoRoot, createSessionCommand});
  const jobs = injectedJobs || createDirectorJobs({repoRoot, store, broadcast, resolveCommand, spawnProcess, queryCapabilities});
  async function snapshot(sessionId) {
    const capabilities = await jobs.capabilities();
    const signature = (entries) => JSON.stringify(entries.map(({id, status}) => ({id, status})));
    for (let attempt = 0; ; attempt += 1) {
      const before = jobs.list(sessionId);
      const project = await store.load(sessionId);
      const after = jobs.list(sessionId);
      if (signature(before) === signature(after)) return {project, jobs: after, capabilities};
      // Completion commits its version/export before changing job status.
      // Reload if it crossed this read; a bounded earlier running snapshot
      // keeps the client polling when several jobs are changing at once.
      if (attempt >= 3) return {project, jobs: before, capabilities};
    }
  }
  async function route(request, response, url) {
    const createSession = url.pathname === '/api/sessions' && request.method === 'POST';
    if (!createSession && url.pathname !== '/api/director' && !url.pathname.startsWith('/api/director/')) return false;
    if (!HOSTS.has(url.hostname) || (request.headers.origin && request.headers.origin !== url.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw directorError('导演台仅允许来自 FrameFlow 本地页面的请求', 403, 'invalid_origin');
    response.setHeader('Cache-Control', 'no-store');
    const readBody = async () => {
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw directorError('请求内容必须为 JSON', 415);
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw directorError('请求内容无效');
      return body;
    };
    if (createSession) {
      const body = await readBody();
      const result = await store.create(body.projectName);
      broadcast({type: 'sessions_changed', activeSessionId: result.activeSessionId, sessions: result.sessions});
      sendJson(response, 201, result);
      return true;
    }
    let body = {};
    if (request.method === 'POST' || request.method === 'PUT') body = await readBody();
    const sessionId = url.searchParams.get('session') || url.searchParams.get('sessionId') || body.sessionId || body.project?.sessionId || '';
    await store.session(sessionId);
    if (url.pathname === '/api/director') {
      if (request.method === 'GET') sendJson(response, 200, await snapshot(sessionId));
      else if (request.method === 'PUT') {
        await store.save(sessionId, body.project || body);
        broadcast({type: 'director_changed', sessionId});
        sendJson(response, 200, await snapshot(sessionId));
      } else sendJson(response, 405, {error: '此接口需要使用 GET 或 PUT 请求'});
      return true;
    }
    const action = url.pathname.slice('/api/director/'.length);
    if (!['import', 'render', 'cancel', 'export'].includes(action)) {
      sendJson(response, 404, {error: '未找到导演台接口'}); return true;
    }
    if (request.method !== 'POST') { sendJson(response, 405, {error: '此操作需要使用 POST 请求'}); return true; }
    let job;
    if (action === 'import') {
      await store.importPlan(sessionId, body); broadcast({type: 'director_changed', sessionId});
    } else if (action === 'cancel') {
      if (typeof body.jobId !== 'string') throw directorError('请选择要取消的任务');
      job = await jobs.cancel(sessionId, body.jobId);
    } else {
      if (action === 'render' && typeof body.shotId !== 'string') throw directorError('请选择要生成的镜头');
      if (body.revision !== undefined && body.revision !== (await store.load(sessionId)).revision) throw directorError('计划已被更新，请重新载入后再生成或导出', 409, 'revision_conflict');
      job = await jobs.start(sessionId, action, body.shotId, body.revision);
    }
    sendJson(response, action === 'render' || action === 'export' ? 202 : 200, {...await snapshot(sessionId), ...(job ? {job} : {})});
    return true;
  }
  route.dispose = () => jobs.dispose();
  route.cancelSession = (sessionId) => jobs.cancelSession(sessionId);
  route.store = store;
  route.jobs = jobs;
  return route;
}
