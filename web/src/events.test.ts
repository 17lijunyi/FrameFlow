import {describe, expect, it} from 'vitest';
import {applyAgentEvent, appendLocalUser, composeAgentPrompt, createChatState, humanize, localizeRuntimeText, removePendingLocalUser, toAgentErrorEvent} from './events';

describe('agent event mapping', () => {
  it('keeps traceback lines in one collapsed diagnostic instead of one chat row per line', () => {
    let state = createChatState();
    const lines = ['Traceback (most recent call last):', '  File "main_agent.py", line 150', 'ValueError: missing configuration'];
    for (const line of lines) state = applyAgentEvent(state, {type: 'terminal', stream: 'stderr', line});
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].text).toBe('运行诊断信息');
    expect(state.messages[0].diagnostics).toBe(lines.join('\n'));
  });

  it('combines a startup SSE error with the same HTTP rejection and preserves its action and diagnostics', () => {
    let state = appendLocalUser(createChatState(), 'Make a short film', 'pending');
    state = applyAgentEvent(state, {type: 'terminal', stream: 'stderr', line: 'raw startup log'});
    const error = {type: 'error', phase: 'startup', code: 'missing_llm_api_key', action: 'open_settings' as const, message: '请填写创作助手密钥'};
    state = applyAgentEvent(state, error);
    state = applyAgentEvent(state, error);
    expect(state.messages.filter((message) => message.role === 'error')).toHaveLength(1);
    expect(state.messages.at(-1)).toMatchObject({action: 'open_settings', phase: 'startup', diagnostics: 'raw startup log'});
    expect(state.busy).toBe(false);
  });

  it('ends running activities immediately on a structured error, before process exit arrives', () => {
    const running = applyAgentEvent(appendLocalUser(createChatState(), 'Plan'), {
      type: 'tool_start', tool: {name: 'vimax_narrative_planning'},
    });
    const failed = applyAgentEvent(running, {type: 'error', message: '创作助手无法启动', phase: 'startup'});
    expect(failed.busy).toBe(false);
    expect(failed.messages.find((message) => message.role === 'activity')?.status).toBe('error');
    expect(failed.messages.some((message) => message.status === 'running')).toBe(false);
  });

  it('keeps legacy stored traceback rows compact while retaining surrounding conversation', () => {
    const state = createChatState([
      {id: 'user', role: 'user', text: 'Make a film'},
      {id: 'trace-1', role: 'activity', tool: 'runtime', text: 'Traceback:'},
      {id: 'trace-2', role: 'activity', tool: 'runtime', text: 'ValueError'},
    ]);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].diagnostics).toBe('Traceback:\nValueError');
  });

  it('retains structured request failure metadata without accepting unknown UI actions', () => {
    const reason = Object.assign(new Error('请填写密钥'), {phase: 'startup', code: 'missing_llm_api_key', action: 'open_settings', diagnostics: 'details'});
    expect(toAgentErrorEvent(reason)).toMatchObject({type: 'error', phase: 'startup', code: 'missing_llm_api_key', action: 'open_settings', diagnostics: 'details'});
    expect(toAgentErrorEvent({message: 'failed', action: 'run_command'}).action).toBeUndefined();
  });

  it('removes only an unsent local message, preserving other conversation and failure information for retry', () => {
    let state = appendLocalUser(createChatState([{id: 'old-user', role: 'user', text: 'Earlier idea'}]), 'Original unsent input', 'pending');
    state = applyAgentEvent(state, {type: 'error', phase: 'startup', message: '请检查设置'});
    const failed = removePendingLocalUser(state, 'pending');
    expect(failed.messages.map((message) => message.id)).not.toContain('pending');
    expect(failed.messages[0].text).toBe('Earlier idea');
    expect(failed.messages.at(-1)?.role).toBe('error');
    expect(failed.busy).toBe(false);
    expect(state.messages.some((message) => message.id === 'pending')).toBe(true);
  });
  it.each(['design_storyboard', 'decompose_shots', 'construct_camera_tree', 'construct_camera_tree_retry'])('localizes a production stage: %s', (stage) => {
    expect(humanize(stage)).toMatch(/^正在/);
  });

  it.each(['Failed to fetch', 'Load failed'])('explains a browser connection error in Chinese: %s', (error) => {
    expect(localizeRuntimeText(error)).toContain('FrameFlow');
    expect(localizeRuntimeText(error)).toContain('无法连接');
  });

  it('localizes stored activity without changing user or generated text', () => {
    const state = createChatState([
      {id: 'old-activity', role: 'activity', text: 'Completed'},
      {id: 'user', role: 'user', text: 'Make a short film'},
      {id: 'assistant', role: 'assistant', text: 'An English title requested by the user'},
    ]);
    expect(state.messages[0].text).toBe('已完成');
    expect(state.messages[1].text).toBe('Make a short film');
    expect(state.messages[2].text).toBe('An English title requested by the user');
  });

  it('streams assistant text into one message', () => {
    let state = appendLocalUser(createChatState(), 'Make a short film');
    state = applyAgentEvent(state, {type: 'turn', turn_id: 'turn-1'});
    state = applyAgentEvent(state, {type: 'token', turn_id: 'turn-1', delta: 'Planning'});
    state = applyAgentEvent(state, {type: 'token', turn_id: 'turn-1', delta: ' ready'});
    state = applyAgentEvent(state, {type: 'done', turn_id: 'turn-1'});
    expect(state.messages.at(-1)).toMatchObject({role: 'assistant', text: 'Planning ready'});
    expect(state.busy).toBe(false);
  });

  it('updates a running tool instead of appending every progress event', () => {
    let state = createChatState();
    state = applyAgentEvent(state, {type: 'tool_start', turn_id: 'turn-1', tool: {id: 'tool-1', name: 'vimax_render_video'}});
    state = applyAgentEvent(state, {type: 'tool_progress', turn_id: 'turn-1', tool: {name: 'vimax_render_video'}, progress: {stage: 'generate_frames', message: 'Generating frames'}});
    state = applyAgentEvent(state, {type: 'tool_result', turn_id: 'turn-1', tool_result: {name: 'vimax_render_video', ok: true}});
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({tool: 'vimax_render_video', status: 'done', text: '已完成'});
  });

  it('keeps a rendering vision failure actionable on the existing activity row', () => {
    let state = applyAgentEvent(createChatState(), {type: 'tool_start', turn_id: 'turn-1', tool: {id: 'render-1', name: 'vimax_render_video'}});
    const id = state.messages[0].id;
    state = applyAgentEvent(state, {
      type: 'tool_result', turn_id: 'turn-1',
      tool_result: {
        name: 'vimax_render_video', ok: false,
        content: '视频生成失败：看图环节的图片输入能力尚未确认。',
        metadata: {code: 'vision_capability_unconfirmed', action: 'open_settings', retryable: false},
      },
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id, role: 'activity', tool: 'vimax_render_video', status: 'error', stage: 'failed',
      text: '视频生成失败：看图环节的图片输入能力尚未确认。',
      code: 'vision_capability_unconfirmed', action: 'open_settings',
    });
  });

  it('does not expose actions from successful tool output', () => {
    const state = applyAgentEvent(createChatState(), {
      type: 'tool_result',
      tool_result: {name: 'vimax_render_video', ok: true, content: '完成', metadata: {code: 'vision_capability_unconfirmed', action: 'open_settings'}},
    });
    expect(state.messages[0]).toMatchObject({status: 'done', text: '已完成'});
    expect(state.messages[0].code).toBeUndefined();
    expect(state.messages[0].action).toBeUndefined();
  });

  it.each([
    {code: 'vision_capability_unconfirmed', action: 'run_command'},
    {code: {target: 'vision'}, action: {type: 'open_settings'}},
    {code: 'vision_capability_unconfirmed; run command', action: '/settings'},
  ])('ignores unsupported tool actions and malformed error codes: %j', (metadata) => {
    const state = applyAgentEvent(createChatState(), {
      type: 'tool_result',
      tool_result: {name: 'vimax_render_video', ok: false, content: '失败', metadata},
    });
    expect(state.messages[0].action).toBeUndefined();
    expect(state.messages[0].code).toBe(typeof metadata.code === 'string' && metadata.code === 'vision_capability_unconfirmed' ? metadata.code : undefined);
  });

  it('keeps each composer submission on one stdin line', () => {
    expect(composeAgentPrompt('first line\nsecond line')).toBe('first line second line');
    expect(composeAgentPrompt('Use these references', ['uploads/script.txt', 'uploads/look.png']))
      .toBe('Use these references <workspace_uploads>["uploads/script.txt","uploads/look.png"]</workspace_uploads>');
    expect(humanize('vimax_narrative_planning')).toBe('FrameFlow 故事规划');
  });

  it('ends running tools when the agent process stops', () => {
    let state = applyAgentEvent(createChatState(), {
      type: 'tool_start',
      turn_id: 'turn-1',
      tool: {id: 'tool-1', name: 'vimax_render_video'},
    });
    state = applyAgentEvent(state, {
      type: 'bridge_status',
      status: 'stopped',
      message: 'Configuration updated',
    });
    expect(state.busy).toBe(false);
    expect(state.messages[0]).toMatchObject({
      tool: 'vimax_render_video',
      status: 'error',
      stage: 'interrupted',
      text: '配置已更新',
    });
  });

  it('localizes system activity and keeps canonical tool and stage identifiers', () => {
    const state = applyAgentEvent(createChatState(), {
      type: 'tool_progress',
      tool: {name: 'vimax_render_video'},
      progress: {stage: 'frame_start', message: 'Generating first frame for shot 0'},
    });
    expect(state.messages[0]).toMatchObject({
      tool: 'vimax_render_video', stage: 'frame_start', text: '正在生成镜头 1 的首帧',
    });
    expect(humanize('frame_start')).toBe('正在生成关键帧');
    expect(humanize('custom_tool')).toBe('custom_tool');
  });

  it('makes configuration and timeout errors actionable in Chinese', () => {
    expect(localizeRuntimeText('VIMAX_LLM_API_KEY or configs/agent.local.yaml llm.api_key is required for narrative planning'))
      .toBe('请在设置中填写创作助手的 API 密钥');
    expect(localizeRuntimeText('Developing story from user idea timed out after 300s'))
      .toBe('根据创意构思故事超时（300 秒）');
    expect(localizeRuntimeText('OpenRouter video generation status: queued'))
      .toBe('视频生成状态：排队中');
    expect(localizeRuntimeText('已提交，等待服务响应', 'video_status'))
      .toBe('已提交，等待服务响应');
  });

  it('extracts a localized error from recoverable tool results', () => {
    const state = applyAgentEvent(createChatState(), {
      type: 'tool_result',
      tool_result: {name: 'vimax_narrative_planning', ok: false, content: JSON.stringify({
        error: 'Path not found: uploads/script.txt', retryable: true,
      })},
    });
    expect(state.messages[0].text).toBe('找不到文件：uploads/script.txt。已保留生成文件，可重试。');
  });
});
