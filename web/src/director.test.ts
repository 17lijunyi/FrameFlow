import {describe, expect, it} from 'vitest';
import {createDirectorShot, defaultDirectorDuration, directorRenderSignature, directorTimeline, duplicateDirectorShot, isDirectorJobActive, isDirectorVersionStale, mergeDirectorMetadata, moveDirectorShot, selectedDirectorVersion, usableDirectorVersion, validateDirectorShot} from './director';
import type {DirectorJob, DirectorProject, DirectorShot} from './director';

const settings = {style: '自然光', aspectRatio: '16:9', resolution: '720p'};
const shot = (id = 'a'): DirectorShot => ({...createDirectorShot(0, 8, id), prompt: '镜头推进到海岸', firstFrame: 'uploads/frame.png'});
const project = (shots: DirectorShot[] = [shot()]): DirectorProject => ({schemaVersion: 1, sessionId: 'session-a', revision: 2, planRevision: 1, title: '影片', settings, shots});
const version = {id: 'version-a', path: 'director/a.mp4', url: '/api/artifact', createdAt: '2026-10-08T00:00:00Z', duration: 8, fingerprint: 'current'};

describe('director shot identity and timeline', () => {
  it('moves stable shot IDs without changing media bindings or durations', () => {
    const shots = [shot('a'), {...shot('b'), duration: 5}, shot('c')];
    const moved = moveDirectorShot(shots, 'b', 1);
    expect(moved.map((item) => item.id)).toEqual(['a', 'c', 'b']);
    expect(moved[2]).toBe(shots[1]);
    expect(directorTimeline(moved)).toEqual([
      {id: 'a', start: 0, end: 8, duration: 8},
      {id: 'c', start: 8, end: 16, duration: 8},
      {id: 'b', start: 16, end: 21, duration: 5},
    ]);
    expect(shots.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moveDirectorShot(shots, 'a', -1)).toBe(shots);
  });

  it('copies creative inputs but creates a fresh shot without a borrowed video version', () => {
    const original = {...shot(), versions: [version], selectedVersionId: version.id, currentFingerprint: 'current'};
    const copy = duplicateDirectorShot(original, 'copy');
    expect(copy).toMatchObject({id: 'copy', prompt: original.prompt, firstFrame: original.firstFrame, duration: 8, versions: []});
    expect(copy.selectedVersionId).toBeUndefined();
    expect(copy.currentFingerprint).toBeUndefined();
    expect(original.versions).toHaveLength(1);
  });
});

