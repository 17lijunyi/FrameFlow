import {createHash} from 'node:crypto';
import {execFile as callbackExecFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {describe, expect, it, vi} from 'vitest';
import {createVideoEditorRouter} from './video-editor-routes.mjs';
import {executeLocalAgent} from './local-agent-execution.mjs';

const execFile = promisify(callbackExecFile);
const actualRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actualPython = path.join(actualRepo, '.venv/bin/python');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function resolveFFprobe() {
  const candidates = [process.env.FRAMEFLOW_FFPROBE,
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'ffprobe')),
    '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', path.join(actualRepo, '.tools/ffmpeg/ffprobe')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch { /* Try the next configured or installed probe. */ }
  }
  return null;
}

describe('independent video editor real backend', () => {
  it('imports real videos, obtains one fake CLI plan, renders manually confirmed segments and preserves originals and director settings', async (context) => {
    const ffprobe = await resolveFFprobe();
    if (!ffprobe) context.skip('Real-media integration requires ffprobe; set FRAMEFLOW_FFPROBE or install ffmpeg to run it.');
    const repoRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frameflow-editor-e2e-')));
    let route;
    try {
      const sessionId = 'project-1';
      const directory = path.join(repoRoot, '.working_dir', sessionId);
      await Promise.all(['.vimax', 'agent_runtime', 'bin', '.tools/ffmpeg', '.codex', '.working_dir/project-1/uploads'].map((relative) => mkdir(path.join(repoRoot, relative), {recursive: true})));
      await copyFile(path.join(actualRepo, 'main_video_editor.py'), path.join(repoRoot, 'main_video_editor.py'));
      await copyFile(path.join(actualRepo, 'agent_runtime/video_edit.py'), path.join(repoRoot, 'agent_runtime/video_edit.py'));
      await writeFile(path.join(repoRoot, 'agent_runtime/__init__.py'), '');
      await symlink(path.join(actualRepo, '.venv'), path.join(repoRoot, '.venv'), 'dir');
      await symlink(ffprobe, path.join(repoRoot, '.tools/ffmpeg/ffprobe'));
      // This fake home prevents the real CLI adapter from opening user settings.
      await writeFile(path.join(repoRoot, '.codex/config.toml'), '# isolated fake Agent configuration\n');
      await writeFile(path.join(repoRoot, '.vimax/sessions.json'), JSON.stringify({active_session_id: sessionId, sessions: {[sessionId]: {session_id: sessionId, project_name: '独立剪辑测试'}}}));
      const director = '{"schemaVersion":1,"keep":"original API timeline","shots":[]}\n';
      const roles = '{"schemaVersion":1,"roles":{"video":"video_api","assistant":"api"},"executors":{},"capabilities":{}}\n';
      await writeFile(path.join(directory, 'director.json'), director);
      await writeFile(path.join(repoRoot, '.vimax/role-executors.json'), roles);
      const {stdout: binaryResult} = await execFile(actualPython, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], {timeout: 10_000});
      const ffmpeg = binaryResult.trim();
      const red = path.join(directory, 'uploads/red.mp4');
      const blue = path.join(directory, 'uploads/blue.mp4');
      await execFile(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x32:r=24:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red], {timeout: 10_000});
      await execFile(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x64:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue], {timeout: 10_000});
      const originalHashes = await Promise.all([red, blue].map(async (file) => hash(await readFile(file))));

      const fakeAgent = path.join(repoRoot, 'bin/codex');
      const callLog = path.join(repoRoot, 'fake-agent-calls.jsonl');
      const fakeScript = `#!${process.execPath}
import {appendFileSync, readFileSync} from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 1.2.3'); process.exit(0); }
if (args.includes('--help')) { console.log(args.includes('exec') ? 'codex exec --json --sandbox --ephemeral --skip-git-repo-check --image' : 'Codex CLI --config --ask-for-approval'); process.exit(0); }
if (!args.includes('exec')) process.exit(2);
const prompt = readFileSync(0, 'utf8');
const sources = JSON.parse(prompt.split('素材元数据：')[1]);
appendFileSync(process.env.FRAMEFLOW_FAKE_AGENT_CALLS, JSON.stringify({args, prompt}) + '\\n');
const segments = sources.map(({sourceId, duration}) => ({sourceId, start: 0, end: duration}));
console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify({segments})}}));
console.log(JSON.stringify({type: 'turn.completed', usage: {}}));
`;
      // The extensionless executable is ESM through its isolated package.
      await writeFile(path.join(repoRoot, 'package.json'), '{"type":"module"}');
      await writeFile(fakeAgent, fakeScript);
      await chmod(fakeAgent, 0o755);
      const options = [{id: 'cli:codex', kind: 'cli', agentId: 'codex', name: 'Fake Codex CLI', available: true, adapterAvailable: true, executablePath: fakeAgent, version: '1.2.3', fingerprint: 'isolated-fake-v1'}];
      const executeAgent = vi.fn((request) => executeLocalAgent({...request, homeDir: repoRoot}));
      const env = {PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, FRAMEFLOW_FFMPEG: ffmpeg, FRAMEFLOW_FFPROBE: path.join(repoRoot, '.tools/ffmpeg/ffprobe'), FRAMEFLOW_FAKE_AGENT_CALLS: callLog};
      route = createVideoEditorRouter({repoRoot, executorStore: {read: async () => ({options})}, executeAgent, env,
        resolveCommand: () => ({command: path.join(repoRoot, '.venv/bin/python')}),
        readJsonBody: async (request) => request.body,
        sendJson: (response, status, data) => { response.status = status; response.data = data; }});
      async function request(action = '', method = 'GET', body = {}) {
        const response = {setHeader() {}};
        const url = new URL(`http://127.0.0.1:3410/api/director/editor${action ? `/${action}` : ''}?session=${sessionId}`);
        expect(await route({method, headers: {'content-type': 'application/json', origin: url.origin}, body}, response, url)).toBe(true);
        expect(response.status).toBe(method === 'POST' && ['plan', 'render'].includes(action) ? 202 : 200);
        return response.data;
      }
      async function completed(id) {
        await vi.waitFor(() => {
          const job = route.jobs.list(sessionId).find((job) => job.id === id);
          if (job?.status === 'failed') throw new Error(`${job.error?.code}: ${job.message}`);
          expect(job?.status).toBe('completed');
        }, {timeout: 20_000, interval: 20});
      }
      let snapshot = await request();
      snapshot = await request('sources', 'POST', {revision: snapshot.project.revision, paths: ['uploads/red.mp4', 'uploads/blue.mp4']});
      expect(snapshot.project.sources.map(({duration, hasAudio}) => ({duration, hasAudio}))).toEqual([{duration: .5, hasAudio: true}, {duration: .5, hasAudio: false}]);
      snapshot.project.agentId = 'cli:codex';
      snapshot.project.instruction = '先按导入顺序保留两段完整素材，我会确认时间范围。';
      snapshot.project.sources[0].description = '红色画面，有声音';
      snapshot.project.sources[1].description = '蓝色画面，没有声音';
      snapshot = await request('', 'PUT', {project: snapshot.project});
      const planned = await request('plan', 'POST', {revision: snapshot.project.revision});
      await completed(planned.job.id);
      snapshot = await request();
      expect(snapshot.project.segments).toEqual(snapshot.project.sources.map(({id, duration}) => ({sourceId: id, start: 0, end: duration})));
      expect(snapshot.project.planStale).toBe(false);
      expect(executeAgent).toHaveBeenCalledTimes(1);
      expect(executeAgent.mock.calls[0][0].images).toEqual([]);
      expect(executeAgent.mock.calls[0][0].prompt).not.toContain(directory);
      const [redSource, blueSource] = snapshot.project.sources;
      snapshot.project.segments = [{sourceId: blueSource.id, start: .125, end: .375}, {sourceId: redSource.id, start: 0, end: .25}];
      snapshot = await request('', 'PUT', {project: snapshot.project});
      const confirmed = structuredClone(snapshot.project.segments);
      const rendered = await request('render', 'POST', {revision: snapshot.project.revision});
      await completed(rendered.job.id);
      snapshot = await request();
      expect(snapshot.project.segments).toEqual(confirmed);
      expect(snapshot.project.output).toMatchObject({missing: false, stale: false});
      expect(snapshot.project.output.duration).toBeCloseTo(.5, 5);
      expect(snapshot.project.output.path).toMatch(/^video-editor\/job-[A-Za-z0-9-]+\/render\.mp4$/);
      expect(executeAgent).toHaveBeenCalledTimes(1);
      expect((await readFile(callLog, 'utf8')).trim().split('\n')).toHaveLength(1);
      const output = path.join(directory, snapshot.project.output.path);
      const {stdout: streamProbe} = await execFile(path.join(repoRoot, '.tools/ffmpeg/ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time,duration,nb_frames,r_frame_rate', '-of', 'json', output], {timeout: 10_000});
      expect(JSON.parse(streamProbe).streams[0]).toMatchObject({start_time: '0.000000', duration: '0.500000', nb_frames: '15', r_frame_rate: '30/1'});
      const inspect = `import json,sys,numpy as np
from moviepy import VideoFileClip
with VideoFileClip(sys.argv[1]) as v:
 print(json.dumps({'size':v.size,'duration':v.duration,'first':v.get_frame(.1)[360,640].tolist(),'second':v.get_frame(.4)[360,640].tolist(),'silent':float(np.abs(v.audio.get_frame(.08)).max()),'tone':float(np.abs(v.audio.get_frame(.39)).max())}))`;
      const {stdout} = await execFile(actualPython, ['-c', inspect, output], {timeout: 10_000});
      const actual = JSON.parse(stdout);
      expect(actual.size).toEqual([1280, 720]);
      expect(actual.duration).toBeCloseTo(.5, 2);
      expect(actual.first[2]).toBeGreaterThan(180);
      expect(actual.second[0]).toBeGreaterThan(180);
      expect(actual.silent).toBeLessThan(.01);
      expect(actual.tone).toBeGreaterThan(.01);
      expect(await Promise.all([red, blue].map(async (file) => hash(await readFile(file))))).toEqual(originalHashes);
      expect(await readFile(path.join(directory, 'director.json'), 'utf8')).toBe(director);
      expect(await readFile(path.join(repoRoot, '.vimax/role-executors.json'), 'utf8')).toBe(roles);
      expect(await readdir(path.dirname(output))).toEqual(['render.mp4']);
      expect(await readFile(path.join(directory, 'video-editor.json'), 'utf8')).toContain('"agentId": "cli:codex"');
    } finally {
      await route?.dispose();
      await rm(repoRoot, {recursive: true, force: true});
    }
  }, 30_000);
});
