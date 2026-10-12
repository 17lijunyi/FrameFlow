import {createReadStream, existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readAgentConfig, saveAgentConfig} from './config-store.mjs';
import {createLocalAgentManager} from './local-agents.mjs';
import {createLocalAgentRouter} from './local-agent-routes.mjs';
import {createExecutorStore, detectedExecutorOptions} from './executor-store.mjs';
import {createExecutorRouter} from './executor-routes.mjs';
import {createAgentBridge} from './agent-bridge.mjs';
import {createDirectorRouter} from './director-routes.mjs';
import {createVideoEditorRouter} from './video-editor-routes.mjs';
import {streamFile} from './artifact-stream.mjs';
import {
  artifactContentType,
  deleteSession,
  listSessionArtifacts,
  readSessionHistory,
  readSessionState,
  resolveArtifactPath,
  storeWorkspaceUpload,
} from './server-lib.mjs';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, '..');
const isDev = process.argv.includes('--dev');
const host = process.env.VIMAX_WEB_HOST || '127.0.0.1';
const port = Number(process.env.VIMAX_WEB_PORT || 4173);
const configuredUploadLimit = Number(process.env.VIMAX_WEB_UPLOAD_MAX_BYTES || 100 * 1024 * 1024);
const uploadMaxBytes = Number.isFinite(configuredUploadLimit) && configuredUploadLimit > 0
  ? configuredUploadLimit
  : 100 * 1024 * 1024;
const subscribers = new Set();

const agentBridge = createAgentBridge({
  repoRoot, resolveCommand: agentCommand,
  readSessions: () => readSessionState(repoRoot), broadcast,
});

const localAgents = createLocalAgentManager({repoRoot});
const routeLocalAgents = createLocalAgentRouter({manager: localAgents, readJsonBody, sendJson});
const executorStore = createExecutorStore({repoRoot, manager: localAgents, onSaved: () => agentBridge.stop('config')});
const routeExecutors = createExecutorRouter({store: executorStore, readJsonBody, sendJson});
const routeDirector = createDirectorRouter({repoRoot, readJsonBody, sendJson, broadcast});
const routeVideoEditor = createVideoEditorRouter({
  repoRoot, readJsonBody, sendJson, broadcast,
  executorStore: {read: async () => ({options: detectedExecutorOptions(
    await localAgents.list(), {sections: {llm: {}, image: {}, video: {}}}, {},
  ).filter((option) => option.kind === 'cli')})},
});

let vite = null;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (await routeLocalAgents(request, response, url)) return;
    if (await routeExecutors(request, response, url)) return;
    if (await routeVideoEditor(request, response, url)) return;
    if (await routeDirector(request, response, url)) return;
    if (url.pathname === '/api/events' && request.method === 'GET') {
      return openEventStream(request, response);
    }
    if (url.pathname === '/api/sessions' && request.method === 'GET') {
      return sendJson(response, 200, await readSessionState(repoRoot));
    }
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return sendJson(response, 200, await readAgentConfig(repoRoot));
    }
    if (url.pathname === '/api/config' && request.method === 'PUT') {
      const origin = request.headers.origin;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || (origin && origin !== url.origin)
        || request.headers['sec-fetch-site'] === 'cross-site') {
        throw Object.assign(new Error('模型配置仅允许来自 FrameFlow 本地页面'), {statusCode: 403});
      }
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
        throw Object.assign(new Error('请求内容必须为 JSON'), {statusCode: 415});
      }
      const config = await saveAgentConfig(repoRoot, await readJsonBody(request));
      agentBridge.stop('config');
      return sendJson(response, 200, config);
    }
    if (url.pathname === '/api/sessions' && request.method === 'DELETE') {
      const sessionId = url.searchParams.get('session') || '';
      const current = await readSessionState(repoRoot);
      if (!current.sessions.some((session) => session.sessionId === sessionId)) {
        return sendJson(response, 404, {error: '项目不存在'});
      }
      if (sessionId === agentBridge.activeSessionId) agentBridge.stop('delete');
      await routeDirector.cancelSession(sessionId);
      await routeVideoEditor.cancelSession(sessionId);
      const state = await deleteSession(repoRoot, sessionId);
      agentBridge.activeSessionId = state.activeSessionId;
      broadcast({type: 'sessions_changed', ...state});
      return sendJson(response, 200, state);
    }
    if (url.pathname === '/api/history' && request.method === 'GET') {
      return sendJson(response, 200, {messages: await readSessionHistory(repoRoot, url.searchParams.get('session') || '')});
    }
    if (url.pathname === '/api/artifacts' && request.method === 'GET') {
      return sendJson(response, 200, {artifacts: await listSessionArtifacts(repoRoot, url.searchParams.get('session') || '')});
    }
    if (url.pathname === '/api/artifact' && ['GET', 'HEAD'].includes(request.method)) {
      return streamArtifact(request, response, url.searchParams.get('session') || '', url.searchParams.get('path') || '');
    }
    if (url.pathname === '/api/uploads' && request.method === 'POST') {
      const sessionId = url.searchParams.get('session') || '';
      const fileName = url.searchParams.get('name') || '';
      const current = await readSessionState(repoRoot);
      if (!current.sessions.some((session) => session.sessionId === sessionId)) {
        return sendJson(response, 404, {error: '项目不存在'});
      }
      const declaredSize = Number(request.headers['content-length'] || 0);
      if (declaredSize > uploadMaxBytes) {
        return sendJson(response, 413, {error: `文件超过 ${formatByteLimit(uploadMaxBytes)} 的上传上限`});
      }
      const data = await readBinaryBody(request, uploadMaxBytes);
      const file = await storeWorkspaceUpload(repoRoot, sessionId, fileName, data);
      return sendJson(response, 201, {file});
    }
    if (url.pathname === '/api/agent/start' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
      if (projectName.length > 64) {
        return sendJson(response, 400, {error: '项目名称不能超过 64 个字符'});
      }
      await agentBridge.start({newSession: body.newSession === true, sessionId, projectName});
      return sendJson(response, 200, {ok: true});
    }
    if (url.pathname === '/api/messages' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(response, 400, {error: '请输入消息内容'});
      agentBridge.sendMessage(text);
      return sendJson(response, 202, {ok: true});
    }
    if (url.pathname === '/api/agent/stop' && request.method === 'POST') {
      agentBridge.stop('user');
      return sendJson(response, 200, {ok: true});
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return sendJson(response, 200, {ok: true, agentRunning: agentBridge.running,
        agentStatus: agentBridge.snapshot().status, activeSessionId: agentBridge.activeSessionId});
    }
    if (url.pathname === '/assets/vimax.png' && request.method === 'GET') {
      response.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600'});
      createReadStream(path.join(repoRoot, 'assets', 'vimax.png')).pipe(response);
      return;
    }
    if (vite) {
      vite.middlewares(request, response, () => sendJson(response, 404, {error: '未找到资源'}));
      return;
    }
    return serveProductionApp(response, url.pathname);
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    sendJson(response, status, {error: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === 'string' ? {code: error.code} : {}),
      ...(typeof error?.phase === 'string' ? {phase: error.phase} : {}),
      ...(error?.action === 'open_settings' ? {action: error.action} : {})});
  }
});

