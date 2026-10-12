import type {AgentEvent, ChatState, Message} from './types';

export function createChatState(messages: Message[] = []): ChatState {
  const compact: Message[] = [];
  for (const message of messages) {
    if (message.role === 'activity' && message.tool === 'runtime') {
      const previous = compact.at(-1);
      const diagnostics = message.diagnostics || message.text;
      if (previous?.role === 'activity' && previous.tool === 'runtime') {
        compact[compact.length - 1] = {...previous, diagnostics: mergeDiagnostics(previous.diagnostics, diagnostics)};
      } else {
        compact.push({...message, text: '运行诊断信息', diagnostics});
      }
    } else {
      compact.push(message.role === 'activity' || message.role === 'error'
        ? {...message, text: localizeRuntimeText(message.text, message.stage)} : message);
    }
  }
  return {
    messages: compact,
    busy: false, turnId: '', promptTokens: 0,
  };
}

export function appendLocalUser(state: ChatState, text: string, id = `local-user-${Date.now()}`): ChatState {
  return {
    ...state,
    busy: true,
    turnId: '',
    messages: [...state.messages, {id, role: 'user', text}],
  };
}

export function removePendingLocalUser(state: ChatState, id: string): ChatState {
  return {...state, messages: state.messages.filter((message) => message.id !== id || message.role !== 'user')};
}

export function toAgentErrorEvent(reason: unknown): AgentEvent {
  const source = reason && typeof reason === 'object' ? reason as Record<string, unknown> : {};
  const message = typeof source.message === 'string' ? source.message
    : typeof source.error === 'string' ? source.error : typeof reason === 'string' ? reason : '助手发生未知错误';
  return {
    type: 'error', message: localizeRuntimeText(message),
    ...(typeof source.phase === 'string' ? {phase: source.phase} : {}),
    ...(typeof source.code === 'string' ? {code: source.code} : {}),
    ...(source.action === 'open_settings' ? {action: 'open_settings' as const} : {}),
    ...(typeof source.diagnostics === 'string' ? {diagnostics: source.diagnostics} : {}),
  };
}

export function composeAgentPrompt(text: string, workspaceUploads: string[] = []) {
  const message = text.replace(/\s+/g, ' ').trim();
  const paths = workspaceUploads.map((path) => path.trim()).filter(Boolean);
  if (paths.length === 0) return message;
  return `${message} <workspace_uploads>${JSON.stringify(paths)}</workspace_uploads>`;
}

export function applyAgentEvent(state: ChatState, event: AgentEvent): ChatState {
  const turnId = event.turn_id || state.turnId || `turn-${Date.now()}`;
  switch (event.type) {
    case 'turn':
      return {...state, busy: true, turnId};
    case 'prompt_trace': {
      const tokens = event.prompt_trace?.totals?.total_tokens
        ?? event.prompt_trace?.totals?.total_estimated_tokens
        ?? event.prompt_trace?.total_estimated_tokens
        ?? state.promptTokens;
      return {...state, promptTokens: Math.max(0, Math.round(tokens))};
    }
    case 'token':
      return appendAssistantDelta(state, turnId, event.delta || '');
    case 'tool_start': {
      const name = event.tool?.name || event.tool?.requested_name || 'tool';
      return upsertActivity(state, {
        id: activityId(turnId, event.tool?.id, name),
        role: 'activity',
        tool: name,
        status: 'running',
        stage: 'starting',
        text: '正在开始',
      });
    }
    case 'tool_progress': {
      const name = event.tool?.name || event.tool?.requested_name || 'tool';
      return upsertLatestToolActivity(state, name, {
        role: 'activity',
        tool: name,
        status: 'running',
        stage: event.progress?.stage || 'running',
        text: localizeRuntimeText(event.progress?.message || event.progress?.stage || 'running', event.progress?.stage),
      });
    }
    case 'tool_result': {
      const name = event.tool_result?.name || 'tool';
      const ok = event.tool_result?.ok !== false;
      const metadata = event.tool_result?.metadata;
      return upsertLatestToolActivity(state, name, {
        role: 'activity',
        tool: name,
        status: ok ? 'done' : 'error',
        stage: ok ? 'completed' : 'failed',
        text: ok ? '已完成' : cleanError(event.tool_result?.content || '工具执行失败'),
        code: !ok && typeof metadata?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(metadata.code) ? metadata.code : undefined,
        action: !ok && metadata?.action === 'open_settings' ? 'open_settings' : undefined,
      });
    }
    case 'terminal':
      if (event.stream !== 'stderr') return state;
      return appendRuntimeDiagnostic(state, event.line || '运行出错');
    case 'error':
      return appendErrorEvent(state, event, turnId);
    case 'done': {
      const hasAssistant = state.messages.some((message) => message.id === `assistant-${turnId}`);
      const messages = !hasAssistant && event.assistant
        ? [...state.messages, {id: `assistant-${turnId}`, role: 'assistant' as const, text: event.assistant}]
        : state.messages;
      return {...state, messages, busy: false};
    }
    case 'bridge_status':
      if (event.status !== 'error' && event.status !== 'stopped') return state;
      return {
        ...state,
        busy: false,
        messages: state.messages.map((message) => message.role === 'activity' && message.status === 'running'
          ? {...message, status: 'error', stage: 'interrupted', text: localizeRuntimeText(event.message || '生成已停止')}
          : message),
      };
    default:
      return state;
  }
}

