import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDirectorStore} from './director-store.mjs';
import {createDirectorJobs} from './director-jobs.mjs';
import {createDirectorRouter} from './director-routes.mjs';

const fixtures = [];
const managers = [];
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const fixture of fixtures.splice(0)) await rm(fixture, {recursive: true, force: true});
});

async function fixture({key = true} = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'frameflow-director-test-'));
  fixtures.push(repoRoot);
  const directory = path.join(repoRoot, '.working_dir', 'project-1');
  await mkdir(path.join(repoRoot, '.vimax'), {recursive: true});
  await mkdir(directory, {recursive: true});
  await mkdir(path.join(repoRoot, 'configs'));
  await writeFile(path.join(repoRoot, 'configs', 'agent.local.yaml'), `video:\n  model: fake/video\n  api_key: ${key ? 'sk-private-test-key' : "''"}\n`);
  await writeFile(path.join(repoRoot, '.vimax', 'sessions.json'), JSON.stringify({active_session_id: 'project-1', sessions: {'project-1': {session_id: 'project-1', project_name: '测试项目', working_dir: '.working_dir/project-1', stage: 'created', custom_field: 'preserve'}}}));
  const store = createDirectorStore({repoRoot});
  return {repoRoot, directory, store};
}
async function addShot(store, fields = {}) {
  const project = await store.load('project-1');
  project.shots.push({id: 'shot-1', title: '镜头一', prompt: '清晨街道', duration: 8, firstFrame: '', lastFrame: '', versions: [], selectedVersionId: '', ...fields});
  return store.save('project-1', project);
}
async function addVersion(f, fingerprint) {
  const file = 'version.mp4';
  await writeFile(path.join(f.directory, file), 'fake-video');
  const project = await f.store.load('project-1');
  return f.store.addVersion('project-1', 'shot-1', {id: 'version-1', path: file, createdAt: new Date().toISOString(), fingerprint: fingerprint || project.shots[0].currentFingerprint, duration: 8});
}
function fakeRunner() {
  const children = [];
  const spawnProcess = vi.fn((command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { setImmediate(() => child.emit('close', null)); return true; });
    child.emitJson = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
    child.complete = async () => {
      const request = JSON.parse(await readFile(args[args.indexOf('--request') + 1], 'utf8'));
      await writeFile(request.outputPath, 'fake-video');
      child.emitJson({type: 'result', operation: request.operation, path: request.outputPath, duration: 8});
      child.emit('close', 0);
    };
    children.push(child);
    return child;
  });
  return {children, spawnProcess};
}
function jobsFor(f, runner, extras = {}) {
  const events = [];
  const manager = createDirectorJobs({repoRoot: f.repoRoot, store: f.store, spawnProcess: runner.spawnProcess,
    resolveCommand: () => ({command: '/fake/python', args: []}),
    queryCapabilities: async () => ({supported: true, provider: 'mock', durations: [4, 6, 8], resolutions: ['720p'], aspectRatios: ['16:9'], firstFrame: true, firstLastFrame: true}),
    broadcast: (event) => events.push(event), ...extras});
  managers.push(manager);
  return {manager, events};
}

