import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {artifactUrl, defaultPython, directorError, ensureDirectorOutput, safePath} from './director-store.mjs';

const ACTIVE = new Set(['queued', 'running']);
const VIDEOS = new Set(['.mp4', '.webm', '.mov']);
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const KNOWN_CODES = new Set(['missing_video_api_key', 'invalid_config', 'unsupported_video_provider', 'unsupported_video_settings', 'video_generation_failed', 'wan_video_config', 'wan_video_failed', 'export_failed', 'invalid_request', 'unsafe_artifact_path', 'cancelled']);

export function createDirectorJobs({repoRoot, store, broadcast = () => {}, resolveCommand = () => defaultPython(repoRoot), spawnProcess = spawn, queryCapabilities, timeoutMs = 60 * 60_000, env = process.env} = {}) {
  const contexts = new Map();
  const closedSessions = new Set();
  const metadataChildren = new Set();
  let capabilityCache = null;
  let disposed = false;
  function assertCanStart(sessionId) {
    if (disposed) throw directorError('导演服务正在关闭', 503, 'director_unavailable');
    if (closedSessions.has(sessionId)) throw directorError('项目已关闭或删除，无法启动新任务', 409, 'director_session_cancelled');
  }
  function emit(context) {
    context.job.updatedAt = new Date().toISOString();
    broadcast({type: 'director_changed', sessionId: context.job.sessionId});
  }
  function list(sessionId) { return [...contexts.values()].filter((context) => context.job.sessionId === sessionId).map(({job}) => structuredClone(job)); }
  async function capabilities() {
    let config;
    try { config = await videoConfiguration(repoRoot, env); }
    catch { return {videoConfigured: false, configured: false, canExport: true, supported: false, supportsFirstFrame: false, supportsLastFrame: false, message: '视频配置格式有误；仍可编辑、保存和导出已有视频'}; }
    const base = {videoConfigured: config.hasApiKey, configured: config.hasApiKey, canExport: true, provider: '', model: config.model, supported: false, supportsFirstFrame: false, supportsLastFrame: false, multiReference: false, comfyUI: false, maxImages: 2};
    const signature = config.signature;
    if (capabilityCache?.signature === signature && (capabilityCache.pending || capabilityCache.expires > Date.now())) return capabilityCache.promise;
    const entry = {signature, pending: true, expires: 0, promise: null};
    capabilityCache = entry;
    entry.promise = (async () => {
      try {
        const supplied = queryCapabilities ? await queryCapabilities() : await readCapabilities(await resolveCommand(), repoRoot, spawnProcess, env, metadataChildren);
        return {...base, ...supplied, message: supplied.message || supplied.reason || supplied.notice || '', supportsFirstFrame: supplied.supportsFirstFrame ?? supplied.firstFrame ?? false, supportsLastFrame: supplied.supportsLastFrame ?? supplied.firstLastFrame ?? false, videoConfigured: config.hasApiKey, configured: config.hasApiKey};
      } catch { return {...base, message: '视频生成驱动暂不可用；仍可编辑和保存镜头计划'}; }
      finally { entry.pending = false; entry.expires = Date.now() + 3_000; }
    })();
    return entry.promise;
  }

  async function start(sessionId, operation, shotId, revision) {
    assertCanStart(sessionId);
    const {directory} = await store.session(sessionId);
    const key = `${sessionId}:${operation}:${shotId || ''}`;
    if ([...contexts.values()].some((context) => context.key === key && ACTIVE.has(context.job.status))) throw directorError('此任务已在运行，请等待完成或先取消', 409, 'director_job_busy');
    const project = await store.load(sessionId);
    if (revision !== undefined && revision !== project.revision) throw directorError('计划已更新，请重新载入后再生成或导出', 409, 'revision_conflict');
    const request = {operation, repoRoot, sessionId, sessionDir: directory, settings: project.settings, configPath: path.join(repoRoot, 'configs', 'agent.local.yaml')};
    let requestFingerprint;
    let aspectRatioFromImage = false;
    if (operation === 'render') {
      const config = await videoConfiguration(repoRoot, env);
      const shot = project.shots.find((item) => item.id === shotId);
      if (!shot) throw directorError('镜头不存在', 404, 'shot_not_found');
      if (!shot.prompt.trim()) throw directorError('请先填写镜头提示词', 422, 'empty_shot_prompt');
      if (!config.hasApiKey) throw directorError('请在设置中填写视频生成服务的 API 密钥', 422, 'missing_video_api_key', 'open_settings');
      request.shot = {id: shot.id, prompt: shot.prompt, duration: shot.duration};
      for (const field of ['firstFrame', 'lastFrame']) if (shot[field]) request.shot[field] = await safePath(directory, shot[field], IMAGE_TYPES);
      const caps = await capabilities();
      validateSettings(project.settings, shot, caps);
      aspectRatioFromImage = caps.aspectRatioFromImage === true;
      requestFingerprint = await store.fingerprint(directory, project.settings, shot, false, {aspectRatioFromImage});
    } else if (operation === 'export') {
      if (project.shots.length > 200) throw directorError('一次最多导出 200 个镜头，请拆分项目', 422, 'too_many_export_clips');
      if (!project.shots.length) throw directorError('请先添加镜头并生成视频', 422, 'empty_director_plan');
      request.clips = [];
      for (const shot of project.shots) {
        const version = shot.versions.find((item) => item.id === shot.selectedVersionId);
        if (!version) throw directorError(`「${shot.title}」尚未选择视频，无法导出`, 422, 'missing_selected_video');
        if (version.stale) throw directorError(`「${shot.title}」的视频已过期，请重新生成或恢复原设置`, 422, 'stale_selected_video');
        if (version.missing) throw directorError(`「${shot.title}」的视频文件已丢失，无法导出`, 422, 'missing_selected_video');
        const clipPath = await safePath(directory, version.path, VIDEOS);
        request.clips.push({path: clipPath, shotId: shot.id, duration: version.duration});
      }
      requestFingerprint = store.exportFingerprint(project);
    } else throw directorError('未知导演任务');
    // Reserving after preflight and before the first await prevents concurrent duplicate starts.
    // Deletion/shutdown can happen during the asynchronous preflight above.
    assertCanStart(sessionId);
    if ([...contexts.values()].some((context) => context.key === key && ACTIVE.has(context.job.status))) throw directorError('此任务已在运行', 409, 'director_job_busy');
    const now = new Date().toISOString();
    const job = {id: `job-${randomUUID()}`, sessionId, operation, ...(shotId ? {shotId} : {}), status: 'queued', progress: 0, message: '任务等待启动', createdAt: now, updatedAt: now};
    const context = {key, job, child: null, cancelled: false, done: false, committing: false, timer: null, terminateTimer: null, promise: null, request, requestFingerprint, aspectRatioFromImage};
    contexts.set(job.id, context);
    emit(context);
    context.promise = execute(context).catch(() => {});
    // Keep a bounded job history while never dropping a running child.
    const completed = [...contexts.values()].filter((item) => item.done && !item.child);
    for (const old of completed.slice(0, Math.max(0, contexts.size - 200))) contexts.delete(old.job.id);
    return structuredClone(job);
  }
  async function execute(context) {
    const {job, request} = context;
    let requestPath;
    try {
      if (context.cancelled) return;
      request.outputDir = await ensureDirectorOutput(request.sessionDir, job.id);
      request.outputPath = path.join(request.outputDir, job.operation === 'render' ? 'render.mp4' : 'final.mp4');
      requestPath = path.join(request.outputDir, '.request.json');
      await writeFile(requestPath, JSON.stringify(request), {mode: 0o600, flag: 'wx'});
      const command = await resolveCommand();
      if (context.cancelled || disposed) return;
      job.status = 'running'; job.message = job.operation === 'render' ? '正在生成镜头视频' : '正在合并视频'; emit(context);
      const result = await runDriver(context, command, requestPath);
      if (context.cancelled || disposed) return;
      if (!result || result.operation !== job.operation || typeof result.path !== 'string' || path.resolve(result.path) !== request.outputPath) throw directorError('视频驱动没有返回有效结果', 502, 'invalid_director_result');
      const relative = path.relative(request.sessionDir, result.path).split(path.sep).join('/');
      const actual = await safePath(request.sessionDir, relative, VIDEOS);
      if ((await stat(actual)).size === 0) throw directorError('视频驱动返回空文件', 502, 'invalid_director_result');
      if (context.cancelled || disposed) return;
      context.committing = true;
      if (job.operation === 'render') {
        await store.addVersion(job.sessionId, job.shotId, {id: `version-${randomUUID()}`, path: relative, createdAt: new Date().toISOString(), fingerprint: context.requestFingerprint, duration: validDuration(result.duration, request.shot.duration), ...(context.aspectRatioFromImage ? {aspectRatioFromImage: true} : {})});
      } else {
        await store.setExport(job.sessionId, {path: relative, createdAt: new Date().toISOString(), fingerprint: context.requestFingerprint, duration: validDuration(result.duration, request.clips.reduce((total, clip) => total + clip.duration, 0))});
      }
      job.status = 'completed'; job.progress = 1; job.message = job.operation === 'render' ? '镜头视频生成完成' : '视频导出完成'; job.result = {path: relative, url: artifactUrl(job.sessionId, relative)};
    } catch (error) {
      if (!context.cancelled && !disposed) {
        job.status = 'failed'; job.message = error?.code && typeof error?.statusCode === 'number' ? error.message : '任务失败，请检查视频服务配置和本地运行环境';
        job.error = {code: error?.code || 'director_job_failed', message: job.message, ...(error?.action ? {action: error.action} : {})};
      }
    } finally {
      clearTimeout(context.timer);
      if (context.cancelled || (disposed && !context.committing)) { job.status = 'cancelled'; job.message = '任务已取消'; }
      if (requestPath) await rm(requestPath, {force: true}).catch(() => {});
      if (job.status === 'cancelled' && request.outputDir) await rm(request.outputDir, {recursive: true, force: true}).catch(() => {});
      context.done = true;
      emit(context);
    }
  }
  function runDriver(context, command, requestPath) {
    return new Promise((resolve, reject) => {
      let pending = ''; let bytes = 0; let result; let reportedError; let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(context.timer); error ? reject(error) : resolve(value); };
      const child = spawnProcess(command.command, [...(command.args || []), path.join(repoRoot, 'main_director.py'), '--request', requestPath], {cwd: repoRoot, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
      context.child = child;
      context.abort = () => finish(directorError('任务已取消', 409, 'cancelled'));
      context.timer = setTimeout(() => { terminate(context); finish(directorError('视频任务超时，请重试', 504, 'director_job_timeout')); }, timeoutMs);
      context.timer.unref?.();
      const parseLine = (line) => {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'progress') {
          // Provider text is never returned: it may include private request URLs.
          if (typeof event.progress === 'number' && Number.isFinite(event.progress)) context.job.progress = Math.max(0, Math.min(.99, event.progress > 1 ? event.progress / 100 : event.progress));
          emit(context);
        } else if (event.type === 'result') result = event;
        else if (event.type === 'error') {
          const code = KNOWN_CODES.has(event.code) ? event.code : 'director_job_failed';
          // Only WanVideoError emits these codes; its text is authored locally,
          // never copied from provider payloads or network exceptions.
          const wanMessage = ['wan_video_config', 'wan_video_failed'].includes(code) && typeof event.message === 'string' && event.message.length <= 500 ? event.message : '';
          const message = wanMessage || (code === 'missing_video_api_key' ? '请在设置中填写视频生成 API 密钥' : code === 'unsupported_video_settings' ? '当前视频服务不支持所选时长、分辨率、画幅或帧素材，请调整设置' : code === 'unsupported_video_provider' ? '当前视频服务暂不支持导演台，请更换已支持的服务' : code === 'invalid_config' ? '视频配置格式有误，请检查设置' : '视频任务失败，请检查服务配置、网络和本地运行环境');
          reportedError = directorError(message, 502, code, event.action === 'open_settings' ? 'open_settings' : undefined);
        }
      };
      child.stdout?.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk); pending += chunk.toString();
        if (bytes > 2 * 1024 * 1024 || pending.length > 65_536) { terminate(context); finish(directorError('视频驱动响应过大', 502, 'invalid_director_result')); return; }
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) { parseLine(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      });
      child.stderr?.on('data', (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 2 * 1024 * 1024) { terminate(context); finish(directorError('视频驱动诊断过大', 502, 'invalid_director_result')); } });
      child.once('error', () => finish(directorError('无法启动本地视频驱动，请检查项目安装', 503, 'python_unavailable')));
      child.once('close', (code) => {
        clearTimeout(context.terminateTimer); context.terminateTimer = null;
        if (pending.trim()) parseLine(pending);
        context.child = null;
        if (context.cancelled) finish(directorError('任务已取消', 409, 'cancelled'));
        else if (reportedError || code !== 0) finish(reportedError || directorError('视频驱动退出，任务未完成', 502, 'director_job_failed'));
        else finish(null, result);
      });
    });
  }
  function terminate(context, immediately = false) {
    const child = context.child;
    if (!child) return;
    const send = (signal) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { try { child.kill(signal); } catch {} }
    };
    if (immediately) { clearTimeout(context.terminateTimer); context.terminateTimer = null; send('SIGKILL'); context.abort?.(); return; }
    send('SIGTERM');
    if (!context.terminateTimer) { context.terminateTimer = setTimeout(() => { send('SIGKILL'); context.abort?.(); }, 350); context.terminateTimer.unref?.(); }
  }
  async function cancel(sessionId, jobId) {
    await store.session(sessionId);
    const context = contexts.get(jobId);
    if (!context || context.job.sessionId !== sessionId) throw directorError('任务不存在', 404, 'director_job_not_found');
    if (ACTIVE.has(context.job.status) && !context.committing) { context.cancelled = true; context.job.status = 'cancelled'; context.job.message = '正在取消任务'; terminate(context); emit(context); }
    return structuredClone(context.job);
  }
  async function cancelSession(sessionId) {
    // Session IDs are never reused: retain this fence even if no job registered yet.
    closedSessions.add(sessionId);
    const targets = [...contexts.values()].filter((context) => context.job.sessionId === sessionId && (!context.done || context.child));
    for (const context of targets) { if (context.done) terminate(context, true); else if (!context.committing) { context.cancelled = true; context.job.status = 'cancelled'; terminate(context); } }
    await Promise.all(targets.map((context) => context.promise));
  }
  async function dispose() {
    disposed = true;
    for (const child of metadataChildren) { try { child.kill('SIGKILL'); } catch {} }
    const targets = [...contexts.values()].filter((context) => !context.done || context.child);
    for (const context of targets) { if (context.done) terminate(context, true); else if (!context.committing) { context.cancelled = true; context.job.status = 'cancelled'; terminate(context); } }
    await Promise.all(targets.map((context) => context.promise));
  }
  return {list, capabilities, start, cancel, cancelSession, dispose};
}

