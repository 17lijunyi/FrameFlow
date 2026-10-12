import {createHash, randomUUID} from 'node:crypto';
import {createReadStream, realpathSync} from 'node:fs';
import {lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {readSessionState} from './server-lib.mjs';

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEOS = new Set(['.mp4', '.webm', '.mov']);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,95}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const CREATE_SESSION = `import json,sys
from agent_runtime.session_index import SessionIndex
record=SessionIndex(sys.argv[1]).create(project_name=sys.argv[2])
print(json.dumps({'sessionId':record['session_id']}))
`;

export function directorError(message, statusCode = 400, code = 'invalid_director_request', action) {
  return Object.assign(new Error(message), {statusCode, code, ...(action ? {action} : {})});
}

export function createDirectorStore({repoRoot, createSessionCommand} = {}) {
  repoRoot = realpathSync(path.resolve(repoRoot));
  const locks = new Map();
  async function locked(sessionId, operation) {
    const previous = locks.get(sessionId) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    locks.set(sessionId, result);
    try { return await result; } finally { if (locks.get(sessionId) === result) locks.delete(sessionId); }
  }
  async function session(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw directorError('项目编号无效');
    const state = await readSessionState(repoRoot);
    const record = state.sessions.find((item) => item.sessionId === sessionId);
    if (!record) throw directorError('项目不存在', 404, 'session_not_found');
    const directory = path.join(repoRoot, '.working_dir', sessionId);
    await assertRoot(repoRoot, directory);
    return {record, directory};
  }
  async function raw(sessionId) {
    const context = await session(sessionId);
    let project;
    try { project = JSON.parse(await readFile(await safePath(context.directory, 'director.json'), 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw directorError('导演计划文件损坏或无法读取', 422, 'invalid_director_plan');
      project = {schemaVersion: 1, sessionId, revision: 0, planRevision: 0, title: context.record.projectName || '未命名项目', settings: {style: '', aspectRatio: '16:9', resolution: '720p'}, shots: []};
    }
    // Existing schemaVersion 1 plans predate this separate editing revision.
    if (project.planRevision === undefined) project.planRevision = 0;
    if (project.schemaVersion !== 1 || project.sessionId !== sessionId || !Array.isArray(project.shots) || !Number.isSafeInteger(project.revision) || project.revision < 0 || !Number.isSafeInteger(project.planRevision) || project.planRevision < 0) {
      throw directorError('导演计划格式不受支持', 422, 'invalid_director_plan');
    }
    return {context, project};
  }
  async function write(context, project) {
    const destination = path.join(context.directory, 'director.json');
    // Validate the parent and existing target again immediately before writing.
    await assertRoot(repoRoot, context.directory);
    try { await safePath(context.directory, 'director.json'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const temporary = path.join(context.directory, `.director-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await rename(temporary, destination);
  }
  async function decorate(context, project) {
    const result = structuredClone(project);
    for (const shot of result.shots) {
      shot.currentFingerprint = await fingerprint(context.directory, result.settings, shot, true);
      const sourceRatioFingerprint = shot.versions?.some((version) => version.aspectRatioFromImage === true)
        ? await fingerprint(context.directory, result.settings, shot, true, {aspectRatioFromImage: true}) : undefined;
      for (const version of shot.versions || []) {
        // Render rules belong to the saved version, not today's selected provider.
        version.currentFingerprint = version.aspectRatioFromImage === true ? sourceRatioFingerprint : shot.currentFingerprint;
        version.stale = version.fingerprint !== version.currentFingerprint;
        version.url = artifactUrl(result.sessionId, version.path);
        try { await safePath(context.directory, version.path, VIDEOS); version.missing = false; }
        catch { version.missing = true; }
      }
    }
    if (result.export) {
      result.export.url = artifactUrl(result.sessionId, result.export.path);
      result.export.stale = result.export.fingerprint !== exportFingerprint(result);
      try { await safePath(context.directory, result.export.path, VIDEOS); result.export.missing = false; }
      catch { result.export.missing = true; }
    }
    return result;
  }
  async function load(sessionId) {
    const {context, project} = await raw(sessionId);
    return decorate(context, project);
  }
  async function save(sessionId, input) {
    return locked(sessionId, async () => {
      const {context, project: current} = await raw(sessionId);
      if (!input || typeof input !== 'object' || input.revision !== current.revision) {
        throw directorError('计划已被更新，请重新载入后再保存', 409, 'revision_conflict');
      }
      const project = await normalizeProject(context.directory, input, current);
      project.revision = current.revision + 1;
      project.planRevision = current.planRevision + 1;
      await write(context, project);
      return decorate(context, project);
    });
  }
  async function addVersion(sessionId, shotId, version) {
    return locked(sessionId, async () => {
      const {context, project} = await raw(sessionId);
      const shot = project.shots.find((item) => item.id === shotId);
      if (!shot) throw directorError('生成期间镜头已删除，视频仍保存在项目素材中', 409, 'shot_removed');
      await safePath(context.directory, version.path, VIDEOS);
      shot.versions.push(version);
      // A result for an earlier edit remains a history version, never selects itself.
      if (version.fingerprint === await fingerprint(context.directory, project.settings, shot, true, version)) shot.selectedVersionId = version.id;
      project.revision += 1;
      await write(context, project);
      return decorate(context, project);
    });
  }
  async function setExport(sessionId, result) {
    return locked(sessionId, async () => {
      const {context, project} = await raw(sessionId);
      await safePath(context.directory, result.path, VIDEOS);
      project.export = result;
      project.revision += 1;
      await write(context, project);
      return decorate(context, project);
    });
  }
  async function importPlan(sessionId, input = {}) {
    return locked(sessionId, async () => {
      const {context, project} = await raw(sessionId);
      if (input.revision !== undefined && input.revision !== project.revision) throw directorError('计划已更新，请重新载入再导入', 409, 'revision_conflict');
      if (project.shots.length && input.replace !== true) throw directorError('导演台已有镜头，请先删除现有镜头后再导入分镜', 409, 'director_not_empty');
      const files = await discoverPlans(context.directory);
      const descriptors = new Map();
      const storyboards = [];
      for (const source of files.sort(naturalSort)) {
        let data;
        try { data = JSON.parse(await readFile(await safePath(context.directory, source), 'utf8')); } catch { continue; }
        if (path.basename(source) === 'storyboard.json') { storyboards.push({source, rows: Array.isArray(data) ? data : []}); continue; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const group = posix(path.dirname(path.dirname(path.dirname(source))));
        const index = data.idx ?? path.basename(path.dirname(source));
        descriptors.set(`${group}:${index}`, {source, row: data, group, index});
      }
      const rows = [];
      const consumed = new Set();
      for (const {source, rows: storyboardRows} of storyboards) {
        const group = posix(path.dirname(source));
        for (let position = 0; position < storyboardRows.length; position += 1) {
          const brief = storyboardRows[position];
          if (!brief || typeof brief !== 'object') continue;
          const index = brief.idx ?? position;
          const key = `${group}:${index}`;
          const description = descriptors.get(key);
          consumed.add(key);
          rows.push({row: {...brief, ...(description?.row || {})}, shotDir: description ? path.dirname(description.source) : path.join(group, 'shots', String(index))});
        }
      }
      for (const [key, description] of descriptors) {
        if (!consumed.has(key)) rows.push({row: description.row, shotDir: path.dirname(description.source)});
      }
      const shots = [];
      for (const {row, shotDir} of rows) {
        const prompt = [row.visual_desc || row.description || row.prompt || '', row.motion_desc || '', row.audio_desc || ''].filter(Boolean).join('\n').trim();
        if (!prompt) continue;
        const shot = {id: `shot-${randomUUID().slice(0, 12)}`, title: `镜头 ${shots.length + 1}`, prompt: prompt.slice(0, 20_000), duration: positiveDuration(row.duration || 8), firstFrame: '', lastFrame: '', versions: [], selectedVersionId: ''};
        for (const [field, filename] of [['firstFrame', 'first_frame.png'], ['lastFrame', 'last_frame.png']]) {
          const candidate = posix(path.join(shotDir, filename));
          try { await safePath(context.directory, candidate, IMAGES); shot[field] = candidate; } catch { /* Optional existing frame. */ }
        }
        if (shot.lastFrame && !shot.firstFrame) shot.lastFrame = '';
        const videoPath = posix(path.join(shotDir, 'video.mp4'));
        try {
          await safePath(context.directory, videoPath, VIDEOS);
          const version = {id: `version-${randomUUID().slice(0, 12)}`, path: videoPath, createdAt: new Date().toISOString(), fingerprint: await fingerprint(context.directory, project.settings, shot), duration: shot.duration};
          shot.versions.push(version); shot.selectedVersionId = version.id;
        } catch { /* A text plan need not have a rendered video. */ }
        shots.push(shot);
        if (shots.length > 500) throw directorError('分镜超过 500 个，请拆分项目');
      }
      if (!shots.length) throw directorError('项目中没有可导入的分镜或镜头描述', 404, 'storyboard_not_found');
      project.shots = shots; project.revision += 1; project.planRevision += 1;
      await write(context, project);
      return decorate(context, project);
    });
  }
  async function create(projectName) {
    const title = text(projectName, 64, '项目名称');
    if (!title) throw directorError('请填写项目名称');
    for (const name of ['.vimax', '.working_dir']) {
      const directory = path.join(repoRoot, name);
      await mkdir(directory, {recursive: true, mode: 0o700});
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw directorError('项目根目录不安全', 422, 'unsafe_project_path');
    }
    const command = createSessionCommand || defaultPython(repoRoot);
    const output = await shortCommand(command, ['-c', CREATE_SESSION, repoRoot, title], repoRoot);
    let sessionId;
    try { sessionId = JSON.parse(output).sessionId; } catch { throw directorError('无法建立项目索引', 500, 'create_session_failed'); }
    return {sessionId, ...(await readSessionState(repoRoot)), project: await load(sessionId)};
  }
  return {session, load, save, importPlan, create, addVersion, setExport, fingerprint, exportFingerprint};
}

export function defaultPython(repoRoot) {
  return {command: path.join(repoRoot, '.venv', 'bin', 'python3'), args: []};
}

async function normalizeProject(directory, input, current) {
  if (!Array.isArray(input.shots) || input.shots.length > 500) throw directorError('镜头列表无效或超过 500 个');
  const settings = input.settings;
  if (!settings || typeof settings !== 'object') throw directorError('缺少导演设置');
  const normalizedSettings = {style: text(settings.style || '', 4_000, '全局风格'), aspectRatio: text(settings.aspectRatio || '16:9', 20, '画幅比例'), resolution: text(settings.resolution || '720p', 20, '分辨率')};
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(normalizedSettings.aspectRatio)) throw directorError('画幅比例不受支持');
  if (!['480p', '540p', '720p', '1080p'].includes(normalizedSettings.resolution)) throw directorError('分辨率不受支持');
  const ids = new Set();
  const shots = [];
  for (const item of input.shots) {
    if (!item || !ITEM_ID.test(item.id) || ids.has(item.id)) throw directorError('镜头编号无效或重复');
    ids.add(item.id);
    const stored = current.shots.find((shot) => shot.id === item.id);
    const selected = text(item.selectedVersionId || '', 96, '视频版本');
    if (selected && !stored?.versions?.some((version) => version.id === selected)) throw directorError('只能选择此镜头已有的视频版本');
    const shot = {id: item.id, title: text(item.title || '未命名镜头', 128, '镜头名称'), prompt: text(item.prompt || '', 20_000, '镜头提示词'), duration: positiveDuration(item.duration), firstFrame: '', lastFrame: '', versions: structuredClone(stored?.versions || []), selectedVersionId: selected};
    for (const field of ['firstFrame', 'lastFrame']) {
      if (item[field]) { await safePath(directory, item[field], IMAGES); shot[field] = posix(item[field]); }
    }
    if (shot.lastFrame && !shot.firstFrame) throw directorError('使用尾帧时需要同时绑定首帧');
    shots.push(shot);
  }
  return {...current, title: text(input.title || current.title, 128, '项目名称'), settings: normalizedSettings, shots};
}

export async function safePath(directory, relativePath, extensions) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || relativePath.includes('\\') || path.isAbsolute(relativePath)) throw directorError('素材必须使用项目内的相对路径', 422, 'unsafe_artifact_path');
  const target = path.resolve(directory, relativePath);
  if (!within(directory, target)) throw directorError('素材路径超出当前项目', 422, 'unsafe_artifact_path');
  if (extensions && !extensions.has(path.extname(target).toLowerCase())) throw directorError('素材格式不受支持', 422, 'invalid_artifact_type');
  let actual;
  try { actual = await realpath(target); }
  catch (error) { if (extensions && error?.code === 'ENOENT') throw directorError('素材文件不存在，请重新上传或选择', 422, 'missing_artifact'); throw error; }
  if (!within(directory, actual)) throw directorError('素材链接超出当前项目', 422, 'unsafe_artifact_path');
  if (!(await stat(actual)).isFile()) throw directorError('素材不是有效文件', 422, 'invalid_artifact_type');
  return actual;
}

async function assertRoot(repoRoot, directory) {
  const expected = path.resolve(directory);
  const root = path.join(repoRoot, '.working_dir');
  const rootInfo = await lstat(root);
  const info = await lstat(expected);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || info.isSymbolicLink() || !info.isDirectory() || await realpath(expected) !== expected) throw directorError('项目工作区路径不安全', 422, 'unsafe_project_path');
}

export async function ensureDirectorOutput(directory, jobId) {
  let current = directory;
  for (const name of ['artifacts', 'director', jobId]) {
    current = path.join(current, name);
    await mkdir(current, {recursive: false, mode: 0o700}).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw directorError('导演输出目录不安全', 422, 'unsafe_artifact_path');
  }
  return current;
}

export async function fingerprint(directory, settings, shot, allowMissing = false, {aspectRatioFromImage = false} = {}) {
  const frames = {};
  for (const field of ['firstFrame', 'lastFrame']) {
    if (!shot[field]) { frames[field] = ''; continue; }
    try {
      const file = await safePath(directory, shot[field], IMAGES);
      if ((await stat(file)).size > 50 * 1024 * 1024) throw directorError('参考图片超过 50 MB');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      frames[field] = hash.digest('hex');
    } catch (error) { if (!allowMissing) throw error; frames[field] = `missing:${shot[field]}`; }
  }
  let renderSettings = settings;
  if (aspectRatioFromImage === true) {
    // The project ratio still affects exports, but never alters these source-sized renders.
    const {aspectRatio: _exportRatio, ...inputs} = settings;
    renderSettings = inputs;
  }
  return createHash('sha256').update(JSON.stringify({settings: renderSettings, prompt: shot.prompt, duration: shot.duration, frames})).digest('hex');
}

export function exportFingerprint(project) {
  return createHash('sha256').update(JSON.stringify(project.shots.map((shot) => ({id: shot.id, selectedVersionId: shot.selectedVersionId, fingerprint: shot.currentFingerprint || shot.versions?.find((version) => version.id === shot.selectedVersionId)?.fingerprint || ''})))).digest('hex');
}

export function artifactUrl(sessionId, relativePath) { return `/api/artifact?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(relativePath)}`; }
function within(parent, child) { return child.startsWith(`${path.resolve(parent)}${path.sep}`); }
function posix(value) { return value.split(path.sep).join('/'); }
function text(value, maxLength, label) { if (typeof value !== 'string' || value.length > maxLength) throw directorError(`${label}必须是长度不超过 ${maxLength} 的文本`); return value.trim(); }
function positiveDuration(value) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 120) throw directorError('镜头时长必须为 1 到 120 秒'); return value; }
function naturalSort(left, right) { return left.localeCompare(right, 'en', {numeric: true}); }
async function discoverPlans(directory) {
  const files = []; let visited = 0;
  async function walk(current, depth) {
    if (depth > 8) return;
    for (const entry of (await readdir(current, {withFileTypes: true})).sort((a,b) => naturalSort(a.name,b.name))) {
      if (++visited > 10_000) throw directorError('项目文件过多，请拆分项目');
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name !== 'artifacts' && entry.name !== 'uploads') await walk(target, depth + 1);
      else if (entry.isFile() && ['storyboard.json', 'shot_description.json'].includes(entry.name) && (await stat(target)).size < 8 * 1024 * 1024) files.push(posix(path.relative(directory, target)));
    }
  }
  await walk(directory, 0); return files;
}

function shortCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...(command.args || []), ...args], {cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    let output = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(directorError('建立项目超时', 503, 'create_session_failed')); }, 10_000);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 65_536) { child.kill('SIGKILL'); finish(directorError('项目索引响应异常', 500, 'create_session_failed')); } });
    child.stderr.on('data', () => {});
    child.once('error', () => finish(directorError('无法启动本地 Python，请检查项目安装', 503, 'python_unavailable')));
    child.once('close', (code) => finish(code === 0 ? null : directorError('无法建立项目索引，请检查工作区文件', 500, 'create_session_failed'), output));
  });
}
