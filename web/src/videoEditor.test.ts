import {afterEach, describe, expect, it, vi} from 'vitest';
import {readVideoEditorDraft, refreshVideoEditorSourceMetadata, validateVideoEditorPlan} from './videoEditor';
import type {VideoEditorProject} from './videoEditor';

const project = (): VideoEditorProject => ({schemaVersion: 1, sessionId: 'editor-one', revision: 1, agentId: 'cli:codex', instruction: '先第二段，再第一段', settings: {aspectRatio: '16:9', resolution: '720p'},
  sources: [{id: 'a', name: '第一段.mp4', path: 'uploads/a.mp4', url: '/api/artifact', duration: 10, width: 640, height: 360, hasAudio: false, fingerprint: 'original', description: '我的描述'}],
  segments: [{sourceId: 'a', start: 2, end: 6}], planStale: false});
afterEach(() => vi.unstubAllGlobals());

describe('confirmed video editing plan', () => {
  it('permits adjusted segment timing but rejects invalid or unavailable source ranges', () => {
    const value = project();
    expect(validateVideoEditorPlan(value)).toBe('');
    for (const range of [{start: -1, end: 3}, {start: 0, end: 11}, {start: 3, end: 3}, {start: NaN, end: 3}]) {
      expect(validateVideoEditorPlan({...value, segments: [{sourceId: 'a', ...range}]})).not.toBe('');
    }
    expect(validateVideoEditorPlan({...value, sources: [{...value.sources[0], missing: true}]})).not.toBe('');
    expect(validateVideoEditorPlan({...value, sources: [{...value.sources[0], duration: NaN}]})).not.toBe('');
    expect(validateVideoEditorPlan({...value, planStale: true})).not.toBe('');
  });
  it('keeps the output duration within 30 minutes even when the source is longer', () => {
    const value = project();
    value.sources[0].duration = 3600;
    value.segments = [{sourceId: 'a', start: 0, end: 1801}];
    expect(validateVideoEditorPlan(value)).toContain('30 分钟');
  });
});

describe('video editing draft recovery', () => {
  it('retains the user description but invalidates the plan if original media changed', () => {
    const draft = project();
    const server = {...project(), revision: 2, sources: [{...draft.sources[0], fingerprint: 'changed', description: '已保存描述'}]};
    const restored = refreshVideoEditorSourceMetadata(draft, server);
    expect(restored.sources[0].description).toBe('我的描述');
    expect(restored.sources[0].fingerprint).toBe('changed');
    expect(restored.planStale).toBe(true);
    expect(restored.revision).toBe(2);
    expect(draft.sources[0].fingerprint).toBe('original');
  });
  it('ignores malformed persisted sources and segments instead of crashing on load', () => {
    const draft = project();
    let stored: unknown = draft;
    vi.stubGlobal('localStorage', {getItem: () => JSON.stringify(stored)});
    expect(readVideoEditorDraft(draft.sessionId)).toEqual(draft);
    stored = {...draft, sources: [null]};
    expect(readVideoEditorDraft(draft.sessionId)).toBeUndefined();
    stored = {...draft, segments: [null]};
    expect(readVideoEditorDraft(draft.sessionId)).toBeUndefined();
    stored = {...draft, sessionId: 'other-session'};
    expect(readVideoEditorDraft(draft.sessionId)).toBeUndefined();
  });
});
