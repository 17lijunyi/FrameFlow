import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDirectorStore} from './director-store.mjs';
import {createDirectorJobs} from './director-jobs.mjs';

const roots = [];
const managers = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frameflow-wan-director-')));
  roots.push(root);
  const directory = path.join(root, '.working_dir', 'project-1');
  await mkdir(directory, {recursive: true});
  await mkdir(path.join(root, '.vimax'));
  await writeFile(path.join(root, '.vimax', 'sessions.json'), JSON.stringify({
    active_session_id: 'project-1', sessions: {'project-1': {
      session_id: 'project-1', project_name: '万相离线测试', working_dir: '.working_dir/project-1', stage: 'created',
    }},
  }));
  await writeFile(path.join(directory, 'first.png'), 'original-frame-bytes');
  await writeFile(path.join(directory, 'version.mp4'), 'offline-video');
  const store = createDirectorStore({repoRoot: root});
  const project = await store.load('project-1');
  project.shots.push({id: 'shot-1', title: '测试镜头', prompt: '街角的树随风摆动', duration: 5,
    firstFrame: 'first.png', lastFrame: '', selectedVersionId: '', versions: []});
  await store.save('project-1', project);
  return {root, directory, store};
}

async function capturedVersion(f, id, aspectRatioFromImage) {
  const project = await f.store.load('project-1');
  const mode = aspectRatioFromImage === true ? {aspectRatioFromImage: true} : {};
  return {id, path: 'version.mp4', createdAt: new Date().toISOString(), duration: 5,
    fingerprint: await f.store.fingerprint(f.directory, project.settings, project.shots[0], false, mode), ...mode};
}

describe('director versions whose generated ratio follows the source image', () => {
  it('keeps a Wan clip usable after changing only export ratio and allows a new offline export', async () => {
    const f = await fixture();
    let project = await f.store.addVersion('project-1', 'shot-1', await capturedVersion(f, 'wan-1', true));
    project = await f.store.setExport('project-1', {path: 'version.mp4', fingerprint: f.store.exportFingerprint(project)});
    expect(project.export.stale).toBe(false);
    const previousFullFingerprint = project.shots[0].currentFingerprint;
    project.settings.aspectRatio = '9:16';
    project = await f.store.save('project-1', project);
    const version = project.shots[0].versions[0];
    expect(version).toMatchObject({aspectRatioFromImage: true, stale: false, missing: false});
    expect(version.currentFingerprint).toBe(version.fingerprint);
    expect(project.shots[0].currentFingerprint).not.toBe(previousFullFingerprint);
    expect(project.export.stale).toBe(true);
    const persisted = JSON.parse(await readFile(path.join(f.directory, 'director.json'), 'utf8'));
    expect(persisted.shots[0].versions[0].aspectRatioFromImage).toBe(true);

    const spawnProcess = vi.fn((_command, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = vi.fn(() => { setImmediate(() => child.emit('close', null)); return true; });
      setImmediate(async () => {
        const request = JSON.parse(await readFile(args[args.indexOf('--request') + 1], 'utf8'));
        expect(request.settings.aspectRatio).toBe('9:16');
        expect(request.clips).toHaveLength(1);
        await writeFile(request.outputPath, 'offline-export');
        child.stdout.write(`${JSON.stringify({type: 'result', operation: 'export', path: request.outputPath, duration: 5})}\n`);
        child.emit('close', 0);
      });
      return child;
    });
    const manager = createDirectorJobs({repoRoot: f.root, store: f.store, spawnProcess,
      resolveCommand: () => ({command: '/fake/python', args: []}),
      queryCapabilities: async () => { throw new Error('offline export must not query paid providers'); }});
    managers.push(manager);
    const job = await manager.start('project-1', 'export');
    await vi.waitFor(() => expect(manager.list('project-1').find((item) => item.id === job.id)?.status).toBe('completed'));
    expect((await f.store.load('project-1')).export).toMatchObject({stale: false, missing: false});
  });

  it('keeps legacy ratio invalidation independent from a Wan version in the same shot', async () => {
    const f = await fixture();
    await f.store.addVersion('project-1', 'shot-1', await capturedVersion(f, 'legacy-1', false));
    let project = await f.store.addVersion('project-1', 'shot-1', await capturedVersion(f, 'wan-1', true));
    project.settings.aspectRatio = '9:16';
    project = await f.store.save('project-1', project);
    expect(project.shots[0].versions.find((version) => version.id === 'legacy-1')).toMatchObject({stale: true});
    expect(project.shots[0].versions.find((version) => version.id === 'wan-1')).toMatchObject({stale: false});
    const legacy = project.shots[0].versions.find((version) => version.id === 'legacy-1');
    expect(legacy.aspectRatioFromImage).toBeUndefined();
    expect(legacy.currentFingerprint).toBe(project.shots[0].currentFingerprint);
    project.settings.aspectRatio = '16:9';
    project = await f.store.save('project-1', project);
    expect(project.shots[0].versions.every((version) => !version.stale)).toBe(true);
  });

  it.each(['prompt', 'resolution', 'style', 'duration', 'frame-bytes', 'last-frame'])('still marks Wan video stale when %s changes', async (field) => {
    const f = await fixture();
    let project = await f.store.addVersion('project-1', 'shot-1', await capturedVersion(f, 'wan-1', true));
    if (field === 'prompt') project.shots[0].prompt = '另一段画面';
    if (field === 'resolution') project.settings.resolution = '1080p';
    if (field === 'style') project.settings.style = '水彩风格';
    if (field === 'duration') project.shots[0].duration = 10;
    if (field === 'last-frame') project.shots[0].lastFrame = 'first.png';
    if (field === 'frame-bytes') await writeFile(path.join(f.directory, 'first.png'), 'updated-frame-bytes');
    project = await f.store.save('project-1', project);
    expect(project.shots[0].versions[0].stale).toBe(true);
  });

  it.each([true, false])('selects a completed result after ratio changed only when source ratio mode is %s', async (sourceRatio) => {
    const f = await fixture();
    const version = await capturedVersion(f, 'completed-1', sourceRatio);
    let project = await f.store.load('project-1');
    project.settings.aspectRatio = '9:16';
    await f.store.save('project-1', project);
    project = await f.store.addVersion('project-1', 'shot-1', version);
    expect(project.shots[0].selectedVersionId).toBe(sourceRatio ? 'completed-1' : '');
    expect(project.shots[0].versions[0].stale).toBe(!sourceRatio);
  });
});
