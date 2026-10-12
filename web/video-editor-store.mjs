import {createHash, randomUUID} from 'node:crypto';
import {createReadStream, realpathSync} from 'node:fs';
import {lstat, mkdir, readFile, realpath, rename, stat, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {artifactUrl, createDirectorStore, directorError, safePath} from './director-store.mjs';

export const VIDEO_EDITOR_TYPES = new Set(['.mp4', '.mov', '.webm']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
export const editorError = (message, status = 422, code = 'invalid_video_editor_request') => directorError(message, status, code);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanText = (value, max, label) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw editorError(`${label}无效或超过 ${max} 字`); return value.trim(); };

export function validateEditorSegments(value, sources, {allowEmpty = false} = {}) {
  if (!Array.isArray(value) || value.length > 100 || (!allowEmpty && !value.length)) throw editorError('请确认 1 到 100 个剪辑片段', 422, 'invalid_segments');
  let total = 0;
  const result = value.map((item) => {
    if (!record(item) || Object.keys(item).some((key) => !['sourceId', 'start', 'end'].includes(key))) throw editorError('剪辑片段格式无效', 422, 'invalid_segments');
    const source = sources.find((source) => source.id === item.sourceId);
    if (!source || typeof item.start !== 'number' || typeof item.end !== 'number' || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end > source.duration || item.end - item.start < .04) throw editorError('剪辑片段超出素材时长，或不足 0.04 秒', 422, 'invalid_segments');
    total += item.end - item.start;
    return {sourceId: item.sourceId, start: item.start, end: item.end};
  });
  if (total > 1800) throw editorError('成片最多 30 分钟，请缩短剪辑片段', 422, 'invalid_segments');
  return result;
}

export function editorInputFingerprint(project) {
  return digest({agentId: project.agentId, instruction: project.instruction, sources: project.sources.map((source) => ({id: source.id, name: source.name, description: source.description, path: source.path, duration: source.duration, fingerprint: source.currentFingerprint || source.fingerprint}))});
}
export function editorOutputFingerprint(project) { return digest({input: editorInputFingerprint(project), settings: project.settings, segments: project.segments}); }

export async function editorFileFingerprint(directory, relative, allowMissing = false) {
  try {
    const absolute = await safePath(directory, relative, VIDEO_EDITOR_TYPES);
    const before = await stat(absolute);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    const after = await stat(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw editorError('读取期间素材已改变，请重新导入', 409, 'source_changed');
    return digest({path: relative, size: after.size, mtimeMs: after.mtimeMs, hash: hash.digest('hex')});
  } catch (error) { if (!allowMissing) throw error; return `missing:${relative}`; }
}

export async function ensureEditorOutput(directory, id) {
  if (!ID.test(id)) throw editorError('剪辑任务编号无效');
  let current = directory;
  for (const name of ['video-editor', id]) {
    current = path.join(current, name);
    await mkdir(current, {mode: 0o700}).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw editorError('剪辑输出目录不安全', 422, 'unsafe_artifact_path');
  }
  return current;
}

export function createVideoEditorStore({repoRoot, probeVideo} = {}) {
  repoRoot = realpathSync(path.resolve(repoRoot));
  const sessions = createDirectorStore({repoRoot});
  const locks = new Map();
  async function locked(id, operation) {
    const previous = locks.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation); locks.set(id, task);
    try { return await task; } finally { if (locks.get(id) === task) locks.delete(id); }
  }
  async function raw(id) {
    const context = await sessions.session(id);
    let project;
    try { project = JSON.parse(await readFile(await safePath(context.directory, 'video-editor.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw editorError('视频编辑项目文件损坏，请检查本地文件', 422, 'invalid_editor_project'); }
    project ||= {schemaVersion: 1, sessionId: id, revision: 0, agentId: '', instruction: '', sources: [], segments: [], settings: {aspectRatio: '16:9', resolution: '720p'}};
    if (!record(project) || project.schemaVersion !== 1 || project.sessionId !== id || !Number.isSafeInteger(project.revision) || project.revision < 0 || !Array.isArray(project.sources) || project.sources.length > 20 || !Array.isArray(project.segments)) throw editorError('视频编辑项目格式不受支持', 422, 'invalid_editor_project');
    return {context, project};
  }
  async function write(context, project) {
    const checked = await sessions.session(project.sessionId);
    if (checked.directory !== context.directory) throw editorError('项目工作区已改变', 409, 'source_changed');
    try { await safePath(context.directory, 'video-editor.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(context.directory, `.video-editor-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(project, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); await rename(temporary, path.join(context.directory, 'video-editor.json')); }
    finally { await rm(temporary, {force: true}).catch(() => {}); }
  }
  async function decorate(context, project) {
    const result = structuredClone(project);
    for (const source of result.sources) {
      source.url = artifactUrl(result.sessionId, source.path);
      source.currentFingerprint = await editorFileFingerprint(context.directory, source.path, true);
      try { await safePath(context.directory, source.path, VIDEO_EDITOR_TYPES); source.missing = false; } catch { source.missing = true; }
      source.stale = source.currentFingerprint !== source.fingerprint;
    }
    result.planStale = Boolean(result.segments.length && result.planFingerprint !== editorInputFingerprint(result));
    if (result.output) {
      result.output.url = artifactUrl(result.sessionId, result.output.path);
      result.output.stale = result.output.fingerprint !== editorOutputFingerprint(result);
      try { await safePath(context.directory, result.output.path, VIDEO_EDITOR_TYPES); result.output.missing = false; } catch { result.output.missing = true; }
    }
    return result;
  }
  async function load(id) { const {context, project} = await raw(id); return decorate(context, project); }
  async function assertSources(context, project) {
    for (const source of project.sources) if (await editorFileFingerprint(context.directory, source.path, true) !== source.fingerprint) throw editorError('视频素材已丢失或改变，请移除后重新导入', 409, 'source_changed');
  }
  function revision(input, project) { if (!input || input.revision !== project.revision) throw editorError('编辑项目已更新，请重新载入后重试', 409, 'revision_conflict'); }
  async function save(id, input) {
    return locked(id, async () => {
      const {context, project: current} = await raw(id); revision(input, current);
      if (!record(input.settings) || !['16:9', '9:16', '1:1'].includes(input.settings.aspectRatio) || !['720p', '1080p'].includes(input.settings.resolution)) throw editorError('画幅或分辨率不受支持');
      if (!Array.isArray(input.sources) || input.sources.length > 20) throw editorError('最多使用 20 个视频素材');
      const ids = new Set();
      const sources = input.sources.map((row) => {
        const stored = current.sources.find((source) => source.id === row?.id);
        if (!stored || ids.has(row.id)) throw editorError('素材编号无效或重复'); ids.add(row.id);
        return {...stored, name: cleanText(row.name, 128, '素材名称'), description: cleanText(row.description || '', 4000, '素材描述')};
      });
      const agentId = cleanText(input.agentId || '', 160, 'Agent');
      if (agentId && !/^cli:[A-Za-z0-9_-]+$/.test(agentId)) throw editorError('请选择检测到的本地 Agent', 422, 'invalid_editor_agent');
      const next = {...current, agentId, instruction: cleanText(input.instruction || '', 4000, '剪辑要求'), sources, settings: {aspectRatio: input.settings.aspectRatio, resolution: input.settings.resolution}};
      const contentChanged = editorInputFingerprint(next) !== editorInputFingerprint(current);
      next.segments = contentChanged ? [] : validateEditorSegments(input.segments, sources, {allowEmpty: true});
      next.planFingerprint = contentChanged ? '' : editorInputFingerprint(next);
      next.revision += 1; await write(context, next); return decorate(context, next);
    });
  }
  async function importSources(id, input, probe = probeVideo) {
    return locked(id, async () => {
      const {context, project} = await raw(id); revision(input, project);
      if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length + project.sources.length > 20) throw editorError('请选择视频素材，合计最多 20 个');
      const pending = []; const paths = new Set(project.sources.map((source) => source.path));
      for (const relative of input.paths) {
        const absolute = await safePath(context.directory, relative, VIDEO_EDITOR_TYPES);
        const normalized = path.relative(context.directory, absolute).split(path.sep).join('/');
        if (paths.has(normalized)) throw editorError('此视频已经导入，请选择其他素材'); paths.add(normalized);
        const before = await editorFileFingerprint(context.directory, normalized);
        const result = await probe({repoRoot, sessionDir: context.directory, path: absolute});
        if (!record(result) || typeof result.duration !== 'number' || !Number.isFinite(result.duration) || result.duration <= 0 || result.duration > 3600 || !Number.isSafeInteger(result.width) || result.width <= 0 || !Number.isSafeInteger(result.height) || result.height <= 0 || typeof result.hasAudio !== 'boolean') throw editorError('无法读取有效视频信息', 422, 'invalid_video');
        if (before !== await editorFileFingerprint(context.directory, normalized)) throw editorError('导入期间视频已改变，请重新导入', 409, 'source_changed');
        pending.push({id: `source-${randomUUID()}`, name: path.basename(normalized).slice(0, 128), path: normalized, duration: result.duration, width: result.width, height: result.height, hasAudio: result.hasAudio, description: '', fingerprint: before});
      }
      for (const source of pending) if (source.fingerprint !== await editorFileFingerprint(context.directory, source.path)) throw editorError('导入期间视频已改变，请重试', 409, 'source_changed');
      project.sources.push(...pending); project.segments = []; project.planFingerprint = ''; project.revision += 1;
      await write(context, project); return decorate(context, project);
    });
  }
  async function commit(id, expected, operation) {
    return locked(id, async () => {
      const {context, project} = await raw(id); revision(expected, project); await assertSources(context, project);
      if (expected.inputFingerprint !== editorInputFingerprint(await decorate(context, project))) throw editorError('任务期间素材或剪辑要求已改变，请重新载入', 409, 'source_changed');
      await operation(context, project); project.revision += 1; await write(context, project); return decorate(context, project);
    });
  }
  const commitPlan = (id, expected, segments) => commit(id, expected, async (_context, project) => { project.segments = validateEditorSegments(segments, project.sources); project.planFingerprint = editorInputFingerprint(project); });
  const commitOutput = (id, expected, output) => commit(id, expected, async (context, project) => { await safePath(context.directory, output.path, VIDEO_EDITOR_TYPES); project.output = {...output, fingerprint: editorOutputFingerprint(project)}; });
  return {session: sessions.session, load, save, importSources, assertSources, commitPlan, commitOutput};
}
