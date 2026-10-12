import {localizeRuntimeText} from './events';

export type DirectorSettings = {style: string; aspectRatio: string; resolution: string};
export type DirectorVersion = {id: string; path: string; url: string; createdAt: string; fingerprint: string; duration: number; stale?: boolean; missing?: boolean; aspectRatioFromImage?: boolean; currentFingerprint?: string};
export type DirectorShot = {
  id: string; title: string; prompt: string; duration: number;
  firstFrame: string; lastFrame: string; versions: DirectorVersion[];
  selectedVersionId?: string; currentFingerprint?: string;
};
export type DirectorProject = {
  schemaVersion: 1; sessionId: string; revision: number; planRevision?: number; title: string;
  settings: DirectorSettings; shots: DirectorShot[];
  export?: {path: string; url: string; createdAt?: string; stale?: boolean; missing?: boolean; fingerprint?: string};
};
export type DirectorJob = {
  id: string; sessionId: string; operation: 'render' | 'export'; shotId?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: number; message: string; createdAt: string; updatedAt: string;
  error?: {code: string; message: string; action?: 'open_settings'};
  result?: {path: string; url: string};
};
export type DirectorCapabilities = {
  provider?: string; model?: string; configured?: boolean; videoConfigured?: boolean; supported?: boolean; message?: string;
  supportsFirstFrame?: boolean; supportsLastFrame?: boolean; canExport?: boolean; promptOnly?: boolean;
  durations?: number[]; minDuration?: number; maxDuration?: number; defaultDuration?: number;
  aspectRatioFromImage?: boolean; audio?: boolean;
  aspectRatios?: string[]; resolutions?: string[];
  [key: string]: unknown;
};
export type DirectorSnapshot = {project: DirectorProject; jobs: DirectorJob[]; capabilities: DirectorCapabilities; job?: DirectorJob};
export type DirectorFailure = Error & {code?: string; action?: 'open_settings'};

async function requestDirector(path: string, sessionId: string, init: RequestInit = {}): Promise<DirectorSnapshot> {
  let response: Response;
  try {
    response = await fetch(`/api/director${path}?session=${encodeURIComponent(sessionId)}`, {
      ...init, headers: {'Content-Type': 'application/json', ...init.headers}, cache: 'no-store',
    });
  } catch {
    throw new Error('暂时无法连接本地服务，请稍后重试。你的编辑已保留。');
  }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(localizeRuntimeText(payload.error?.message || payload.error || payload.message || `请求失败（HTTP ${response.status}）`));
    Object.assign(error, {code: payload.code || payload.error?.code, action: payload.action || payload.error?.action});
    throw error;
  }
  return payload as DirectorSnapshot;
}

export const getDirector = (sessionId: string) => requestDirector('', sessionId);
export const saveDirector = (project: DirectorProject) => requestDirector('', project.sessionId, {method: 'PUT', body: JSON.stringify({project})});
export const importDirector = (sessionId: string, revision: number) => requestDirector('/import', sessionId, {method: 'POST', body: JSON.stringify({sessionId, revision, replace: true})});
export const renderDirectorShot = (sessionId: string, shotId: string, revision: number) => requestDirector('/render', sessionId, {method: 'POST', body: JSON.stringify({sessionId, shotId, revision})});
export const cancelDirectorJob = (sessionId: string, jobId: string) => requestDirector('/cancel', sessionId, {method: 'POST', body: JSON.stringify({sessionId, jobId})});
export const exportDirector = (sessionId: string, revision: number) => requestDirector('/export', sessionId, {method: 'POST', body: JSON.stringify({sessionId, revision})});

export function createDirectorShot(index: number, duration = 5, id: string = crypto.randomUUID()): DirectorShot {
  return {id, title: `镜头 ${index + 1}`, prompt: '', duration, firstFrame: '', lastFrame: '', versions: []};
}

export function duplicateDirectorShot(shot: DirectorShot, id: string = crypto.randomUUID()): DirectorShot {
  return {...shot, id, title: `${shot.title || '镜头'} 副本`, versions: [], selectedVersionId: undefined, currentFingerprint: undefined};
}

