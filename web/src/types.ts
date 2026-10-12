export type SessionSummary = {
  sessionId: string;
  projectName: string;
  workingDir: string;
  stage: string;
  summary: string;
  idea: string;
  updatedAt: string;
  createdAt: string;
  compactionTurns: number;
};

export type ConfigSection = {
  model_provider?: string;
  api_provider?: string;
  model: string;
  base_url: string;
  api_key: string;
  has_api_key: boolean;
};

export type AgentConfig = {
  novel_retrieval?: {mode: 'assistant' | 'api'};
  sections: Record<'llm' | 'image' | 'video' | 'embedding' | 'reranker', ConfigSection>;
};

export type LocalAgentId = 'codex' | 'claude' | 'gemini' | 'pi' | 'hermes' | 'opencode' | 'openclaw'
  | 'cagent' | 'qwen' | 'copilot' | 'cursor' | 'amp' | 'goose' | 'aider' | 'droid' | 'kilo'
  | 'codebuddy' | 'dsh' | 'lorca' | 'aioncore';

export type LocalAgent = {
  id: LocalAgentId;
  name: string;
  installed: boolean;
  executablePath: string;
  version: string;
  authStatus: 'logged_in' | 'logged_out' | 'unknown';
  interfaceStatus: 'available' | 'unavailable' | 'unknown';
  statusMessage: string;
  capabilities: {headless: boolean; structuredOutput: boolean};
  connectionSupport?: 'supported' | 'discovery_only';
  installations?: Array<{path: string; version: string}>;
  lastTest?: {status: 'passed' | 'failed'; checkedAt: string; message: string};
};

export type LocalAgentApplication = {
  id: string;
  name: string;
  path: string;
  version: string;
  bundleId: string;
  kind: 'desktop' | 'ide' | 'assistant';
  statusMessage: string;
};

export type CustomLocalAgent = {
  id: string;
  name: string;
  path: string;
  source: string;
  kind: 'definition' | 'profile';
  statusMessage: string;
};

export type LocalAgentsSnapshot = {
  checkedAt: string;
  agents: LocalAgent[];
  applications?: LocalAgentApplication[];
  customAgents?: CustomLocalAgent[];
  scanLocations?: string[];
  scanWarnings?: string[];
};

export type Artifact = {
  path: string;
  name: string;
  kind: 'image' | 'video' | 'document';
  size: number;
  updatedAt: string;
  url: string;
};

export type WorkspaceUpload = {
  name: string;
  path: string;
  size: number;
};

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue};

export type MessageAction = 'open_settings';

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'activity' | 'error';
  text: string;
  createdAt?: string;
  tool?: string;
  status?: 'running' | 'done' | 'error';
  stage?: string;
  action?: MessageAction;
  phase?: string;
  code?: string;
  diagnostics?: string;
};

export type AgentEvent = {
  type?: string;
  turn_id?: string;
  delta?: string;
  message?: string;
  phase?: string;
  code?: string;
  action?: MessageAction;
  diagnostics?: string;
  status?: string;
  stream?: string;
  line?: string;
  assistant?: string;
  activeSessionId?: string;
  sessions?: SessionSummary[];
  tool?: {id?: string; name?: string; requested_name?: string};
  progress?: {stage?: string; message?: string; metadata?: Record<string, unknown>};
  tool_result?: {name?: string; ok?: boolean; content?: string; metadata?: Record<string, unknown>};
  session?: {
    active_session_id?: string;
    session?: {
      session_id?: string;
      working_dir?: string;
      stage?: string;
      summary?: string;
    } | null;
  };
  prompt_trace?: {
    total_estimated_tokens?: number;
    totals?: {total_tokens?: number; total_estimated_tokens?: number};
  };
};

export type ChatState = {
  messages: Message[];
  busy: boolean;
  turnId: string;
  promptTokens: number;
};
