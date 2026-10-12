import type {ExecutorOption} from './executors';
import {localizeRuntimeText} from './events';

export type VideoEditorSource = {id: string; name: string; path: string; url: string; duration: number; description: string; width: number; height: number; hasAudio: boolean; fingerprint: string; missing?: boolean; stale?: boolean};
export type VideoEditorSegment = {sourceId: string; start: number; end: number};
export type VideoEditorProject = {
  schemaVersion: 1; sessionId: string; revision: number; agentId: string; instruction: string;
  sources: VideoEditorSource[]; segments: VideoEditorSegment[]; planStale?: boolean;
  settings: {aspectRatio: string; resolution: string};
  output?: {path: string; url: string; duration: number; createdAt: string; stale?: boolean; missing?: boolean};
};
export type VideoEditorJob = {id: string; sessionId: string; operation: 'plan' | 'render'; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; message: string; progress?: number; error?: {code: string; message: string}; createdAt: string; updatedAt: string};
export type VideoEditorSnapshot = {project: VideoEditorProject; jobs: VideoEditorJob[]; agents: ExecutorOption[]; job?: VideoEditorJob};
export type VideoEditorFailure = Error & {code?: string};

async function request(sessionId: string, path = '', body?: unknown): Promise<VideoEditorSnapshot> {
  let response: Response;
  try {
    response = await fetch(`/api/director/editor${path}?session=${encodeURIComponent(sessionId)}`, {
      method: body === undefined ? 'GET' : path ? 'POST' : 'PUT',
      headers: {'Content-Type': 'application/json'}, cache: 'no-store',
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  } catch { throw new Error('暂时无法连接本地剪辑服务，你的草稿已保留。'); }
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(localizeRuntimeText(payload.error?.message || payload.error || payload.message || `请求失败（HTTP ${response.status}）`)), {code: payload.code || payload.error?.code});
  return payload as VideoEditorSnapshot;
}
export const getVideoEditor = (sessionId: string) => request(sessionId);
export const saveVideoEditor = (project: VideoEditorProject) => request(project.sessionId, '', {project});
export const importVideoEditorSources = (sessionId: string, revision: number, paths: string[]) => request(sessionId, '/sources', {revision, paths});
export const planVideoEditor = (sessionId: string, revision: number) => request(sessionId, '/plan', {revision});
export const renderVideoEditor = (sessionId: string, revision: number) => request(sessionId, '/render', {revision});
export const cancelVideoEditorJob = (sessionId: string, jobId: string) => request(sessionId, '/cancel', {jobId});
export const isVideoEditorJobActive = (job: VideoEditorJob) => job.status === 'queued' || job.status === 'running';
export const videoEditorDuration = (segments: VideoEditorSegment[]) => segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);

export function validateVideoEditorPlan(project: VideoEditorProject): string {
  if (project.planStale) return '素材或剪辑要求已改变，请重新生成剪辑方案。';
  if (!project.segments.length) return '请先生成剪辑方案。';
  if (project.segments.length > 100) return '一次最多剪辑 100 个片段。';
  const sources = new Map(project.sources.map((source) => [source.id, source]));
  for (const segment of project.segments) {
    const source = sources.get(segment.sourceId);
    if (!source || source.missing || source.stale || !Number.isFinite(source.duration) || source.duration <= 0) return '方案中的素材已丢失或改变，请重新导入并生成方案。';
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end > source.duration || segment.end - segment.start < .04) return `「${source.name}」的片段时间需在 0–${Number(source.duration.toFixed(2))} 秒内，结束时间应晚于开始时间。`;
  }
  if (videoEditorDuration(project.segments) > 1800) return '成片总时长不能超过 30 分钟，请减少片段。';
  return '';
}

const draftKey = (sessionId: string) => `frameflow.video-editor.draft.${sessionId}`;
export function readVideoEditorDraft(sessionId: string): VideoEditorProject | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(sessionId)) || 'null');
    if (value?.schemaVersion !== 1 || value.sessionId !== sessionId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.sources) || value.sources.length > 20 || !Array.isArray(value.segments) || value.segments.length > 100 || typeof value.agentId !== 'string' || typeof value.instruction !== 'string' || !value.settings) return;
    if (!['16:9', '9:16', '1:1'].includes(value.settings.aspectRatio) || !['720p', '1080p'].includes(value.settings.resolution)
      || value.sources.some((source: VideoEditorSource) => !source || ['id', 'name', 'path', 'url', 'description', 'fingerprint'].some((key) => typeof source[key as keyof VideoEditorSource] !== 'string') || !Number.isFinite(source.duration) || source.duration <= 0)
      || value.segments.some((segment: VideoEditorSegment) => !segment || typeof segment.sourceId !== 'string' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end))
      || (value.output && (typeof value.output.url !== 'string' || typeof value.output.path !== 'string' || !Number.isFinite(value.output.duration) || value.output.duration <= 0))) return;
    return value as VideoEditorProject;
  } catch { return undefined; }
}
export function persistVideoEditorDraft(project: VideoEditorProject): boolean {
  try { localStorage.setItem(draftKey(project.sessionId), JSON.stringify(project)); return true; } catch { return false; }
}
export function clearVideoEditorDraft(sessionId: string) {
  try { localStorage.removeItem(draftKey(sessionId)); } catch { /* Server saves remain authoritative. */ }
}

export function refreshVideoEditorSourceMetadata(draft: VideoEditorProject, server: VideoEditorProject): VideoEditorProject {
  const byId = new Map(server.sources.map((source) => [source.id, source]));
  const changed = draft.sources.some((source) => !byId.has(source.id) || byId.get(source.id)?.fingerprint !== source.fingerprint || byId.get(source.id)?.missing || byId.get(source.id)?.stale);
  return {...draft, revision: server.revision, sources: draft.sources.map((source) => ({...(byId.get(source.id) || {...source, missing: true}), description: source.description})), output: server.output, planStale: draft.planStale || server.planStale || changed};
}