async function videoConfiguration(repoRoot, env) {
  let payload; let source = '';
  try { source = await readFile(path.join(repoRoot, 'configs', 'agent.local.yaml'), 'utf8'); payload = parse(source); }
  catch (error) { if (error?.code === 'ENOENT') payload = {}; else throw directorError('视频配置格式有误，请检查设置', 422, 'invalid_config', 'open_settings'); }
  if (payload === null) payload = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload.video && (typeof payload.video !== 'object' || Array.isArray(payload.video)))) throw directorError('视频配置格式有误，请检查设置', 422, 'invalid_config', 'open_settings');
  const clean = (value) => typeof value === 'string' && !/^<YOUR_[A-Z0-9_]+>$/.test(value.trim()) ? value.trim() : '';
  const explicitProvider = (clean(env.VIMAX_VIDEO_PROVIDER) || clean(payload.video?.api_provider)).toLowerCase();
  const baseUrl = clean(env.VIMAX_VIDEO_BASE_URL) || clean(payload.video?.base_url);
  let host = ''; try { host = new URL(baseUrl).hostname.toLowerCase(); } catch {}
  const aliyun = explicitProvider ? explicitProvider === 'aliyun' : ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host)
    || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host);
  // Match the Python driver; a text-service key must never be sent to Wan.
  const key = aliyun ? clean(env.VIMAX_VIDEO_API_KEY) || clean(env.DASHSCOPE_API_KEY) || clean(payload.video?.api_key)
    : clean(env.VIMAX_VIDEO_API_KEY) || clean(env.VIMAX_LLM_API_KEY) || clean(env.VIMAX_API_KEY) || clean(payload.video?.api_key) || clean(payload.llm?.api_key);
  const model = clean(env.VIMAX_VIDEO_MODEL) || clean(payload.video?.model) || (aliyun ? 'wan2.6-i2v-flash' : '');
  const signature = createHash('sha256').update(JSON.stringify([source, env.VIMAX_VIDEO_API_KEY || '', env.DASHSCOPE_API_KEY || '', env.VIMAX_LLM_API_KEY || '', env.VIMAX_API_KEY || '', env.VIMAX_VIDEO_MODEL || '', env.VIMAX_VIDEO_BASE_URL || '', env.VIMAX_VIDEO_PROVIDER || ''])).digest('hex');
  return {hasApiKey: Boolean(key), model, signature};
}