function interruptActivities(messages: Message[], text: string): Message[] {
  return messages.map((message) => message.role === 'activity' && message.status === 'running'
    ? {...message, status: 'error', stage: 'interrupted', text} : message);
}

function mergeDiagnostics(previous = '', next = ''): string {
  if (!next || previous === next || previous.endsWith(next)) return previous;
  return [previous, next].filter(Boolean).join('\n');
}

function appendRuntimeDiagnostic(state: ChatState, line: string): ChatState {
  const messages = [...state.messages];
  const latest = messages.at(-1);
  if (latest?.role === 'error' && latest.phase === 'startup') {
    messages[messages.length - 1] = {...latest, diagnostics: mergeDiagnostics(latest.diagnostics, line)};
  } else {
    const id = `runtime-diagnostics-${state.turnId || 'startup'}`;
    const index = messages.findIndex((message) => message.id === id);
    if (index >= 0) messages[index] = {...messages[index], diagnostics: mergeDiagnostics(messages[index].diagnostics, line)};
    else messages.push({id, role: 'activity', tool: 'runtime', status: 'done', text: '运行诊断信息', diagnostics: line});
  }
  return {...state, messages};
}

function appendErrorEvent(state: ChatState, event: AgentEvent, turnId: string): ChatState {
  const text = cleanError(event.message || '助手发生未知错误');
  let diagnostics = event.diagnostics || '';
  const runtimeId = `runtime-diagnostics-${state.turnId || 'startup'}`;
  const messages = interruptActivities(state.messages, text).filter((message) => {
    if (message.id !== runtimeId) return true;
    diagnostics = mergeDiagnostics(message.diagnostics, diagnostics);
    return false;
  });
  let index = -1;
  if (event.phase === 'startup') {
    for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
      const message = messages[candidate];
      if (message.role === 'error' && message.phase === 'startup'
        && (event.code ? message.code === event.code : message.text === text)) { index = candidate; break; }
    }
  }
  const error: Message = {
    id: index >= 0 ? messages[index].id : `error-${turnId}-${Date.now()}-${messages.length}`,
    role: 'error', text, phase: event.phase, code: event.code,
    action: event.action, diagnostics: mergeDiagnostics(index >= 0 ? messages[index].diagnostics : '', diagnostics) || undefined,
  };
  if (index >= 0) messages[index] = error;
  else messages.push(error);
  return {...state, busy: false, messages};
}

function appendAssistantDelta(state: ChatState, turnId: string, delta: string): ChatState {
  if (!delta) return state;
  const id = `assistant-${turnId}`;
  const index = state.messages.findIndex((message) => message.id === id);
  if (index < 0) {
    return {...state, messages: [...state.messages, {id, role: 'assistant', text: delta}]};
  }
  const messages = [...state.messages];
  messages[index] = {...messages[index], text: `${messages[index].text}${delta}`};
  return {...state, messages};
}

