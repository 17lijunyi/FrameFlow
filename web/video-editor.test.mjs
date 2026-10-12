import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createVideoEditorStore, validateEditorSegments} from './video-editor-store.mjs';
import {createVideoEditorJobs} from './video-editor-jobs.mjs';
import {createVideoEditorRouter} from './video-editor-routes.mjs';
const fixtures = []; const managers = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); for (const directory of fixtures.splice(0)) await rm(directory, {recursive: true, force: true}); });
async function fixture() {
  const repoRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frameflow-video-editor-'))); fixtures.push(repoRoot);
  const directory = path.join(repoRoot, '.working_dir', 'project-1'); await mkdir(directory, {recursive: true}); await mkdir(path.join(repoRoot, '.vimax')); await mkdir(path.join(directory, 'uploads'));
  await writeFile(path.join(repoRoot, '.vimax', 'sessions.json'), JSON.stringify({active_session_id: 'project-1', sessions: {'project-1': {session_id: 'project-1', project_name: '编辑项目'}}}));
  const untouched = {director: '{"keep":"original timeline"}', roles: '{"roles":{"video":"video_api","assistant":"api"}}'};
  await writeFile(path.join(directory, 'director.json'), untouched.director); await writeFile(path.join(repoRoot, '.vimax', 'role-executors.json'), untouched.roles); await writeFile(path.join(directory, 'uploads', 'source.mp4'), 'original-video');
  const metadata = {duration: 20.25, width: 1920, height: 1080, hasAudio: true}; const probeVideo = vi.fn(async () => metadata); const store = createVideoEditorStore({repoRoot, probeVideo});
  let options = [{id: 'api', kind: 'api'}, {id: 'cli:codex', kind: 'cli', agentId: 'codex', name: 'Codex CLI', available: true, adapterAvailable: true, executablePath: '/fake/codex', version: '1.2.3', fingerprint: 'v1'}, {id: 'cli:hermes', kind: 'cli', agentId: 'hermes', name: 'Hermes', available: true, adapterAvailable: false, executablePath: '/fake/hermes', fingerprint: 'hermes'}];
  const executorStore = {read: vi.fn(async () => ({options})), save: vi.fn()}; return {repoRoot, directory, store, probeVideo, metadata, executorStore, setOptions: (next) => { options = next; }, untouched};
}
async function ready(f) { let p = await f.store.importSources('project-1', {revision: 0, paths: ['uploads/source.mp4']}); p.agentId = 'cli:codex'; p.instruction = '保留开场前八秒'; return f.store.save('project-1', p); }
async function withSegments(f) { const p = await ready(f); p.segments = [{sourceId: p.sources[0].id, start: 0, end: 8}]; return f.store.save('project-1', p); }
function fakeRunner() {
  const children = []; const spawnProcess = vi.fn((_command, args) => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = vi.fn(() => { setImmediate(() => c.emit('close', null)); return true; }); c.event = (event) => c.stdout.write(JSON.stringify(event) + '\n'); c.request = async () => JSON.parse(await readFile(args[args.indexOf('--request') + 1], 'utf8'));
    c.complete = async (patch = {}) => { const r = await c.request(); if (r.operation === 'probe') c.event({type: 'result', operation: 'probe', duration: 20, width: 640, height: 480, hasAudio: false, ...patch}); else { await writeFile(r.outputPath, 'final-video'); c.event({type: 'result', operation: 'render', path: r.outputPath, duration: 8, segments: r.segments, ...patch}); } c.emit('close', 0); }; children.push(c); return c;
  }); return {children, spawnProcess};
}
function jobsFor(f, options = {}) {
  const runner = fakeRunner(); const executeAgent = vi.fn(async () => ({text: JSON.stringify({segments: [{sourceId: (await f.store.load('project-1')).sources[0].id, start: 0, end: 8}]})}));
  const manager = createVideoEditorJobs({repoRoot: f.repoRoot, store: f.store, executorStore: f.executorStore, resolveCommand: () => ({command: '/fake/python'}), spawnProcess: runner.spawnProcess, executeAgent, env: {}, ...options}); managers.push(manager); return {manager, runner, executeAgent};
}
async function completed(manager, i = 0) { await vi.waitFor(() => expect(manager.list('project-1')[i].status).toBe('completed')); }
async function childReady(runner, count = 1) { await vi.waitFor(() => expect(runner.children).toHaveLength(count)); }