function validateSettings(settings, shot, caps) {
  if (caps.supported === false) throw directorError(caps.message || '当前视频服务不支持导演台生成', 422, 'unsupported_video_provider', 'open_settings');
  if (caps.promptOnly === false && !shot.firstFrame) throw directorError('当前视频模型需要首帧图片，请先为镜头添加首帧', 422, 'unsupported_video_settings');
  if ((caps.durations?.length && !caps.durations.includes(shot.duration)) || (caps.minDuration && shot.duration < caps.minDuration) || (caps.maxDuration && shot.duration > caps.maxDuration)
      || (!caps.aspectRatioFromImage && caps.aspectRatios?.length && !caps.aspectRatios.includes(settings.aspectRatio)) || (caps.resolutions?.length && !caps.resolutions.includes(settings.resolution))
      || (shot.firstFrame && caps.supportsFirstFrame === false) || (shot.lastFrame && caps.supportsLastFrame === false)) throw directorError('当前视频服务不支持所选时长、分辨率、画幅或帧素材，请调整设置', 422, 'unsupported_video_settings');
  if ((settings.resolution === '1080p' && caps.constraints?.['1080pDuration'] && shot.duration !== caps.constraints['1080pDuration'])
      || (shot.lastFrame && caps.constraints?.firstLastFrameDuration && shot.duration !== caps.constraints.firstLastFrameDuration)) throw directorError('当前视频模型的 1080p 或首尾帧模式需要指定时长，请调整镜头设置', 422, 'unsupported_video_settings');
}
function validDuration(value, fallback) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback; }
function readCapabilities(command, repoRoot, spawnProcess, env, metadataChildren) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command.command, [...(command.args || []), path.join(repoRoot, 'main_director.py'), '--capabilities', '--config', path.join(repoRoot, 'configs', 'agent.local.yaml')], {cwd: repoRoot, env, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    metadataChildren.add(child);
    let output = ''; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('capabilities timeout')); }, 5_000); timer.unref?.();
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); if (output.length > 65_536) { child.kill('SIGKILL'); finish(new Error('capabilities response too large')); } });
    child.stderr?.on('data', () => {});
    child.once('error', () => finish(new Error('capabilities unavailable')));
    child.once('close', (code) => { metadataChildren.delete(child); try { if (code !== 0) throw new Error(); finish(null, JSON.parse(output)); } catch { finish(new Error('invalid capabilities')); } });
  });
}