function upsertActivity(state: ChatState, message: Message): ChatState {
  const index = state.messages.findIndex((item) => item.id === message.id);
  if (index < 0) return {...state, messages: [...state.messages, message]};
  const messages = [...state.messages];
  messages[index] = {...messages[index], ...message};
  return {...state, messages};
}

function upsertLatestToolActivity(state: ChatState, tool: string, update: Omit<Message, 'id'>): ChatState {
  const messages = [...state.messages];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'activity' && messages[index].tool === tool && messages[index].status === 'running') {
      messages[index] = {...messages[index], ...update};
      return {...state, messages};
    }
  }
  return {...state, messages: [...messages, {id: `activity-${tool}-${Date.now()}`, ...update}]};
}

function activityId(turnId: string, toolId: string | undefined, name: string) {
  return `activity-${turnId}-${toolId || name}-${Date.now()}`;
}

export function humanize(value: string) {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ACTIVITY_LABELS[key] || value.replace(/\bvimax\b/gi, 'FrameFlow');
}

function cleanError(value: string) {
  try {
    const payload = JSON.parse(value);
    if (typeof payload?.error === 'string') {
      const detail = localizeRuntimeText(payload.error);
      return payload.retryable ? `${detail}。已保留生成文件，可重试。` : detail;
    }
  } catch {
    // Runtime errors may be plain text rather than a JSON tool response.
  }
  return localizeRuntimeText(value.replace(/\s+/g, ' ').trim());
}