describe('independent editor project', () => {
  it('probes sources and writes only independent state without changing director, role preferences or source bytes', async () => {
    const f = await fixture(); expect(await f.store.load('project-1')).toMatchObject({revision: 0, agentId: '', sources: []}); const p = await ready(f);
    expect(p).toMatchObject({revision: 2, sources: [{duration: 20.25, width: 1920, height: 1080, hasAudio: true, missing: false, stale: false}]}); expect(f.probeVideo).toHaveBeenCalledWith({repoRoot: f.repoRoot, sessionDir: f.directory, path: path.join(f.directory, 'uploads/source.mp4')});
    expect(await readFile(path.join(f.directory, 'director.json'), 'utf8')).toBe(f.untouched.director); expect(await readFile(path.join(f.repoRoot, '.vimax/role-executors.json'), 'utf8')).toBe(f.untouched.roles); expect(await readFile(path.join(f.directory, 'uploads/source.mp4'), 'utf8')).toBe('original-video');
  });
  it('serializes revision saves and ignores fabricated source paths and probe metadata', async () => {
    const f = await fixture(); const p = await ready(f); const a = structuredClone(p); const b = structuredClone(p); a.sources[0].description = '舞台'; a.sources[0].path = '../../secret.mp4'; a.sources[0].duration = 999; b.instruction = '另一份';
    const results = await Promise.allSettled([f.store.save('project-1', a), f.store.save('project-1', b)]); expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']); expect(results[1].reason.code).toBe('revision_conflict');
    const saved = await f.store.load('project-1'); expect(saved.sources[0]).toMatchObject({path: 'uploads/source.mp4', duration: 20.25}); saved.sources.push({id: 'fake'}); await expect(f.store.save('project-1', saved)).rejects.toBeInstanceOf(Error);
  });
  it('preserves unchanged plans, invalidates only output on manual segment/canvas changes and clears plans on content edits', async () => {
    const f = await fixture(); let p = await withSegments(f); p = await f.store.save('project-1', p); expect(p.segments).toHaveLength(1); const {manager, runner, executeAgent} = jobsFor(f);
    await manager.start('project-1', 'render', p.revision); await childReady(runner); await runner.children[0].complete(); await completed(manager); expect(executeAgent).not.toHaveBeenCalled(); p = await f.store.load('project-1'); expect(p.output.stale).toBe(false);
    p.settings.aspectRatio = '9:16'; p = await f.store.save('project-1', p); expect(p.output.stale).toBe(true); expect(p.segments).toHaveLength(1); expect(p.sources[0].stale).toBe(false);
    p.instruction = '新要求'; p = await f.store.save('project-1', p); expect(p.segments).toEqual([]); expect(p.output.stale).toBe(true); p.segments = [{sourceId: p.sources[0].id, start: 1, end: 5}]; p = await f.store.save('project-1', p); expect(p.segments).toHaveLength(1); p.sources[0].description = '新说明'; expect((await f.store.save('project-1', p)).segments).toEqual([]);
  });
  it('rejects escapes, nonvideo types, source overflow and corrupt batches before partial persistence', async () => {
    const f = await fixture(); const outside = path.join(f.repoRoot, 'outside.mp4'); await writeFile(outside, 'private'); await symlink(outside, path.join(f.directory, 'uploads/escape.mp4'));
    for (const relative of ['../../outside.mp4', outside, 'uploads/escape.mp4', 'uploads/file.txt']) await expect(f.store.importSources('project-1', {revision: 0, paths: [relative]})).rejects.toBeInstanceOf(Error); expect(f.probeVideo).not.toHaveBeenCalled(); await expect(f.store.importSources('project-1', {revision: 0, paths: Array(21).fill('uploads/source.mp4')})).rejects.toBeInstanceOf(Error);
    await writeFile(path.join(f.directory, 'uploads/broken.mov'), 'broken'); f.probeVideo.mockImplementation(async (r) => r.path.endsWith('broken.mov') ? {duration: 0} : f.metadata); await expect(f.store.importSources('project-1', {revision: 0, paths: ['uploads/source.mp4', 'uploads/broken.mov']})).rejects.toMatchObject({code: 'invalid_video'}); expect((await f.store.load('project-1')).sources).toEqual([]);
  });
  it('detects changed content and missing source files even when source metadata is retained', async () => {
    const f = await fixture(); await withSegments(f); const file = path.join(f.directory, 'uploads/source.mp4'); const before = await stat(file); await writeFile(file, 'different-data'); await utimes(file, before.atime, before.mtime); let p = await f.store.load('project-1'); expect(p.sources[0]).toMatchObject({stale: true, missing: false}); expect(p.planStale).toBe(true); await rm(file); expect((await f.store.load('project-1')).sources[0]).toMatchObject({stale: true, missing: true});
  });
  it('enforces strict referenced finite ranges, minimum cut duration and total budget', () => {
    const sources = [{id: 'a', duration: 3600}]; for (const segments of [[], [{sourceId: 'b', start: 0, end: 2}], [{sourceId: 'a', start: -1, end: 2}], [{sourceId: 'a', start: 0, end: Infinity}], [{sourceId: 'a', start: 0, end: .01}], [{sourceId: 'a', start: 0, end: 1801}], [{sourceId: 'a', start: 0, end: 2, command: 'unsafe'}]]) expect(() => validateEditorSegments(segments, sources)).toThrow(); expect(validateEditorSegments([{sourceId: 'a', start: 2, end: 5}], sources)).toHaveLength(1);
  });
});

