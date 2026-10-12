import {createVideoEditorStore, editorError} from './video-editor-store.mjs';
import {createVideoEditorJobs} from './video-editor-jobs.mjs';

const PREFIX = '/api/director/editor';
const HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function createVideoEditorRouter({repoRoot, readJsonBody, sendJson, broadcast = () => {}, executorStore, resolveCommand, spawnProcess, executeAgent, store: injectedStore, jobs: injectedJobs, probeVideo, env, timeoutMs, agentTimeoutMs} = {}) {
  const store = injectedStore || createVideoEditorStore({repoRoot});
  const jobs = injectedJobs || createVideoEditorJobs({repoRoot, store, executorStore, broadcast, resolveCommand, spawnProcess, executeAgent, env, timeoutMs, agentTimeoutMs});
  async function snapshot(id) {
    const agents = await jobs.agents();
    const signature = (entries) => JSON.stringify(entries.map(({id, status}) => ({id, status})));
    for (let attempt = 0; ; attempt += 1) {
      const before = jobs.list(id);
      const project = await store.load(id);
      const after = jobs.list(id);
      if (signature(before) === signature(after)) return {project, jobs: after, agents};
      // A terminal status must never be paired with the pre-commit project.
      // If activity remains very busy, returning the earlier running snapshot
      // keeps polling alive without repeatedly hashing all source files.
      if (attempt >= 3) return {project, jobs: before, agents};
    }
  }
  async function route(request, response, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!HOSTS.has(url.hostname) || (request.headers.origin && request.headers.origin !== url.origin) || request.headers['sec-fetch-site'] === 'cross-site') throw editorError('视频编辑仅允许来自 FrameFlow 本地页面的请求', 403, 'invalid_origin');
    response.setHeader('Cache-Control', 'no-store');
    let body = {};
    if (['POST', 'PUT'].includes(request.method)) {
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw editorError('请求内容必须为 JSON', 415);
      body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw editorError('请求内容无效', 400);
    }
    const id = url.searchParams.get('session') || url.searchParams.get('sessionId') || body.sessionId || body.project?.sessionId || '';
    await store.session(id);
    if (url.pathname === PREFIX) {
      if (request.method === 'GET') sendJson(response, 200, await snapshot(id));
      else if (request.method === 'PUT') { await jobs.mutate(id, () => store.save(id, body.project || body)); broadcast({type: 'director_changed', sessionId: id}); sendJson(response, 200, await snapshot(id)); }
      else sendJson(response, 405, {error: '此接口需要 GET 或 PUT 请求'});
      return true;
    }
    const action = url.pathname.slice(PREFIX.length + 1);
    if (!['sources', 'plan', 'render', 'cancel'].includes(action)) { sendJson(response, 404, {error: '未找到视频编辑接口'}); return true; }
    if (request.method !== 'POST') { sendJson(response, 405, {error: '此操作需要 POST 请求'}); return true; }
    let job;
    if (action === 'sources') { await jobs.mutate(id, () => store.importSources(id, body, probeVideo || jobs.probe)); broadcast({type: 'director_changed', sessionId: id}); }
    else if (action === 'cancel') { if (typeof body.jobId !== 'string') throw editorError('请选择要取消的任务'); job = await jobs.cancel(id, body.jobId); }
    else job = await jobs.start(id, action, body.revision);
    sendJson(response, ['plan', 'render'].includes(action) ? 202 : 200, {...await snapshot(id), ...(job ? {job} : {})});
    return true;
  }
  route.dispose = () => jobs.dispose(); route.cancelSession = (id) => jobs.cancelSession(id); route.store = store; route.jobs = jobs;
  return route;
}