const ACTIVITY_LABELS: Record<string, string> = {
  vimax: 'FrameFlow',
  frameflow: 'FrameFlow',
  vimax_narrative_planning: 'FrameFlow 故事规划',
  vimax_novel_planning: 'FrameFlow 小说规划',
  vimax_render_video: 'FrameFlow 视频生成',
  tool: '工具',
  workflow: '工作流程',
  runtime: '运行环境',
  read_file: '读取文件',
  write_file: '保存文件',
  read_json: '读取创作方案',
  write_json: '保存创作方案',
  list_files: '查看文件',
  glob_files: '查找文件',
  search_text: '搜索内容',
  view_image: '查看图像',
  memory_read: '读取偏好',
  memory_write: '保存偏好',
  todo_read: '查看待办',
  todo_write: '更新待办',
  sleep: '等待',
  run_shell: '执行命令',
  starting: '正在开始',
  running: '运行中',
  completed: '已完成',
  complete: '已完成',
  done: '已完成',
  failed: '失败',
  error: '出错',
  interrupted: '已中断',
  stopped: '已停止',
  pending: '等待中',
  queued: '排队中',
  processing: '处理中',
  succeeded: '已完成',
  initializing_llm: '正在连接创作模型',
  chat_model_ready: '创作模型已就绪',
  idea_pipeline_ready: '创意工作流程已就绪',
  script_pipeline_ready: '剧本工作流程已就绪',
  develop_story: '正在构思故事',
  extract_characters: '正在整理角色',
  write_script: '正在编写剧本',
  plan_scene: '正在规划场景分镜',
  plan_script: '正在规划剧本分镜',
  design_storyboard: '正在设计分镜',
  decompose_shots: '正在拆分镜头',
  construct_camera_tree: '正在规划机位',
  construct_camera_tree_retry: '正在重新规划机位',
  planning_failed: '规划失败，已保留生成文件',
  revising: '正在修改创作方案',
  rendering: '正在生成视频',
  render_start: '开始生成视频',
  render_failed: '生成失败，已保留生成文件',
  render_done: '视频生成完成',
  generate_frames: '正在生成关键帧',
  load_storyboard: '正在准备分镜',
  storyboard_ready: '分镜已就绪',
  load_shot_descriptions: '正在准备镜头描述',
  shot_descriptions_ready: '镜头描述已就绪',
  load_camera_tree: '正在准备机位方案',
  camera_tree_ready: '机位方案已就绪',
  frames_start: '正在生成关键帧',
  camera_frames_start: '正在生成机位画面',
  camera_frames_done: '机位画面已就绪',
  frame_exists: '关键帧已存在',
  frame_start: '正在生成关键帧',
  frame_done: '关键帧生成完成',
  frame_prompt_exists: '关键帧参考方案已存在',
  frame_prompt_start: '正在选择关键帧参考',
  frame_prompt_done: '关键帧参考已选定',
  transition_video_exists: '转场片段已存在',
  transition_video_start: '正在生成转场片段',
  transition_video_done: '转场片段生成完成',
  new_camera_image_exists: '新机位画面已存在',
  new_camera_image_start: '正在提取新机位画面',
  new_camera_image_done: '新机位画面已提取',
  video_clips_start: '正在生成镜头片段',
  video_clip_exists: '镜头片段已存在',
  video_clip_waiting_for_frames: '正在等待关键帧',
  video_clip_start: '正在生成镜头片段',
  video_clip_done: '镜头片段生成完成',
  final_video_exists: '最终视频已存在',
  concat_start: '正在合成最终视频',
  concat_done: '最终视频已合成',
  image_candidates_start: '正在生成备选图像',
  image_candidate_done: '备选图像已就绪',
  image_candidate_failed: '备选图像生成失败',
  image_selection_start: '正在选择最佳图像',
  image_selection_done: '图像已选定',
  image_generation: '正在生成图像',
  image_completed: '图像生成完成',
  video_create: '正在提交视频生成任务',
  video_task_created: '视频生成任务已提交',
  video_create_error: '视频任务提交失败',
  video_query_error: '视频状态查询失败',
  video_status: '视频生成状态',
  video_download_start: '正在下载视频',
  video_completed: '视频生成完成',
  character_portraits_loaded: '已加载角色形象',
  character_portraits_start: '正在生成角色形象',
  character_portraits_done: '角色形象已就绪',
  character_portraits_exist: '角色形象已存在',
  character_portrait_start: '正在生成角色形象',
  character_portrait_done: '角色形象已就绪',
  character_portrait_front_start: '正在生成角色正面形象',
  character_portrait_front_done: '角色正面形象已生成',
  character_portrait_side_start: '正在生成角色侧面形象',
  character_portrait_side_done: '角色侧面形象已生成',
  character_portrait_back_start: '正在生成角色背面形象',
  character_portrait_back_done: '角色背面形象已生成',
  novel_plan_text_artifacts: '正在规划小说创作方案',
  save_novel: '正在保存并拆分小说',
  compress_novel: '正在整理小说片段',
  extract_events: '正在提取故事事件',
  retrieve_chunks: '正在检索相关片段',
  extract_scenes: '正在提取剧本场景',
  merge_characters: '正在合并角色设定',
  novel_render_load: '正在加载小说创作方案',
  novel_portraits_start: '正在生成小说角色形象',
  novel_portraits_base_done: '小说角色形象已就绪',
  novel_portraits_scene_start: '正在生成场景角色形象',
  novel_portraits_done: '场景角色形象已就绪',
  novel_scene_render_start: '正在生成小说场景视频',
  novel_scene_render_done: '小说场景视频已生成',
  novel_render_completed: '小说场景视频生成完成',
  compact: '整理会话上下文',
  sampling_assistant: '正在思考',
  executing_tools: '正在执行工具',
};