describe('video version validity', () => {
  it('requires an explicit selected version instead of silently picking the newest', () => {
    const item = {...shot(), versions: [version]};
    expect(selectedDirectorVersion(item)).toBeUndefined();
    expect(selectedDirectorVersion({...item, selectedVersionId: version.id})).toBe(version);
  });

  it('does not count a missing video file as ready for merging', () => {
    const item = {...shot(), versions: [version], selectedVersionId: version.id, currentFingerprint: 'current'};
    expect(usableDirectorVersion(item, settings)).toBe(true);
    expect(usableDirectorVersion({...item, versions: [{...version, missing: true}]}, settings)).toBe(false);
  });

  it('marks unsaved render input changes stale while names and ordering remain harmless', () => {
    const item = {...shot(), versions: [version], selectedVersionId: version.id, currentFingerprint: 'current'};
    const signature = directorRenderSignature(item, settings);
    expect(isDirectorVersionStale({...item, title: '新名称'}, settings, signature)).toBe(false);
    expect(isDirectorVersionStale({...item, prompt: '另一段画面'}, settings, signature)).toBe(true);
    expect(isDirectorVersionStale(item, {...settings, aspectRatio: '9:16'}, signature)).toBe(true);
    expect(isDirectorVersionStale({...item, lastFrame: 'uploads/end.png'}, settings, signature)).toBe(true);
    expect(isDirectorVersionStale({...item, currentFingerprint: 'different'}, settings)).toBe(true);
    expect(isDirectorVersionStale({...item, versions: [{...version, stale: true}]}, settings)).toBe(true);
  });

  it('keeps image-ratio videos usable after an unsaved export-ratio change but still invalidates actual render edits', () => {
    const wanVersion = {...version, aspectRatioFromImage: true};
    const item = {...shot(), versions: [wanVersion], selectedVersionId: wanVersion.id, currentFingerprint: 'current'};
    const signature = directorRenderSignature(item, settings);
    const portrait = {...settings, aspectRatio: '9:16'};
    expect(directorRenderSignature(item, portrait)).not.toBe(signature);
    expect(isDirectorVersionStale(item, portrait, signature)).toBe(false);
    expect(usableDirectorVersion(item, portrait, signature)).toBe(true);
    expect(isDirectorVersionStale({...item, prompt: '新的运镜'}, portrait, signature)).toBe(true);
    expect(isDirectorVersionStale(item, {...portrait, resolution: '1080p'}, signature)).toBe(true);
    expect(isDirectorVersionStale({...item, firstFrame: 'uploads/new.png'}, portrait, signature)).toBe(true);
    expect(isDirectorVersionStale({...item, duration: 5}, portrait, signature)).toBe(true);
    expect(isDirectorVersionStale(item, portrait, 'invalid signature')).toBe(true);
  });

  it('uses each version’s generation mode and current fingerprint when legacy and image-ratio results coexist', () => {
    const legacy = {...version, id: 'legacy', fingerprint: 'legacy-before-ratio-change', currentFingerprint: 'legacy-after-ratio-change'};
    const wan = {...version, id: 'wan', fingerprint: 'wan-current', currentFingerprint: 'wan-current', aspectRatioFromImage: true};
    const item = {...shot(), versions: [legacy, wan], selectedVersionId: wan.id, currentFingerprint: 'legacy-after-ratio-change'};
    const signature = directorRenderSignature(item, settings);
    const portrait = {...settings, aspectRatio: '9:16'};
    expect(isDirectorVersionStale(item, portrait, signature, wan)).toBe(false);
    expect(isDirectorVersionStale(item, portrait, signature, legacy)).toBe(true);
    expect(isDirectorVersionStale(item, portrait, signature, {...wan, currentFingerprint: 'wan-other-inputs'})).toBe(true);
    expect(isDirectorVersionStale(item, portrait, signature, {...wan, stale: true})).toBe(true);
    expect(usableDirectorVersion({...item, selectedVersionId: legacy.id}, portrait, signature)).toBe(false);
    expect(isDirectorVersionStale({...item, currentFingerprint: 'wan-current'}, settings, undefined, {...wan, currentFingerprint: undefined})).toBe(false);
  });

  it('still invalidates legacy videos for ratio edits when backend fingerprints have not updated yet', () => {
    const item = {...shot(), versions: [version], selectedVersionId: version.id, currentFingerprint: version.fingerprint};
    const signature = directorRenderSignature(item, settings);
    expect(isDirectorVersionStale(item, {...settings, aspectRatio: '9:16'}, signature)).toBe(true);
    expect(isDirectorVersionStale(item, {...settings, aspectRatio: '9:16'}, signature, {...version, aspectRatioFromImage: false})).toBe(true);
  });
});

describe('async snapshot reconciliation', () => {
  it('adds server render metadata without overwriting newer edits, resurrecting deletions, or changing a local version choice', () => {
    const draft = project([{...shot(), prompt: '未保存的新画面', selectedVersionId: 'old-choice'}, shot('local-new')]);
    const server = {...project([{...shot(), versions: [version], selectedVersionId: version.id, currentFingerprint: 'current'}, shot('deleted')]), revision: 3};
    const merged = mergeDirectorMetadata(draft, server);
    expect(merged.revision).toBe(3);
    expect(merged.shots.map((item) => item.id)).toEqual(['a', 'local-new']);
    expect(merged.shots[0]).toMatchObject({prompt: '未保存的新画面', selectedVersionId: 'old-choice', versions: [version], currentFingerprint: 'current'});
    expect(draft.revision).toBe(2);
  });

  it('rejects stale revisions and responses from another project', () => {
    const draft = project();
    expect(mergeDirectorMetadata(draft, {...project(), revision: 1})).toBe(draft);
    expect(mergeDirectorMetadata(draft, {...project(), sessionId: 'session-b', revision: 5})).toBe(draft);
  });

  it('keeps the old revision on a dirty draft when another window edits the plan', () => {
    const draft = project([{...shot(), prompt: '本地未保存描述'}]);
    const server = {...project([{...shot(), prompt: '其他窗口的描述'}]), revision: 3, planRevision: 2};
    expect(mergeDirectorMetadata(draft, server)).toBe(draft);
    expect(draft.revision).toBe(2);
    expect(draft.shots[0].prompt).toBe('本地未保存描述');
  });

  it('accepts metadata revisions without rebasing a changed plan, and accepts only its own save acknowledgement', () => {
    const submitted = project();
    const newerDraft = {...submitted, shots: [{...shot(), prompt: '保存期间输入的新描述'}]};
    const ownAck = {...submitted, revision: 3, planRevision: 2};
    const merged = mergeDirectorMetadata(newerDraft, ownAck, submitted);
    expect(merged).toMatchObject({revision: 3, planRevision: 2});
    expect(merged.shots[0].prompt).toBe('保存期间输入的新描述');
    expect(mergeDirectorMetadata(newerDraft, {...ownAck, revision: 4, planRevision: 3}, submitted)).toBe(newerDraft);
    expect(mergeDirectorMetadata(newerDraft, ownAck)).toBe(newerDraft);
  });
});