describe('independent editor planning and rendering', () => {
  it('calls only selected local CLI for metadata planning, then renders saved cuts without another Agent invocation', async () => {
    const f = await fixture(); const p = await ready(f); const {manager, runner, executeAgent} = jobsFor(f); expect((await manager.agents()).map((a) => a.id)).toEqual(['cli:codex', 'cli:hermes']); await manager.start('project-1', 'plan', p.revision); await completed(manager);
    expect(executeAgent).toHaveBeenCalledTimes(1); expect(executeAgent.mock.calls[0][0]).toMatchObject({agentId: 'codex', executablePath: '/fake/codex', expectedVersion: '1.2.3', images: []}); expect(executeAgent.mock.calls[0][0].prompt).not.toContain(f.directory); expect(executeAgent.mock.calls[0][0].prompt).toContain('不声称已观看视频');
    const planned = await f.store.load('project-1'); await manager.start('project-1', 'render', planned.revision); await childReady(runner); const request = await runner.children[0].request(); expect(request).toMatchObject({operation: 'render', segments: planned.segments}); expect(request.outputPath).toContain('/video-editor/job-'); await runner.children[0].complete(); await completed(manager, 1); expect(executeAgent).toHaveBeenCalledTimes(1); expect((await f.store.load('project-1')).output).toMatchObject({stale: false, missing: false}); expect(f.executorStore.save).not.toHaveBeenCalled(); expect(await readFile(path.join(f.directory, 'director.json'), 'utf8')).toBe(f.untouched.director);
  });
  it('rejects pending adapters without fallback and rejects fenced or invalid Agent JSON', async () => {
    const f = await fixture(); let p = await ready(f); const {manager, runner, executeAgent} = jobsFor(f); p.agentId = 'cli:hermes'; p = await f.store.save('project-1', p); await expect(manager.start('project-1', 'plan', p.revision)).rejects.toMatchObject({code: 'local_agent_not_adapted'}); expect(executeAgent).not.toHaveBeenCalled(); expect(runner.spawnProcess).not.toHaveBeenCalled();
    p.agentId = 'cli:codex'; p = await f.store.save('project-1', p); executeAgent.mockResolvedValue({text: '```json\n{"segments":[]}\n```'}); await manager.start('project-1', 'plan', p.revision); await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('failed')); expect(manager.list('project-1')[0].error.code).toBe('invalid_edit_plan'); expect((await f.store.load('project-1')).segments).toEqual([]);
  });
  it('reserves sessions before preflight and enforces task exclusivity', async () => {
    const f = await fixture(); const p = await ready(f); let release; const {manager} = jobsFor(f, {executeAgent: () => new Promise((resolve) => { release = resolve; })}); await manager.start('project-1', 'plan', p.revision); await vi.waitFor(() => expect(release).toBeTypeOf('function')); await expect(manager.start('project-1', 'render', p.revision)).rejects.toMatchObject({code: 'editor_job_busy'}); expect(() => manager.assertWritable('project-1')).toThrow(); release({text: JSON.stringify({segments: [{sourceId: p.sources[0].id, start: 0, end: 8}]})}); await completed(manager);
  });
  it('rejects revision or changed file preflight before Agent work', async () => {
    const f = await fixture(); const p = await ready(f); const {manager, executeAgent} = jobsFor(f); await expect(manager.start('project-1', 'plan', p.revision - 1)).rejects.toMatchObject({code: 'revision_conflict'}); await writeFile(path.join(f.directory, 'uploads/source.mp4'), 'changed'); await expect(manager.start('project-1', 'plan', p.revision)).rejects.toMatchObject({code: 'source_changed'}); expect(executeAgent).not.toHaveBeenCalled();
  });
  it('checks Agent identity, source fingerprints and revision again before committing', async () => {
    for (const change of ['agent', 'revision', 'source']) { const f = await fixture(); const p = await ready(f); let release; const {manager} = jobsFor(f, {executeAgent: () => new Promise((resolve) => { release = resolve; })}); await manager.start('project-1', 'plan', p.revision); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      if (change === 'agent') f.setOptions([{id: 'cli:codex', kind: 'cli', agentId: 'codex', available: true, adapterAvailable: true, executablePath: '/different/codex', fingerprint: 'v2'}]); else if (change === 'revision') { p.instruction = '新要求'; await f.store.save('project-1', p); } else await writeFile(path.join(f.directory, 'uploads/source.mp4'), 'changed'); release({text: JSON.stringify({segments: [{sourceId: p.sources[0].id, start: 0, end: 8}]})}); await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('failed')); expect(manager.list('project-1')[0].error.code).toBe(change === 'agent' ? 'executor_changed' : change === 'revision' ? 'revision_conflict' : 'source_changed'); expect((await f.store.load('project-1')).segments).toEqual([]);
    }
  });
  it('cancels Agent signals and never stores late plans', async () => {
    const f = await fixture(); const p = await ready(f); let release; const executeAgent = vi.fn(({signal}) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('private')), {once: true}); })); const {manager} = jobsFor(f, {executeAgent}); const job = await manager.start('project-1', 'plan', p.revision); await vi.waitFor(() => expect(release).toBeTypeOf('function')); await manager.cancel('project-1', job.id); await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('cancelled')); release({text: '{}'}); expect((await f.store.load('project-1')).segments).toEqual([]); expect(executeAgent.mock.calls[0][0].signal.aborted).toBe(true);
  });
  it('disposes even when an Agent promise ignores abort and applies its own Agent timeout', async () => {
    for (const operation of ['dispose', 'timeout']) {
      const f = await fixture(); const p = await ready(f); const {manager} = jobsFor(f, {executeAgent: () => new Promise(() => {}), ...(operation === 'timeout' ? {agentTimeoutMs: 10} : {})});
      await manager.start('project-1', 'plan', p.revision);
      if (operation === 'dispose') { await manager.dispose(); expect(manager.list('project-1')[0].status).toBe('cancelled'); }
      else { await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('failed')); expect(manager.list('project-1')[0].error.code).toBe('local_agent_timeout'); }
      expect((await f.store.load('project-1')).segments).toEqual([]);
    }
  });
  it('waits for the underlying Agent process cleanup after the job has already observed cancellation', async () => {
    const f = await fixture(); const p = await ready(f); let cleaned = false;
    const executeAgent = vi.fn(({signal}) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => setTimeout(() => { cleaned = true; reject(new Error('terminated')); }, 25), {once: true}); }));
    const {manager} = jobsFor(f, {executeAgent}); await manager.start('project-1', 'plan', p.revision); await vi.waitFor(() => expect(executeAgent).toHaveBeenCalledTimes(1));
    await manager.dispose(); expect(cleaned).toBe(true); expect(manager.list('project-1')[0].status).toBe('cancelled');
  });
  it('cancels its render child and cleans partial output while preserving sources', async () => {
    const f = await fixture(); const p = await withSegments(f); const {manager, runner} = jobsFor(f); const job = await manager.start('project-1', 'render', p.revision); await childReady(runner); const r = await runner.children[0].request(); await writeFile(r.outputPath, 'partial'); await manager.cancel('project-1', job.id); await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('cancelled')); expect(runner.children[0].kill).toHaveBeenCalledWith('SIGTERM'); await expect(readFile(r.outputPath)).rejects.toMatchObject({code: 'ENOENT'}); expect(await readFile(path.join(f.directory, 'uploads/source.mp4'), 'utf8')).toBe('original-video');
  });
  it('maps driver percentage progress accurately and rejects changes to confirmed segments', async () => {
    const f = await fixture(); const p = await withSegments(f); const {manager, runner} = jobsFor(f); await manager.start('project-1', 'render', p.revision); await childReady(runner);
    runner.children[0].event({type: 'progress', progress: 5, message: 'private-url'}); expect(manager.list('project-1')[0].progress).toBe(.05);
    runner.children[0].event({type: 'progress', progress: 50}); expect(manager.list('project-1')[0].progress).toBe(.5);
    await runner.children[0].complete({segments: [{sourceId: p.sources[0].id, start: 1, end: 8}]}); await vi.waitFor(() => expect(manager.list('project-1')[0].status).toBe('failed')); expect(manager.list('project-1')[0].error.code).toBe('invalid_editor_result'); expect(JSON.stringify(manager.list('project-1'))).not.toContain('private-url'); expect((await f.store.load('project-1')).output).toBeUndefined();
  });
  it('retains previous output after render/save conflict and never forwards private driver messages', async () => {
    const f = await fixture(); let p = await withSegments(f); const {manager, runner} = jobsFor(f); await manager.start('project-1', 'render', p.revision); await childReady(runner); await runner.children[0].complete(); await completed(manager); p = await f.store.load('project-1'); const old = p.output.path; await manager.start('project-1', 'render', p.revision); await childReady(runner, 2); p.settings.resolution = '1080p'; await f.store.save('project-1', p); await runner.children[1].complete(); await vi.waitFor(() => expect(manager.list('project-1')[1].status).toBe('failed')); expect((await f.store.load('project-1')).output.path).toBe(old);
    p = await f.store.load('project-1'); await manager.start('project-1', 'render', p.revision); await childReady(runner, 3); runner.children[2].event({type: 'error', code: 'video_edit_failed', message: 'private-key-url'}); runner.children[2].emit('close', 1); await vi.waitFor(() => expect(manager.list('project-1')[2].status).toBe('failed')); expect(JSON.stringify(manager.list('project-1'))).not.toContain('private-key');
  });
});