describe('director durable plan and project boundaries', () => {
  it('loads and saves a plan without any LLM configuration and rejects unknown projects', async () => {
    const f = await fixture({key: false});
    const project = await addShot(f.store);
    expect(project).toMatchObject({revision: 1, title: '测试项目', shots: [{prompt: '清晨街道'}]});
    expect(JSON.parse(await readFile(path.join(f.directory, 'director.json'), 'utf8')).revision).toBe(1);
    await expect(f.store.load('missing')).rejects.toMatchObject({statusCode: 404});
  });
  it('serializes simultaneous revisions so stale edits cannot overwrite a newer plan', async () => {
    const f = await fixture(); const initial = await addShot(f.store);
    const left = structuredClone(initial); left.shots[0].prompt = '左侧';
    const right = structuredClone(initial); right.shots[0].prompt = '右侧';
    const results = await Promise.allSettled([f.store.save('project-1', left), f.store.save('project-1', right)]);
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason).toMatchObject({statusCode: 409, code: 'revision_conflict'});
    expect((await f.store.load('project-1')).shots[0].prompt).toBe('左侧');
  });
  it('increments the durable plan revision only for edits and ignores client supplied revision values', async () => {
    const f = await fixture();
    expect(await f.store.load('project-1')).toMatchObject({revision: 0, planRevision: 0});
    let project = await addShot(f.store);
    expect(project).toMatchObject({revision: 1, planRevision: 1});
    project = await addVersion(f);
    expect(project).toMatchObject({revision: 2, planRevision: 1});
    project = await f.store.setExport('project-1', {path: 'version.mp4', fingerprint: f.store.exportFingerprint(project)});
    expect(project).toMatchObject({revision: 3, planRevision: 1});
    project.planRevision = 999;
    project.shots[0].prompt = '外部编辑';
    project = await f.store.save('project-1', project);
    expect(project).toMatchObject({revision: 4, planRevision: 2});
    const disk = JSON.parse(await readFile(path.join(f.directory, 'director.json'), 'utf8'));
    expect(disk.planRevision).toBe(2);
    delete disk.planRevision;
    await writeFile(path.join(f.directory, 'director.json'), JSON.stringify(disk));
    expect((await f.store.load('project-1')).planRevision).toBe(0);
  });
  it('rejects traversal, absolute frames and symlink escapes while preserving a valid project frame', async () => {
    const f = await fixture(); await writeFile(path.join(f.directory, 'frame.png'), 'image');
    const outside = path.join(f.repoRoot, 'outside.png'); await writeFile(outside, 'private');
    await symlink(outside, path.join(f.directory, 'escape.png'));
    for (const firstFrame of ['../../outside.png', outside, 'escape.png']) await expect(addShot(f.store, {firstFrame})).rejects.toMatchObject({statusCode: 422});
    expect((await addShot(f.store, {firstFrame: 'frame.png'})).shots[0].firstFrame).toBe('frame.png');
  });
  it('invalidates old versions when frame bytes or global settings change and keeps preview history', async () => {
    const f = await fixture(); await writeFile(path.join(f.directory, 'frame.png'), 'image-a');
    await addShot(f.store, {firstFrame: 'frame.png'}); await addVersion(f);
    expect((await f.store.load('project-1')).shots[0].versions[0].stale).toBe(false);
    await writeFile(path.join(f.directory, 'frame.png'), 'image-b');
    let project = await f.store.load('project-1');
    expect(project.shots[0].versions[0]).toMatchObject({stale: true, missing: false});
    expect(project.shots[0].versions[0].url).toContain('/api/artifact?');
    project.settings.style = '胶片'; project = await f.store.save('project-1', project);
    expect(project.shots[0].versions).toHaveLength(1);
  });
  it('never lets client supplied versions fabricate a result or select another shot result', async () => {
    const f = await fixture(); await addShot(f.store); await addVersion(f);
    const project = await f.store.load('project-1');
    project.shots[0].versions.push({id: 'fake', path: 'secret.txt'});
    const saved = await f.store.save('project-1', project);
    expect(saved.shots[0].versions.map((item) => item.id)).toEqual(['version-1']);
    saved.shots[0].selectedVersionId = 'fake';
    await expect(f.store.save('project-1', saved)).rejects.toMatchObject({statusCode: 400});
  });
  it('imports every storyboard row even when shot decomposition is only partially complete', async () => {
    const f = await fixture(); const root = path.join(f.directory, 'script2video');
    await mkdir(path.join(root, 'shots', '1'), {recursive: true});
    await writeFile(path.join(root, 'storyboard.json'), JSON.stringify([{idx: 0, visual_desc: '镜头零'}, {idx: 1, visual_desc: '镜头一'}, {idx: 2, visual_desc: '镜头二'}]));
    await writeFile(path.join(root, 'shots', '1', 'shot_description.json'), JSON.stringify({idx: 1, visual_desc: '详细镜头一', motion_desc: '缓慢推近', audio_desc: '雨声'}));
    await writeFile(path.join(root, 'shots', '1', 'first_frame.png'), 'image');
    const imported = await f.store.importPlan('project-1');
    expect(imported.shots.map((shot) => shot.prompt)).toEqual(['镜头零', '详细镜头一\n缓慢推近\n雨声', '镜头二']);
    expect(imported.shots.map((shot) => shot.duration)).toEqual([8, 8, 8]);
    expect(imported).toMatchObject({revision: 1, planRevision: 1});
    expect(imported.shots[1].firstFrame).toBe('script2video/shots/1/first_frame.png');
    await expect(f.store.importPlan('project-1')).rejects.toMatchObject({statusCode: 409});
    const replaced = await f.store.importPlan('project-1', {replace: true, revision: imported.revision});
    expect(replaced.shots).toHaveLength(3);
    expect(replaced).toMatchObject({revision: 2, planRevision: 2});
  });
  it('creates lightweight projects through the shared Python index lock and preserves existing records', async () => {
    const f = await fixture({key: false});
    await mkdir(path.join(f.repoRoot, 'agent_runtime'));
    for (const name of ['__init__.py', 'session_index.py']) await copyFile(path.join(sourceRoot, 'agent_runtime', name), path.join(f.repoRoot, 'agent_runtime', name));
    const store = createDirectorStore({repoRoot: f.repoRoot, createSessionCommand: {command: path.join(sourceRoot, '.venv', 'bin', 'python3')}});
    const created = await store.create('纯导演项目');
    const state = JSON.parse(await readFile(path.join(f.repoRoot, '.vimax', 'sessions.json'), 'utf8'));
    expect(state.sessions['project-1'].custom_field).toBe('preserve');
    expect(state.active_session_id).toBe(created.sessionId);
    expect(created.project).toMatchObject({revision: 0, title: '纯导演项目', shots: []});
    expect(state.sessions[created.sessionId].stage).toBe('created');
  });
});

