import type {LocalAgent, LocalAgentId, LocalAgentsSnapshot} from './types';

const LOCAL_AGENT_COMMANDS: Record<LocalAgentId, {name: string; command: string}> = {
  codex: {name: 'Codex CLI', command: 'codex'},
  claude: {name: 'Claude Code', command: 'claude'},
  gemini: {name: 'Gemini CLI', command: 'gemini'},
  pi: {name: 'Pi', command: 'pi'},
  hermes: {name: 'Hermes', command: 'hermes'},
  opencode: {name: 'OpenCode', command: 'opencode'},
  openclaw: {name: 'OpenClaw', command: 'openclaw'},
  cagent: {name: 'Docker Agent', command: 'docker-agent'},
  qwen: {name: 'Qwen Code', command: 'qwen'},
  copilot: {name: 'GitHub Copilot CLI', command: 'copilot'},
  cursor: {name: 'Cursor Agent', command: 'cursor-agent'},
  amp: {name: 'Amp', command: 'amp'},
  goose: {name: 'Goose', command: 'goose'},
  aider: {name: 'Aider', command: 'aider'},
  droid: {name: 'Droid', command: 'droid'},
  kilo: {name: 'Kilo', command: 'kilo'},
  codebuddy: {name: 'CodeBuddy', command: 'codebuddy'},
  dsh: {name: 'DSH', command: 'dsh'},
  lorca: {name: 'Lorca', command: 'lorca'},
  aioncore: {name: 'Aioncore', command: 'aioncore'},
};
export const LOCAL_AGENT_OPTIONS = Object.entries(LOCAL_AGENT_COMMANDS).map(([id, entry]) => ({id: id as LocalAgentId, ...entry}));

export function localAgentCommand(id: LocalAgentId): string {
  return LOCAL_AGENT_COMMANDS[id].command;
}

export function localAgentSupportsConnection(agent: LocalAgent): boolean {
  return agent.connectionSupport !== 'discovery_only' && ['codex', 'claude', 'gemini'].includes(agent.id);
}

export function groupLocalAgents(agents: LocalAgent[]) {
  return {installed: agents.filter((agent) => agent.installed), missing: agents.filter((agent) => !agent.installed)};
}

export function additionalLocalAgentInstallations(agent: LocalAgent): Array<{path: string; version: string}> {
  const seen = new Set([agent.executablePath.trim()]);
  return (agent.installations || []).filter((installation) => {
    const path = installation.path.trim();
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

export const LOCAL_AGENT_AUTH_LABELS: Record<LocalAgent['authStatus'], string> = {
  logged_in: '已登录', logged_out: '未登录', unknown: '未确认',
};

export const LOCAL_AGENT_INTERFACE_LABELS: Record<LocalAgent['interfaceStatus'], string> = {
  available: '接口已识别', unavailable: '不支持', unknown: '未检查',
};

export function mergeLocalAgentResult(snapshot: LocalAgentsSnapshot, agent: LocalAgent): LocalAgentsSnapshot {
  const exists = snapshot.agents.some((current) => current.id === agent.id);
  return {
    ...snapshot,
    agents: exists
      ? snapshot.agents.map((current) => current.id === agent.id ? agent : current)
      : [...snapshot.agents, agent],
  };
}

export function validateLocalAgentPath(value: string): string {
  const path = value.trim();
  if (!path) return '请输入已安装 Agent 的绝对路径';
  if (!path.startsWith('/')) return '请使用以 / 开头的绝对路径';
  if (/[\0\r\n]/.test(path)) return '安装路径不能包含换行或空字符';
  return '';
}

/** Installation and interface discovery never count as a successful model connection. */
export function localAgentTestAvailability(agent: LocalAgent): {enabled: boolean; reason: string} {
  if (!agent.installed) return {enabled: false, reason: '请先安装该 Agent，再重新检测'};
  if (!localAgentSupportsConnection(agent)) return {enabled: false, reason: '已发现安装，当前尚未适配连接测试'};
  if (agent.authStatus === 'logged_out') return {enabled: false, reason: '请先在该 Agent 中登录，再重新检测'};
  if (agent.interfaceStatus === 'unknown') return {enabled: false, reason: '请先检查接口'};
  if (agent.interfaceStatus === 'unavailable' || !agent.capabilities.headless) {
    return {enabled: false, reason: '当前版本不支持简短任务测试'};
  }
  return {enabled: true, reason: '运行简短任务，并消耗该 Agent 的额度'};
}

export function formatLocalAgentTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}
