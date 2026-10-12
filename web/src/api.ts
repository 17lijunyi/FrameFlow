import type {AgentConfig, AgentEvent, Artifact, ConfigSection, JsonValue, LocalAgent, LocalAgentId, LocalAgentsSnapshot, Message, SessionSummary, WorkspaceUpload} from './types';
import {localizeRuntimeText} from './events';

export async function getSessions() {
  return request<{activeSessionId: string; sessions: SessionSummary[]}>('/api/sessions');
}

export async function createProject(projectName: string) {
  return request<{activeSessionId: string; sessions: SessionSummary[]}>('/api/sessions', {method: 'POST', body: JSON.stringify({projectName})});
}

export async function deleteSession(sessionId: string) {
  return request<{activeSessionId: string; sessions: SessionSummary[]}>(`/api/sessions?session=${encodeURIComponent(sessionId)}`, {method: 'DELETE'});
}

export async function getAgentConfig() {
  return request<AgentConfig>('/api/config');
}

export type AgentConfigSaveInput = {novel_retrieval?: AgentConfig['novel_retrieval']; sections?: Partial<Record<keyof AgentConfig['sections'], Omit<ConfigSection, 'has_api_key'> & {has_api_key?: boolean}>>};

export async function saveAgentConfig(config: AgentConfigSaveInput) {
  return request<AgentConfig>('/api/config', {method: 'PUT', body: JSON.stringify(config)});
}

export async function getLocalAgents() {
  return request<LocalAgentsSnapshot>('/api/local-agents');
}

export async function scanLocalAgents(options: {agentId?: LocalAgentId; executablePath?: string} = {}) {
  return request<LocalAgentsSnapshot>('/api/local-agents/scan', {method: 'POST', body: JSON.stringify(options)});
}

export async function checkLocalAgent(agentId: LocalAgentId) {
  return request<{agent: LocalAgent}>('/api/local-agents/check', {method: 'POST', body: JSON.stringify({agentId})});
}

export async function testLocalAgentConnection(agentId: LocalAgentId) {
  return request<{agent: LocalAgent}>('/api/local-agents/test', {method: 'POST', body: JSON.stringify({agentId})});
}

export async function getHistory(sessionId: string) {
  return request<{messages: Message[]}>(`/api/history?session=${encodeURIComponent(sessionId)}`);
}

export async function getArtifacts(sessionId: string) {
  return request<{artifacts: Artifact[]}>(`/api/artifacts?session=${encodeURIComponent(sessionId)}`);
}

export async function uploadWorkspaceFile(sessionId: string, file: File) {
  const url = `/api/uploads?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': file.type || 'application/octet-stream'},
    body: file,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(localizeRuntimeText(payload.error || `上传失败（HTTP ${response.status}）`));
  return payload as {file: WorkspaceUpload};
}

export async function getJsonArtifact(artifact: Artifact): Promise<JsonValue> {
  const separator = artifact.url.includes('?') ? '&' : '?';
  const response = await fetch(`${artifact.url}${separator}updated=${encodeURIComponent(artifact.updatedAt)}`, {
    cache: 'no-store',
    headers: {Accept: 'application/json'},
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `请求失败（HTTP ${response.status}）`;
    throw new Error(localizeRuntimeText(message));
  }
  return payload as JsonValue;
}

export async function startAgent(options: {sessionId?: string; newSession?: boolean; projectName?: string}) {
  return request<{ok: boolean}>('/api/agent/start', {method: 'POST', body: JSON.stringify(options)});
}

export async function sendMessage(text: string) {
  return request<{ok: boolean}>('/api/messages', {method: 'POST', body: JSON.stringify({text})});
}

export async function stopAgent() {
  return request<{ok: boolean}>('/api/agent/stop', {method: 'POST', body: '{}'});
}

export function subscribeToEvents(onEvent: (event: AgentEvent) => void, onConnection: (connected: boolean) => void) {
  const source = new EventSource('/api/events');
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as AgentEvent);
    } catch {
      onEvent({type: 'error', message: '本地服务返回了无法识别的事件，请重启应用。'});
    }
  };
  return () => source.close();
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {'Content-Type': 'application/json', ...(init.headers || {})},
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(localizeRuntimeText(payload.error || `请求失败（HTTP ${response.status}）`));
    Object.assign(error, {phase: payload.phase, code: payload.code, action: payload.action, diagnostics: payload.diagnostics});
    throw error;
  }
  return payload as T;
}