describe('director isolated background jobs', () => {
  it('isolates Wan credentials and invalidates metadata when the DashScope key changes', async () => {
    const f = await fixture({key: false}); await addShot(f.store);
    await writeFile(path.join(f.repoRoot, 'configs', 'agent.local.yaml'), 'video:\n  api_provider: aliyun\nllm:\n  api_key: sk-text-only\n');
    const env = {VIMAX_LLM_API_KEY: 'sk-text-env', VIMAX_API_KEY: 'sk-shared'};
    const query = vi.fn(async () => ({supported: true, promptOnly: false, firstFrame: true, firstLastFrame: false, defaultDuration: 5, audio: false, aspectRatioFromImage: true}));
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner, {env, queryCapabilities: query});
    expect(await manager.capabilities()).toMatchObject({videoConfigured: false, model: 'wan2.6-i2v-flash', defaultDuration: 5, audio: false});
    await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({code: 'missing_video_api_key'});
    expect(runner.spawnProcess).not.toHaveBeenCalled();
    env.DASHSCOPE_API_KEY = 'sk-wan-private';
    const ready = await manager.capabilities();
    expect(ready).toMatchObject({videoConfigured: true, supportsFirstFrame: true, supportsLastFrame: false, aspectRatioFromImage: true});
    expect(query).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(ready)).not.toContain('sk-');
  });
  it('rejects Wan missing first frames and tail frames before submitting, preserving safe recovery errors', async () => {
    const f = await fixture(); await addShot(f.store, {duration: 5});
    await writeFile(path.join(f.repoRoot, 'configs', 'agent.local.yaml'), 'video:\n  base_url: https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1\n  api_key: sk-wan-private\n');
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner, {env: {}, queryCapabilities: async () => ({supported: true, promptOnly: false, firstFrame: true, firstLastFrame: false, durations: [5], resolutions: ['720p'], aspectRatios: ['9:16'], aspectRatioFromImage: true})});
    await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({code: 'unsupported_video_settings', message: expect.stringContaining('首帧')});
    await writeFile(path.join(f.directory, 'frame.png'), 'image');
    let project = await f.store.load('project-1'); project.shots[0].firstFrame = 'frame.png'; project.shots[0].lastFrame = 'frame.png';
    await f.store.save('project-1', project);
    await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({code: 'unsupported_video_settings'});
    expect(runner.spawnProcess).not.toHaveBeenCalled();
    project = await f.store.load('project-1'); project.shots[0].lastFrame = ''; await f.store.save('project-1', project);
    await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    const message = '视频已生成，但下载失败，请在百炼控制台下载结果，避免重复生成。';
    runner.children[0].emitJson({type: 'error', code: 'wan_video_failed', message});
    runner.children[0].emit('close', 1);
    await vi.waitFor(() => expect(manager.list('project-1')[0]).toMatchObject({status: 'failed', message, error: {code: 'wan_video_failed'}}));
  });
  it('preflights missing API keys and unsupported settings before spawning a paid task', async () => {
    const f = await fixture({key: false}); await addShot(f.store);
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({statusCode: 422, code: 'missing_video_api_key', action: 'open_settings'});
    expect(runner.spawnProcess).not.toHaveBeenCalled();
    expect(JSON.stringify(await manager.capabilities())).not.toContain('sk-private');
  });
  it('reuses metadata queries and respects environment key configuration without returning credentials', async () => {
    const f = await fixture({key: false}); const runner = fakeRunner();
    const query = vi.fn(async () => ({supported: true, firstFrame: true, firstLastFrame: true}));
    const {manager} = jobsFor(f, runner, {queryCapabilities: query, env: {VIMAX_VIDEO_API_KEY: 'sk-environment-private'}});
    const snapshots = await Promise.all([manager.capabilities(), manager.capabilities(), manager.capabilities()]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(snapshots[0]).toMatchObject({videoConfigured: true, supportsFirstFrame: true, supportsLastFrame: true});
    expect(JSON.stringify(snapshots)).not.toContain('sk-environment-private');
  });
  it('fences tasks still awaiting capability preflight when their session is deleted or the service stops', async () => {
    for (const closing of ['session', 'service']) {
      const f = await fixture(); await addShot(f.store); const runner = fakeRunner();
      let release;
      const query = vi.fn(() => new Promise((resolve) => { release = resolve; }));
      const {manager} = jobsFor(f, runner, {queryCapabilities: query});
      const pending = manager.start('project-1', 'render', 'shot-1');
      pending.catch(() => {});
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      if (closing === 'session') await manager.cancelSession('project-1');
      else await manager.dispose();
      release({supported: true, durations: [8]});
      await expect(pending).rejects.toMatchObject({code: closing === 'session' ? 'director_session_cancelled' : 'director_unavailable'});
      expect(runner.spawnProcess).not.toHaveBeenCalled();
      expect(manager.list('project-1')).toEqual([]);
      await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({code: closing === 'session' ? 'director_session_cancelled' : 'director_unavailable'});
    }
  });
  it('checks combined model restrictions before spawning and permits offline export with malformed model settings', async () => {
    const f = await fixture(); await addShot(f.store, {duration: 6});
    let project = await f.store.load('project-1'); project.settings.resolution = '1080p'; await f.store.save('project-1', project);
    const runner = fakeRunner();
    const {manager} = jobsFor(f, runner, {queryCapabilities: async () => ({supported: true, durations: [4, 6, 8], resolutions: ['720p', '1080p'], constraints: {'1080pDuration': 8}})});
    await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({code: 'unsupported_video_settings'});
    expect(runner.spawnProcess).not.toHaveBeenCalled();
    await addVersion(f);
    await writeFile(path.join(f.repoRoot, 'configs', 'agent.local.yaml'), 'video: [broken');
    expect(await manager.capabilities()).toMatchObject({supported: false, canExport: true});
    await manager.start('project-1', 'export');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    await runner.children[0].complete();
    await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('completed'));
    expect((await f.store.load('project-1')).export).toMatchObject({stale: false, missing: false});
  });
  it('uses fixed CLI arguments, private request files and validates a successful result', async () => {
    const f = await fixture(); await addShot(f.store);
    const runner = fakeRunner(); const {manager, events} = jobsFor(f, runner);
    const job = await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    const [command, args, options] = runner.spawnProcess.mock.calls[0];
    expect(command).toBe('/fake/python'); expect(options).toMatchObject({shell: false, cwd: f.repoRoot});
    const requestPath = args[args.indexOf('--request') + 1];
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    expect(request).toMatchObject({operation: 'render', sessionId: 'project-1', shot: {id: 'shot-1', prompt: '清晨街道'}});
    expect(JSON.stringify(request)).not.toContain('sk-private-test-key');
    runner.children[0].emitJson({type: 'progress', progress: .5, message: 'private-secret-provider-response'});
    await runner.children[0].complete();
    await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('completed'));
    expect((await f.store.load('project-1')).shots[0].versions).toHaveLength(1);
    expect(events.some((event) => event.type === 'director_changed')).toBe(true);
    expect(JSON.stringify(manager.list('project-1'))).not.toContain('private-secret');
    await expect(readFile(requestPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect(manager.list('project-1')[0].id).toBe(job.id);
  });
  it('retains a finished earlier input as stale history after a concurrent edit', async () => {
    const f = await fixture(); await addShot(f.store);
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    const edited = await f.store.load('project-1'); edited.shots[0].prompt = '夜晚街道'; await f.store.save('project-1', edited);
    await runner.children[0].complete();
    await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('completed'));
    const project = await f.store.load('project-1');
    expect(project.shots[0].versions[0].stale).toBe(true);
    expect(project.shots[0].selectedVersionId).toBe('');
  });
  it('rejects duplicate jobs and cancellation terminates only its own child', async () => {
    const f = await fixture(); await addShot(f.store);
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    const job = await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    await expect(manager.start('project-1', 'render', 'shot-1')).rejects.toMatchObject({statusCode: 409, code: 'director_job_busy'});
    await manager.cancel('project-1', job.id);
    await manager.cancelSession('project-1');
    await vi.waitFor(() => expect(runner.children[0].kill).toHaveBeenCalledWith('SIGTERM'));
    expect(manager.list('project-1')[0].status).toBe('cancelled');
  });
  it('terminates a hung driver on timeout and completes disposal even if the fake process never closes', async () => {
    const f = await fixture(); await addShot(f.store); const runner = fakeRunner();
    const {manager} = jobsFor(f, runner, {timeoutMs: 10});
    await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    runner.children[0].kill.mockImplementation(() => true);
    await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('failed'));
    expect(manager.list('project-1')[0].error.code).toBe('director_job_timeout');
    expect(runner.children[0].kill).toHaveBeenCalledWith('SIGTERM');
    await manager.dispose();
  });
  it('blocks export if any selected clip is missing or stale instead of omitting it', async () => {
    const f = await fixture(); await addShot(f.store);
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    await expect(manager.start('project-1', 'export')).rejects.toMatchObject({code: 'missing_selected_video'});
    await addVersion(f);
    const edited = await f.store.load('project-1'); edited.shots[0].duration = 6; await f.store.save('project-1', edited);
    await expect(manager.start('project-1', 'export')).rejects.toMatchObject({code: 'stale_selected_video'});
    const reverted = await f.store.load('project-1'); reverted.shots[0].duration = 8; await f.store.save('project-1', reverted);
    await rm(path.join(f.directory, 'version.mp4'));
    await expect(manager.start('project-1', 'export')).rejects.toMatchObject({code: 'missing_selected_video'});
    expect(runner.spawnProcess).not.toHaveBeenCalled();
  });
  it('refuses results outside the exact job output and never forwards raw provider errors', async () => {
    const f = await fixture(); await addShot(f.store);
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    runner.children[0].emitJson({type: 'result', operation: 'render', path: '/tmp/private.mp4'}); runner.children[0].emit('close', 0);
    await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('failed'));
    expect(manager.list('project-1')[0].error.code).toBe('invalid_director_result');
    await manager.start('project-1', 'render', 'shot-1');
    await vi.waitFor(() => expect(runner.children).toHaveLength(2));
    runner.children[1].emitJson({type: 'error', code: 'video_generation_failed', message: 'sk-private-test-key'}); runner.children[1].emit('close', 1);
    await vi.waitFor(() => expect(manager.list('project-1')[1].status).toBe('failed'));
    expect(JSON.stringify(manager.list('project-1'))).not.toContain('sk-private-test-key');
  });
});

