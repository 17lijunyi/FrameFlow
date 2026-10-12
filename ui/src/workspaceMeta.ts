export type WorkspaceMeta = {
  workspacePath: string;
  sessionId: string;
  stage: string;
  compactionUsed: number;
  compactionTarget: number;
};

export function displayStage(stage: string): string {
  const labels: Record<string, string> = {
    created: '已创建',
    narrative_planning: '正在规划文本',
    narrative_planned: '文本规划完成',
    novel_planning: '正在改编小说',
    novel_planned: '小说改编完成',
    rendering: '正在生成视频',
    rendered: '视频生成完成',
    error: '出错',
    failed: '失败',
    completed: '已完成',
    running: '运行中',
    starting: '正在启动',
    revising: '正在修改',
    initializing_llm: '正在初始化模型',
    chat_model_ready: '模型已就绪',
    idea_pipeline_ready: '创意工作流已就绪',
    script_pipeline_ready: '剧本工作流已就绪',
    planning_failed: '规划失败',
    render_failed: '视频生成失败',
    compact: '正在压缩上下文',
    sampling_assistant: '正在思考',
    executing_tools: '正在运行工具',
  };
  return labels[stage] ?? '处理中';
}

export function compactTargetFromEnv(env: Record<string, string | undefined>): number {
  const contextWindow = parsePositiveInt(env.VIMAX_CONTEXT_WINDOW_TOKENS, 200000);
  const ratio = parsePositiveFloat(env.VIMAX_AUTO_COMPACT_RATIO, 0.9);
  const threshold = parsePositiveInt(env.VIMAX_AUTO_COMPACT_TOKEN_THRESHOLD, Math.round(contextWindow * Math.min(1, Math.max(0, ratio))));
  const buffer = parsePositiveInt(env.VIMAX_AUTO_COMPACT_BUFFER_TOKENS, 20000);
  return Math.max(0, threshold - buffer);
}

export function compactionBar(used: number, target: number, width = 18): string {
  const safeWidth = Math.max(4, width);
  if (target <= 0) return '░'.repeat(safeWidth);
  const ratio = Math.min(1, Math.max(0, used / target));
  const filled = Math.round(ratio * safeWidth);
  return '█'.repeat(filled) + '░'.repeat(safeWidth - filled);
}

export function compactionLabel(used: number, target: number): string {
  if (target <= 0) return '上下文压缩已关闭';
  const safeUsed = Math.max(0, Math.round(used));
  const percent = Math.min(999, Math.max(0, Math.round((safeUsed / target) * 100)));
  return `上下文 [${compactionBar(safeUsed, target)}] ${safeUsed}/${target} (${percent}%)`;
}

export function resolveWorkspacePath(_repoRoot: string, workingDir?: string): string {
  const normalized = String(workingDir ?? '').trim();
  if (!normalized) return '.working_dir';
  const relative = normalized.replace(/^.*\/\.working_dir\//, '.working_dir/').replace(/^\.\//, '');
  if (relative.startsWith('.working_dir/')) return relative;
  if (relative === '.working_dir') return relative;
  return `.working_dir/${relative.replace(/^\/+/, '')}`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