describe('independent editor routing', () => {
  it('reloads the project when a job finishes during source hashing so completed jobs always include their saved result', async () => {
    let state = 'running'; let loads = 0;
    const store = {session: async () => ({}), load: async () => { loads += 1; if (loads === 1) { state = 'completed'; return {revision: 1, segments: []}; } return {revision: 2, segments: [{sourceId: 'a', start: 0, end: 1}]}; }};
    const jobs = {list: () => [{id: 'job-1', status: state}], agents: async () => [], dispose: async () => {}};
    const sendJson = vi.fn(); const route = createVideoEditorRouter({store, jobs, readJsonBody: async () => ({}), sendJson});
    await route({method: 'GET', headers: {}}, {setHeader: vi.fn()}, new URL('http://127.0.0.1:4173/api/director/editor?session=project-1'));
    expect(loads).toBe(2); expect(sendJson.mock.calls[0][2]).toMatchObject({project: {revision: 2, segments: [{sourceId: 'a'}]}, jobs: [{status: 'completed'}]});
  });
  it('reserves source mutations before probing and blocks planning the previous source list', async () => {
    const f = await fixture(); const p = await ready(f); const {manager} = jobsFor(f); let release;
    const changing = manager.mutate('project-1', () => new Promise((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(manager.start('project-1', 'plan', p.revision)).rejects.toMatchObject({code: 'editor_job_busy'});
    release(); await changing; expect(() => manager.assertWritable('project-1')).not.toThrow();
  });
  it('probes through fixed dedicated Python arguments with no API configuration', async () => {
    const f = await fixture(); const {manager, runner} = jobsFor(f); const pending = manager.probe({repoRoot: f.repoRoot, sessionDir: f.directory, path: path.join(f.directory, 'uploads/source.mp4')}); await childReady(runner); const [command, args, options] = runner.spawnProcess.mock.calls[0]; expect(command).toBe('/fake/python'); expect(args.slice(0, 2)).toEqual([path.join(f.repoRoot, 'main_video_editor.py'), '--request']); expect(options).toMatchObject({shell: false, env: {}}); expect((await runner.children[0].request()).operation).toBe('probe'); await runner.children[0].complete(); expect(await pending).toMatchObject({duration: 20, hasAudio: false}); await expect(readFile(args[2])).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('cancels in-progress probe children and waits for temporary request cleanup when their session closes', async () => {
    const f = await fixture(); const {manager, runner} = jobsFor(f); const pending = manager.probe({repoRoot: f.repoRoot, sessionDir: f.directory, path: path.join(f.directory, 'uploads/source.mp4')}); pending.catch(() => {});
    await childReady(runner); const requestPath = runner.spawnProcess.mock.calls[0][1][2]; await manager.cancelSession('project-1'); await expect(pending).rejects.toMatchObject({code: 'cancelled'});
    expect(runner.children[0].kill).toHaveBeenCalledWith('SIGTERM'); await expect(readFile(requestPath)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('returns CLI-only agents, imports and plans independently, and rejects cross-origin writes', async () => {
    const f = await fixture(); const sendJson = vi.fn(); const response = {setHeader: vi.fn()}; let body = {}; const executeAgent = vi.fn(async () => ({text: JSON.stringify({segments: [{sourceId: (await f.store.load('project-1')).sources[0].id, start: 0, end: 8}]})})); const route = createVideoEditorRouter({repoRoot: f.repoRoot, store: f.store, executorStore: f.executorStore, executeAgent, probeVideo: f.probeVideo, readJsonBody: async () => body, sendJson, env: {}}); managers.push(route.jobs); const base = 'http://127.0.0.1:4173/api/director/editor?session=project-1'; const headers = {'content-type': 'application/json'};
    await route({method: 'GET', headers: {}}, response, new URL(base)); expect(sendJson.mock.calls[0][2]).toMatchObject({project: {sources: [], agentId: ''}, agents: [{id: 'cli:codex'}, {id: 'cli:hermes'}]}); body = {revision: 0, paths: ['uploads/source.mp4']}; await route({method: 'POST', headers}, response, new URL(base.replace('/editor?', '/editor/sources?'))); body = {project: await f.store.load('project-1')}; body.project.agentId = 'cli:codex'; body.project.instruction = '开头'; await route({method: 'PUT', headers}, response, new URL(base)); body = {revision: 2}; await route({method: 'POST', headers}, response, new URL(base.replace('/editor?', '/editor/plan?'))); expect(sendJson.mock.calls.at(-1)[1]).toBe(202); await completed(route.jobs); await expect(route({method: 'PUT', headers: {...headers, origin: 'https://evil.example'}}, response, new URL(base))).rejects.toMatchObject({statusCode: 403}); expect(await route({method: 'GET', headers: {}}, response, new URL('http://127.0.0.1:4173/api/director?session=project-1'))).toBe(false);
  });
});