export function moveDirectorShot(shots: DirectorShot[], shotId: string, direction: -1 | 1): DirectorShot[] {
  const index = shots.findIndex((shot) => shot.id === shotId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= shots.length) return shots;
  const next = [...shots];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function directorTimeline(shots: DirectorShot[]) {
  let cursor = 0;
  return shots.map((shot) => {
    const start = cursor;
    cursor += Number.isFinite(shot.duration) ? Math.max(0, shot.duration) : 0;
    return {id: shot.id, start, end: cursor, duration: cursor - start};
  });
}

// A local edit signature, not the provider's persistent cache fingerprint.
// Titles and ordering do not change the input sent to a single-shot video model.
export function directorRenderSignature(shot: DirectorShot, settings: DirectorSettings): string {
  return JSON.stringify([settings.style, settings.aspectRatio, settings.resolution, shot.prompt, shot.duration, shot.firstFrame || '', shot.lastFrame || '']);
}

export function selectedDirectorVersion(shot: DirectorShot): DirectorVersion | undefined {
  return shot.versions.find((version) => version.id === shot.selectedVersionId);
}

export function usableDirectorVersion(shot: DirectorShot, settings: DirectorSettings, savedSignature?: string): boolean {
  const version = selectedDirectorVersion(shot);
  return !!version && !version.missing && !isDirectorVersionStale(shot, settings, savedSignature, version);
}

export function defaultDirectorDuration(capabilities: DirectorCapabilities): number {
  const preferred = capabilities.defaultDuration;
  if (preferred !== undefined && Number.isFinite(preferred) && preferred > 0
    && (!capabilities.durations?.length || capabilities.durations.includes(preferred))
    && (capabilities.minDuration === undefined || preferred >= capabilities.minDuration)
    && (capabilities.maxDuration === undefined || preferred <= capabilities.maxDuration)) return preferred;
  if (capabilities.durations?.length) return capabilities.durations.includes(8) ? 8 : capabilities.durations[0];
  return Math.max(capabilities.minDuration || 1, Math.min(8, capabilities.maxDuration || 120));
}

export function isDirectorVersionStale(shot: DirectorShot, settings: DirectorSettings, savedSignature?: string, version = selectedDirectorVersion(shot)): boolean {
  if (!version) return false;
  const currentFingerprint = version.currentFingerprint ?? shot.currentFingerprint;
  let expectedSignature = savedSignature;
  if (version.aspectRatioFromImage === true && savedSignature !== undefined) {
    try {
      const savedInputs: unknown = JSON.parse(savedSignature);
      if (Array.isArray(savedInputs) && savedInputs.length === 7) {
        savedInputs[1] = settings.aspectRatio;
        expectedSignature = JSON.stringify(savedInputs);
      }
    } catch { /* Unrecognized signatures remain stale instead of borrowing a cached video. */ }
  }
  return version.stale === true
    || (!!currentFingerprint && version.fingerprint !== currentFingerprint)
    || (expectedSignature !== undefined && directorRenderSignature(shot, settings) !== expectedSignature);
}

export function isDirectorJobActive(job: DirectorJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

// Polling/save acknowledgements may add versions while the user keeps editing.
// Preserve all local editing fields and removed shots; adopt only server metadata.
export function directorPlanRevision(project: DirectorProject): number {
  return project.planRevision ?? project.revision;
}

export function canMergeDirectorMetadata(draft: DirectorProject, server: DirectorProject, acknowledgedInput?: DirectorProject): boolean {
  if (draft.sessionId !== server.sessionId || server.revision < draft.revision) return false;
  if (directorPlanRevision(draft) === directorPlanRevision(server)) return true;
  // Only the response to this exact save may advance a locally edited plan.
  // A poll/render/export response never gets this acknowledgement witness.
  return !!acknowledgedInput && acknowledgedInput.sessionId === draft.sessionId
    && directorPlanRevision(acknowledgedInput) === directorPlanRevision(draft)
    && directorPlanRevision(server) === directorPlanRevision(acknowledgedInput) + 1;
}

export function mergeDirectorMetadata(draft: DirectorProject, server: DirectorProject, acknowledgedInput?: DirectorProject): DirectorProject {
  if (draft.sessionId !== server.sessionId || server.revision < draft.revision) return draft;
  if (!canMergeDirectorMetadata(draft, server, acknowledgedInput)) return draft;
  const serverShots = new Map(server.shots.map((shot) => [shot.id, shot]));
  return {...draft, revision: server.revision, planRevision: server.planRevision, export: server.export, shots: draft.shots.map((shot) => {
    const current = serverShots.get(shot.id);
    if (!current) return shot;
    return {...shot, versions: current.versions, currentFingerprint: current.currentFingerprint};
  })};
}

export function validateDirectorShot(shot: DirectorShot, capabilities: DirectorCapabilities): string | undefined {
  if (!shot.prompt.trim()) return '请先填写这个镜头的画面描述。';
  if (!Number.isFinite(shot.duration) || shot.duration <= 0) return '镜头时长必须大于 0 秒。';
  if (capabilities.durations?.length && !capabilities.durations.includes(shot.duration)) return `当前视频服务支持 ${capabilities.durations.join('、')} 秒，请调整镜头时长。`;
  if (capabilities.minDuration !== undefined && shot.duration < capabilities.minDuration) return `当前视频服务的最短时长为 ${capabilities.minDuration} 秒。`;
  if (capabilities.maxDuration !== undefined && shot.duration > capabilities.maxDuration) return `当前视频服务的最长时长为 ${capabilities.maxDuration} 秒。`;
  if (capabilities.promptOnly === false && !shot.firstFrame) return '当前视频服务需要一张首帧图片，请先选择或上传首帧。';
  if (shot.firstFrame && capabilities.supportsFirstFrame === false) return '当前视频服务不支持首帧素材，请移除首帧或更换服务。';
  if (shot.lastFrame && capabilities.supportsLastFrame === false) return '当前视频服务不支持尾帧素材，请移除尾帧或更换服务。';
  return undefined;
}

const draftKey = (sessionId: string) => `frameflow.director.draft.${sessionId}`;
export function readDirectorDraft(sessionId: string): DirectorProject | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(sessionId)) || 'null');
    if (value?.schemaVersion !== 1 || value.sessionId !== sessionId || !Array.isArray(value.shots) || !value.settings || !Number.isInteger(value.revision)) return undefined;
    return value as DirectorProject;
  } catch { return undefined; }
}
export function persistDirectorDraft(project: DirectorProject): boolean {
  try { localStorage.setItem(draftKey(project.sessionId), JSON.stringify(project)); return true; } catch { return false; }
}
export function clearDirectorDraft(sessionId: string) {
  try { localStorage.removeItem(draftKey(sessionId)); } catch { /* The service save remains authoritative. */ }
}