const RUNTIME_MESSAGES: Record<string, string> = {
  'Starting': '正在开始',
  'Completed': '已完成',
  'Tool failed': '工具执行失败',
  'Runtime error': '运行出错',
  'Unknown agent error': '助手发生未知错误',
  'Generation stopped': '生成已停止',
  'Configuration updated': '配置已更新',
  'Session selected': '已切换项目',
  'Agent stopped': '助手已停止',
  'Agent process exited': '助手进程已退出',
  'Agent connected': '创作助手已连接',
  'Agent idle': '创作助手待命中',
  'Agent ready': '创作助手已就绪',
  'Agent is not running': '创作助手尚未启动',
  'Creating workspace': '正在创建工作区',
  'Opening workspace': '正在打开工作区',
  'Project not found': '项目不存在',
  'Artifact not found': '作品文件不存在',
  'Not found': '未找到资源',
  'Project name must be 64 characters or fewer': '项目名称不能超过 64 个字符',
  'Message text is required': '请输入消息内容',
  'VIMAX_LLM_API_KEY is required for the agent LLM client': '请在设置中填写创作助手的 API 密钥',
  'No active session to render.': '请先选择要生成视频的项目',
  'No render mode matched current session.': '当前项目尚未准备好生成视频，请先完成故事规划',
  'novel_text is required for novel planning.': '请先提供小说内容',
  'revision_instruction is required when revision_target is provided.': '请说明需要如何修改创作方案',
  'Provide `idea`, `script`, a revision target, or an active session with an existing idea for narrative planning.': '请提供故事创意或剧本，或选择已有项目继续创作',
  'Compacting context': '正在整理会话上下文',
  'Compacting context before sampling': '正在整理会话上下文',
  'Sampling assistant': '正在思考',
  'Starting shell command': '正在执行命令',
  'Starting narrative planning': '正在开始故事规划',
  'Starting novel planning': '正在开始小说规划',
  'Starting video render': '正在开始生成视频',
  'Narrative planning complete': '故事规划已完成',
  'Novel planning complete': '小说规划已完成',
  'Novel structured text planning complete': '小说创作方案已完成',
  'Narrative planning failed; partial artifacts were kept': '故事规划失败，已保留生成文件',
  'Render failed; partial artifacts were kept': '视频生成失败，已保留生成文件',
  'Generating frames': '正在生成关键帧',
  'Initializing bounded chat model': '正在连接创作模型',
  'Bounded chat model initialized': '创作模型已就绪',
  'Idea pipeline initialized': '创意工作流程已就绪',
  'Script pipeline initialized': '剧本工作流程已就绪',
  'Developing story from user idea': '根据创意构思故事',
  'Extracting characters from story': '从故事中整理角色',
  'Writing scene scripts from story': '根据故事编写场景剧本',
  'Planning storyboard and shots from provided script': '根据剧本规划分镜与镜头',
  'Revising structured text artifact': '正在修改创作方案',
  'Planning novel structured text artifacts': '正在规划小说创作方案',
  'Starting script2video render': '开始根据剧本生成视频',
  'Extracting characters before render': '正在整理视频中的角色',
  'Using provided characters for render': '使用现有角色生成视频',
  'Loaded existing character portraits': '已加载角色形象',
  'Generating character portraits': '正在生成角色形象',
  'Character portraits ready': '角色形象已就绪',
  'Loading or designing storyboard': '正在准备分镜',
  'Storyboard ready': '分镜已就绪',
  'Loading or decomposing shot descriptions': '正在准备镜头描述',
  'Shot descriptions ready': '镜头描述已就绪',
  'Loading or constructing camera tree': '正在准备机位方案',
  'Camera tree ready': '机位方案已就绪',
  'Generating frames for cameras': '正在生成机位关键帧',
  'Generating video clips for shots': '正在生成镜头片段',
  'Final video already exists': '最终视频已存在',
  'Concatenating video clips': '正在合成最终视频',
  'Final video concatenated': '最终视频已合成',
  'Script2video render complete': '视频生成完成',
  'Completed character portrait generation': '角色形象生成完成',
  'All character portraits already exist': '角色形象已存在',
  'Video generation task created': '视频生成任务已提交',
  'OpenRouter video generation task created': 'OpenRouter 视频生成任务已提交',
  'Video query failed': '视频状态查询失败',
  'Video generation completed': '视频生成完成',
  'Downloading OpenRouter video output': '正在下载 OpenRouter 视频',
  'OpenRouter video generation completed and downloaded': 'OpenRouter 视频已生成并下载',
  'OpenRouter image generation completed': 'OpenRouter 图像生成完成',
  'Saving and splitting novel text': '正在保存并拆分小说',
  'Compressing novel chunks': '正在整理小说片段',
  'Extracting events from compressed novel': '正在提取小说事件',
  'Retrieving relevant chunks for events': '正在检索事件相关片段',
  'Extracting screenplay scenes': '正在提取剧本场景',
  'Merging scene characters into novel-level characters': '正在合并小说角色设定',
  'Loading novel structured text artifacts': '正在加载小说创作方案',
  'Generating novel character portraits': '正在生成小说角色形象',
  'Base character portraits ready': '小说角色形象已就绪',
  'Generating scene character portraits': '正在生成场景角色形象',
  'Scene character portraits ready': '场景角色形象已就绪',
  'Rendering novel scene video': '正在生成小说场景视频',
  'Rendered novel scene video': '小说场景视频已生成',
  'Novel scene render complete': '小说场景视频生成完成',
  'Failed to fetch': '无法连接本地服务，请确认 FrameFlow 已启动',
  'Load failed': '无法连接本地服务，请重新打开 FrameFlow',
  'Network Error': '连接失败，请检查网络和服务地址',
  'API key is required': '请先填写 API 密钥',
};