describe('director router contract', () => {
  it.each(['render', 'export'])('pairs a completed %s job with its committed project when it finishes during snapshot loading', async (operation) => {
    const f = await fixture(); await addShot(f.store);
    if (operation === 'export') await addVersion(f);
    const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    const before = await f.store.load('project-1');
    await manager.start('project-1', operation, operation === 'render' ? 'shot-1' : undefined, before.revision);
    await vi.waitFor(() => expect(runner.children).toHaveLength(1));
    let loads = 0;
    const store = {...f.store, load: async (id) => {
      loads += 1;
      const project = await f.store.load(id);
      if (loads === 1) {
        // The first load already captured the old plan; complete and commit
        // the driver result before its awaited response reaches the router.
        await runner.children[0].complete();
        await vi.waitFor(() => expect(manager.list(id)[0].status).toBe('completed'));
      }
      return project;
    }};
    const sendJson = vi.fn();
    const route = createDirectorRouter({repoRoot: f.repoRoot, store, jobs: manager, readJsonBody: async () => ({}), sendJson});
    await route({method: 'GET', headers: {}}, {setHeader: vi.fn()}, new URL('http://127.0.0.1:4173/api/director?session=project-1'));
    const snapshot = sendJson.mock.calls[0][2];
    expect(loads).toBe(2);
    expect(snapshot.jobs[0]).toMatchObject({operation, status: 'completed'});
    expect(snapshot.project.revision).toBe(before.revision + 1);
    if (operation === 'render') {
      const version = snapshot.project.shots[0].versions.find((version) => version.id === snapshot.project.shots[0].selectedVersionId);
      expect(version).toMatchObject({path: snapshot.jobs[0].result.path, stale: false, missing: false});
    } else expect(snapshot.project.export).toMatchObject({path: snapshot.jobs[0].result.path, stale: false, missing: false});
  });

  it('returns snapshots and structured revision failures and rejects cross origin writes', async () => {
    const f = await fixture(); const runner = fakeRunner(); const {manager} = jobsFor(f, runner);
    const sendJson = vi.fn(); const response = {setHeader: vi.fn()};
    let body = {};
    const route = createDirectorRouter({repoRoot: f.repoRoot, store: f.store, jobs: manager, readJsonBody: async () => body, sendJson});
    const url = new URL('http://127.0.0.1:4173/api/director?session=project-1');
    await route({method: 'GET', headers: {}}, response, url);
    expect(sendJson.mock.calls[0][2]).toMatchObject({project: {sessionId: 'project-1', revision: 0}, jobs: [], capabilities: {videoConfigured: true, supportsFirstFrame: true}});
    body = {project: {...await f.store.load('project-1'), revision: 999}};
    await expect(route({method: 'PUT', headers: {'content-type': 'application/json'}}, response, url)).rejects.toMatchObject({statusCode: 409, code: 'revision_conflict'});
    await expect(route({method: 'PUT', headers: {'content-type': 'application/json', origin: 'https://evil.example'}}, response, url)).rejects.toMatchObject({statusCode: 403});
  });
});