describe('provider constraints and job state', () => {
  it('uses the supported provider default for new shots without changing existing shot durations', () => {
    const existing = shot();
    const capabilities = {durations: Array.from({length: 14}, (_, index) => index + 2), defaultDuration: 5};
    expect(defaultDirectorDuration(capabilities)).toBe(5);
    expect(createDirectorShot(1, defaultDirectorDuration(capabilities), 'new').duration).toBe(5);
    expect(existing.duration).toBe(8);
    expect(defaultDirectorDuration({...capabilities, defaultDuration: 20})).toBe(8);
    expect(defaultDirectorDuration({...capabilities, defaultDuration: NaN})).toBe(8);
    expect(defaultDirectorDuration({defaultDuration: 5, minDuration: 6, maxDuration: 10})).toBe(8);
  });

  it('requires a first frame for image-to-video and rejects an old last-frame binding instead of silently dropping it', () => {
    const capabilities = {promptOnly: false, supportsFirstFrame: true, supportsLastFrame: false, durations: [5, 8]};
    expect(validateDirectorShot({...shot(), firstFrame: ''}, capabilities)).toContain('请先选择或上传首帧');
    expect(validateDirectorShot(shot(), capabilities)).toBeUndefined();
    expect(validateDirectorShot({...shot(), lastFrame: 'uploads/old-end.png'}, capabilities)).toContain('不支持尾帧');
    expect(validateDirectorShot({...shot(), firstFrame: ''}, {promptOnly: true})).toBeUndefined();
  });

  it('prefers an eight-second shot when supported and otherwise respects provider limits', () => {
    expect(defaultDirectorDuration({durations: [4, 6, 8]})).toBe(8);
    expect(defaultDirectorDuration({durations: [5, 10]})).toBe(5);
    expect(defaultDirectorDuration({maxDuration: 6})).toBe(6);
    expect(defaultDirectorDuration({minDuration: 10})).toBe(10);
  });
  it('validates dynamic durations and optional frame capabilities before spending video credits', () => {
    expect(validateDirectorShot(shot(), {durations: [5, 10]})).toContain('5、10');
    expect(validateDirectorShot({...shot(), duration: 5}, {durations: [5, 10]})).toBeUndefined();
    expect(validateDirectorShot(shot(), {supportsFirstFrame: false})).toContain('不支持首帧');
    expect(validateDirectorShot({...shot(), lastFrame: 'end.png'}, {supportsLastFrame: false})).toContain('不支持尾帧');
    expect(validateDirectorShot({...shot(), duration: NaN}, {})).toContain('时长');
    expect(validateDirectorShot({...shot(), prompt: ' '}, {})).toContain('画面描述');
  });

  it('polls only pending or running jobs, never automatically reruns failures', () => {
    const job = {status: 'queued'} as DirectorJob;
    expect(isDirectorJobActive(job)).toBe(true);
    expect(isDirectorJobActive({...job, status: 'running'})).toBe(true);
    for (const status of ['completed', 'failed', 'cancelled'] as const) expect(isDirectorJobActive({...job, status})).toBe(false);
  });
});