if (isDev) {
  vite = await (await import('vite')).createServer({
    root: webRoot,
    server: {middlewareMode: true, hmr: {server}},
    appType: 'spa',
  });
}

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`FrameFlow Web: http://${host}:${actualPort}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function openEventStream(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(`data: ${JSON.stringify(agentBridge.snapshot())}\n\n`);
  subscribers.add(response);
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
  request.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
  });
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const subscriber of subscribers) subscriber.write(payload);
}

function agentCommand() {
  if (process.env.VIMAX_AGENT_COMMAND) {
    return {command: process.env.VIMAX_AGENT_COMMAND, args: splitArgs(process.env.VIMAX_AGENT_ARGS || '')};
  }
  const configuredPython = process.env.VIMAX_PYTHON_CMD;
  if (configuredPython) return {command: configuredPython, args: []};
  const bundledUv = process.env.VIMAX_UV_CMD || path.join(process.env.HOME || '', '.local', 'bin', 'uv');
  if (bundledUv && existsSync(bundledUv)) return {command: bundledUv, args: ['run', 'python']};
  const venvPython = path.join(repoRoot, '.venv', 'bin', 'python3');
  if (existsSync(venvPython)) return {command: venvPython, args: []};
  return {command: 'uv', args: ['run', 'python']};
}

function splitArgs(value) {
  return value.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length > 1_000_000) throw new Error('请求内容过大');
  return JSON.parse(text);
}

async function readBinaryBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`文件超过 ${formatByteLimit(maxBytes)} 的上传上限`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function formatByteLimit(bytes) {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function sendJson(response, status, payload) {
  if (response.writableEnded) return;
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(payload));
}

async function streamArtifact(request, response, sessionId, relativePath) {
  const filePath = resolveArtifactPath(repoRoot, sessionId, relativePath);
  if (!existsSync(filePath)) return sendJson(response, 404, {error: '作品文件不存在'});
  return streamFile(request, response, filePath, artifactContentType(filePath));
}

async function serveProductionApp(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(webRoot, 'dist', requested);
  const distRoot = path.resolve(webRoot, 'dist');
  const safeCandidate = candidate.startsWith(`${distRoot}${path.sep}`) ? candidate : path.join(distRoot, 'index.html');
  const filePath = existsSync(safeCandidate) ? safeCandidate : path.join(distRoot, 'index.html');
  const body = await readFile(filePath);
  response.writeHead(200, {'Content-Type': artifactContentType(filePath)});
  response.end(body);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(0), 5_000);
  deadline.unref();
  agentBridge.dispose();
  localAgents.dispose();
  await Promise.allSettled([routeDirector.dispose(), routeVideoEditor.dispose()]);
  server.close();
  process.exit(0);
}