const PORTRAIT_VIEW_LABELS: Record<string, string> = {front: '正面', side: '侧面', back: '背面'};

/** Translates system messages only; generated stories and chat text remain unchanged. */
export function localizeRuntimeText(value: string, stage?: string): string {
  const text = value.trim();
  if (RUNTIME_MESSAGES[text]) return RUNTIME_MESSAGES[text];
  const normalized = text.toLowerCase().replace(/[\s-]+/g, '_');
  if (ACTIVITY_LABELS[normalized]) return ACTIVITY_LABELS[normalized];

  const patterns: Array<[RegExp, (...groups: string[]) => string]> = [
    [/^Running tools \(round (\d+)\)$/i, (round) => `正在执行工具（第 ${round} 轮）`],
    [/^Sleeping for ([\d.]+)s$/i, (seconds) => `等待 ${seconds} 秒`],
    [/^Planning scene (\d+) storyboard and shots$/i, (index) => `正在规划场景 ${Number(index) + 1} 的分镜与镜头`],
    [/^(?:OpenRouter )?Video generation status: (.+)$/i, (status) => `视频生成状态：${humanize(status)}`],
    [/^Creating (?:OpenRouter )?video generation task with (.+)$/i, (model) => `正在使用 ${model} 提交视频生成任务`],
    [/^Generating image with (.+)$/i, (model) => `正在使用 ${model} 生成图像`],
    [/^Generating (first frame|first_frame|last_frame) for shot (\d+)$/i, (frame, index) => `正在生成镜头 ${Number(index) + 1} 的${frame === 'last_frame' ? '尾帧' : '首帧'}`],
    [/^Generated (first frame|first_frame|last_frame) for shot (\d+)$/i, (frame, index) => `镜头 ${Number(index) + 1} 的${frame === 'last_frame' ? '尾帧' : '首帧'}已生成`],
    [/^(first frame|first_frame|last_frame) for shot (\d+) already exists$/i, (frame, index) => `镜头 ${Number(index) + 1} 的${frame.toLowerCase() === 'last_frame' ? '尾帧' : '首帧'}已存在`],
    [/^Generating transition video for shot (\d+)$/i, (index) => `正在生成镜头 ${Number(index) + 1} 的转场片段`],
    [/^Transition video for shot (\d+) (already exists|generated)$/i, (index, state) => `镜头 ${Number(index) + 1} 的转场片段${state.toLowerCase() === 'generated' ? '已生成' : '已存在'}`],
    [/^Extracting new camera image for shot (\d+)$/i, (index) => `正在提取镜头 ${Number(index) + 1} 的新机位画面`],
    [/^New camera image for shot (\d+) (already exists|extracted)$/i, (index, state) => `镜头 ${Number(index) + 1} 的新机位画面${state.toLowerCase() === 'extracted' ? '已提取' : '已存在'}`],
    [/^(?:First frame prompt for shot|Prompt for (?:first_frame|last_frame) of shot) (\d+) already exists$/i, (index) => `镜头 ${Number(index) + 1} 的关键帧参考方案已存在`],
    [/^Selecting references for (?:first frame|first_frame|last_frame) of shot (\d+)$/i, (index) => `正在选择镜头 ${Number(index) + 1} 的关键帧参考`],
    [/^Selected references for (?:first frame|first_frame|last_frame) of shot (\d+)$/i, (index) => `镜头 ${Number(index) + 1} 的关键帧参考已选定`],
    [/^Generating video clip for shot (\d+)$/i, (index) => `正在生成镜头 ${Number(index) + 1} 的视频片段`],
    [/^Generated video clip for shot (\d+)$/i, (index) => `镜头 ${Number(index) + 1} 的视频片段已生成`],
    [/^Video clip for shot (\d+) already exists$/i, (index) => `镜头 ${Number(index) + 1} 的视频片段已存在`],
    [/^Waiting for frames before video clip (\d+)$/i, (index) => `镜头 ${Number(index) + 1} 正在等待关键帧`],
    [/^Generating frames for camera (\d+)$/i, (index) => `正在生成机位 ${Number(index) + 1} 的画面`],
    [/^Frames for camera (\d+) ready$/i, (index) => `机位 ${Number(index) + 1} 的画面已就绪`],
    [/^Image candidate (\d+\/\d+) (ready|failed)$/i, (count, status) => `备选图像 ${count} ${status === 'ready' ? '已就绪' : '生成失败'}`],
    [/^Generating (\d+) image candidates$/i, (count) => `正在生成 ${count} 张备选图像`],
    [/^VLM selecting from (\d+) candidates$/i, (count) => `正在从 ${count} 张备选图像中选择`],
    [/^Selected image candidate (\d+)$/i, (index) => `已选定第 ${index} 张备选图像`],
    [/^Generating (front|side|back) portrait for (.+)$/i, (view, name) => `正在生成 ${name} 的${PORTRAIT_VIEW_LABELS[view.toLowerCase()]}形象`],
    [/^Generated (front|side|back) portrait for (.+)$/i, (view, name) => `${name} 的${PORTRAIT_VIEW_LABELS[view.toLowerCase()]}形象已生成`],
    [/^Generating portraits for (.+)$/i, (name) => `正在生成 ${name} 的角色形象`],
    [/^Portraits for (.+) ready$/i, (name) => `${name} 的角色形象已就绪`],
    [/^Video create attempt (\d+) failed$/i, (attempt) => `第 ${attempt} 次视频任务提交失败`],
    [/^Unknown tool: (.+)$/i, (tool) => `未知工具：${humanize(tool)}`],
    [/^Path not found: (.+)$/i, (path) => `找不到文件：${path}`],
    [/^HTTP (\d+)$/i, (status) => `请求失败（HTTP ${status}）`],
    [/^File exceeds the (.+) upload limit$/i, (limit) => `文件超过 ${limit} 的上传上限`],
    [/^Agent stopped by (.+)$/i, (signal) => `助手已停止（${signal}）`],
    [/^Agent exited with code (.+)$/i, (code) => `助手进程已退出（代码 ${code}）`],
    [/^Agent process error: (.+)$/i, (detail) => `助手进程出错：${localizeRuntimeText(detail)}`],
    [/^Dependency missing: (.+)$/i, (paths) => `生成所需文件尚未就绪：${paths}`],
    [/^Revision target does not exist: (.+)$/i, (path) => `待修改的文件不存在：${path}`],
    [/^Revision output was not valid JSON: (.+)$/i, (detail) => `修改结果格式无效：${detail}`],
    [/^Render failed: (.+)$/i, (detail) => `视频生成失败：${localizeRuntimeText(detail)}`],
    [/^turn failed: (.+)$/i, (detail) => `本次生成失败：${localizeRuntimeText(detail)}`],
    [/^(Narrative|Novel) planning failed: (.+)$/i, (kind, detail) => `${kind.toLowerCase() === 'novel' ? '小说' : '故事'}规划失败：${localizeRuntimeText(detail)}`],
    [/^(.+) timed out after ([\d.]+)s$/i, (action, seconds) => `${localizeRuntimeText(action)}超时（${seconds} 秒）`],
    [/^(.+) failed: (.+)$/i, (action, detail) => `${localizeRuntimeText(action)}失败：${localizeRuntimeText(detail)}`],
  ];
  for (const [pattern, translate] of patterns) {
    const match = text.match(pattern);
    if (match) return translate(...match.slice(1));
  }
  if (/^VIMAX_.*api_key is required for (narrative planning|image generation|video generation)$/i.test(text)) {
    const service = text.endsWith('narrative planning') ? '创作助手' : text.endsWith('image generation') ? '图像生成' : '视频生成';
    return `请在设置中填写${service}的 API 密钥`;
  }
  if (stage && !/[\u3400-\u9fff]/.test(text) && ACTIVITY_LABELS[stage]) return humanize(stage);
  return text.replace(/\bvimax\b/gi, 'FrameFlow');
}
