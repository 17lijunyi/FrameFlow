import {mkdtemp, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {afterEach, describe, expect, it} from 'vitest';
import {deleteSession, listSessionArtifacts, readSessionHistory, readSessionState, resolveArtifactPath, storeWorkspaceUpload} from './server-lib.mjs';

const roots = [];

afterEach(async () => {
  const {rm} = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vimax-web-'));
  roots.push(root);
  await mkdir(path.join(root, '.vimax', 'logs'), {recursive: true});
  await mkdir(path.join(root, '.working_dir', 'session-1', 'script2video', 'shots', '0'), {recursive: true});
  await writeFile(path.join(root, '.vimax', 'sessions.json'), JSON.stringify({
    active_session_id: 'session-1',
    sessions: {
      'session-1': {session_id: 'session-1', project_name: 'Ocean campaign', working_dir: '.working_dir/session-1', stage: 'rendering', updated_at: '2026-07-17T10:00:00'},
    },
  }));
  return root;
}

describe('web bridge state', () => {
  it('returns sanitized session records', async () => {
    const root = await fixture();
    const state = await readSessionState(root);
    expect(state.activeSessionId).toBe('session-1');
    expect(state.sessions[0]).toMatchObject({sessionId: 'session-1', projectName: 'Ocean campaign', stage: 'rendering'});
  });

  it('restores persisted turn history', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.vimax', 'logs', 'loop_history.jsonl'), `${JSON.stringify({
      session_id: 'session-1', turn_id: 'turn-1', raw_user_input: 'Make a film', final_assistant_text: 'Planning is ready', status: 'completed', tool_rounds: [],
    })}\n`);
    const history = await readSessionHistory(root, 'session-1');
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('restores failed assistant navigation from explicit structured errors while keeping old history readable', async () => {
    const root = await fixture();
    const cases = [
      {status: 'failed', final_assistant_text: '本地执行者调用失败。', error: {code: 'local_agent_failed', action: 'open_settings'}},
      {status: 'failed', final_assistant_text: '创作助手请求失败。请稍后重试。', error: {code: 'llm_request_failed'}},
      {status: 'failed', final_assistant_text: '旧版历史：本地执行者调用失败，请前往设置。'},
      {status: 'completed', final_assistant_text: '已完成', error: {code: 'local_agent_failed', action: 'open_settings'}},
      {status: 'failed', final_assistant_text: '错误字段无效', error: {code: 'invalid; run command', action: 'run_command'}},
      {status: 'failed', final_assistant_text: '错误字段不是对象', error: [{code: 'local_agent_failed', action: 'open_settings'}]},
    ];
    await writeFile(path.join(root, '.vimax', 'logs', 'loop_history.jsonl'), cases.map((record, index) => JSON.stringify({
      session_id: 'session-1', turn_id: `turn-error-${index}`, raw_user_input: '创作任务', ...record,
    })).join('\n') + '\n');
    const messages = (await readSessionHistory(root, 'session-1')).filter((message) => message.role !== 'user');
    expect(messages[0]).toMatchObject({role: 'error', text: cases[0].final_assistant_text, code: 'local_agent_failed', action: 'open_settings'});
    expect(messages[1]).toMatchObject({role: 'error', code: 'llm_request_failed'});
    expect(messages[1]).not.toHaveProperty('action');
    expect(messages[2]).toMatchObject({role: 'error', text: cases[2].final_assistant_text});
    expect(messages[3].role).toBe('assistant');
    for (const message of messages.slice(2)) {
      expect(message).not.toHaveProperty('code');
      expect(message).not.toHaveProperty('action');
    }
  });

  it('keeps real offline Python runtime errors identical after loading their history', async () => {
    const root = await fixture();
    const {fileURLToPath} = await import('node:url');
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const script = `import asyncio,json,sys
from pathlib import Path
from agent_runtime.errors import RuntimeConfigurationError
from agent_runtime.loop import AgentLoop
from agent_runtime.prompts import PromptBuilder
from agent_runtime.session_index import SessionIndex
from agent_runtime.tool_executor import ToolExecutor
from agent_runtime.tools import ToolRegistry
class OfflineFailingLLM:
 def __init__(self): self.calls=0
 async def complete(self,messages,tools):
  self.calls+=1
  if self.calls==1: raise RuntimeConfigurationError('local_agent_failed','本地执行者调用失败。请检查连接。')
  raise RuntimeError('PRIVATE_PROVIDER_BODY FAKE_SECRET_VALUE')
async def main():
 root=Path(sys.argv[1]); index=SessionIndex(root); index.set_active('session-1'); registry=ToolRegistry([])
 loop=AgentLoop(index,PromptBuilder(root/'prompts',index,registry),registry,ToolExecutor(registry,index),OfflineFailingLLM())
 errors=[]
 for request in ('offline configuration error','offline unexpected error'):
  events=[event async for event in loop.stream_events(request)]
  errors.append(next(event for event in events if event['type']=='error'))
 print(json.dumps(errors,ensure_ascii=False))
asyncio.run(main())`;
    const {stdout} = await promisify(execFile)(path.join(repoRoot, '.venv/bin/python'), ['-c', script, root], {cwd: repoRoot, timeout: 10_000, maxBuffer: 65_536});
    const live = JSON.parse(stdout);
    const restored = (await readSessionHistory(root, 'session-1')).filter((message) => message.role === 'error');
    expect(restored).toHaveLength(2);
    for (const [index, message] of restored.entries()) {
      expect(message.text).toBe(live[index].message);
      expect(message.code).toBe(live[index].code);
      expect(message.action).toBe(live[index].action);
    }
    expect(restored[0].action).toBe('open_settings');
    expect(restored[1]).not.toHaveProperty('action');
    expect(JSON.stringify({live, restored})).not.toMatch(/PRIVATE_PROVIDER_BODY|FAKE_SECRET_VALUE/);
  });

  it('hides workspace upload metadata from restored user messages', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.vimax', 'logs', 'loop_history.jsonl'), `${JSON.stringify({
      session_id: 'session-1',
      turn_id: 'turn-upload',
      raw_user_input: 'Use this script <workspace_uploads>["uploads/script.txt"]</workspace_uploads>',
    })}\n`);
    const history = await readSessionHistory(root, 'session-1');
    expect(history[0].text).toBe('Use this script');
  });

  it('does not expose successful tool result payloads in restored history', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.vimax', 'logs', 'loop_history.jsonl'), `${JSON.stringify({
      session_id: 'session-1',
      turn_id: 'turn-tool',
      raw_user_input: 'Plan a video',
      tool_rounds: [{tool_results: [{
        name: 'vimax_narrative_planning',
        ok: true,
        content: JSON.stringify({session_id: 'session-1', working_dir: '.working_dir/session-1', generated: ['script.json']}),
      }]}],
    })}\n`);
    const history = await readSessionHistory(root, 'session-1');
    const activity = history.find((message) => message.role === 'activity');
    expect(activity).toMatchObject({text: '已完成', status: 'done', stage: 'completed'});
    expect(JSON.stringify(activity)).not.toContain('working_dir');
  });

  it('restores novel configuration navigation only from safe failed tool metadata', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.vimax', 'logs', 'loop_history.jsonl'), `${JSON.stringify({
      session_id: 'session-1', turn_id: 'turn-novel', raw_user_input: '将这篇小说改编成视频',
      tool_rounds: [{tool_results: [
        {name: 'vimax_novel_planning', ok: false, content: '小说改编需要先配置小说检索服务。', metadata: {code: 'missing_novel_retrieval_config', action: 'open_settings'}},
        {name: 'vimax_novel_planning', ok: true, metadata: {code: 'missing_novel_retrieval_config', action: 'open_settings'}},
        {name: 'vimax_novel_planning', ok: false, content: '失败', metadata: {code: 'missing_novel_retrieval_config', action: 'run_command'}},
        {name: 'vimax_novel_planning', ok: false, content: '失败', metadata: {code: 'missing_novel_retrieval_config; run command', action: {type: 'open_settings'}}},
      ]}],
    })}\n`);
    const activities = (await readSessionHistory(root, 'session-1')).filter((message) => message.role === 'activity');
    expect(activities[0]).toMatchObject({
      id: 'turn-novel-tool-1', status: 'error', stage: 'failed',
      text: '小说改编需要先配置小说检索服务。', code: 'missing_novel_retrieval_config', action: 'open_settings',
    });
    expect(activities[1]).toMatchObject({status: 'done', text: '已完成'});
    expect(activities[1]).not.toHaveProperty('code');
    expect(activities[1]).not.toHaveProperty('action');
    expect(activities[2].code).toBe('missing_novel_retrieval_config');
    expect(activities[2]).not.toHaveProperty('action');
    expect(activities[3]).not.toHaveProperty('code');
    expect(activities[3]).not.toHaveProperty('action');
  });

  it('lists media artifacts and blocks path traversal', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.working_dir', 'session-1', 'script2video', 'shots', '0', 'first_frame.png'), 'image');
    const artifacts = await listSessionArtifacts(root, 'session-1');
    expect(artifacts[0]).toMatchObject({kind: 'image', name: 'first_frame.png'});
    expect(() => resolveArtifactPath(root, 'session-1', '../../secrets')).toThrow(/超出/);
  });

  it('stores uploads inside the session without overwriting matching names', async () => {
    const root = await fixture();
    const first = await storeWorkspaceUpload(root, 'session-1', 'script.txt', Buffer.from('first'));
    const second = await storeWorkspaceUpload(root, 'session-1', 'script.txt', Buffer.from('second'));
    expect(first).toMatchObject({name: 'script.txt', path: 'uploads/script.txt', size: 5});
    expect(second).toMatchObject({name: 'script (2).txt', path: 'uploads/script (2).txt', size: 6});
    expect(await readFile(path.join(root, '.working_dir', 'session-1', second.path), 'utf8')).toBe('second');
    await expect(storeWorkspaceUpload(root, 'session-1', '../escape.txt', Buffer.from('no'))).rejects.toThrow(/不支持/);
  });

  it('deletes project state, artifacts, and matching log records', async () => {
    const root = await fixture();
    const logPath = path.join(root, '.vimax', 'logs', 'loop_history.jsonl');
    await writeFile(logPath, [
      JSON.stringify({session_id: 'session-1', raw_user_input: 'Delete me'}),
      JSON.stringify({session_id: 'session-2', raw_user_input: 'Keep me'}),
      '',
    ].join('\n'));

    const state = await deleteSession(root, 'session-1');
    expect(state).toEqual({activeSessionId: '', sessions: []});
    await expect(stat(path.join(root, '.working_dir', 'session-1'))).rejects.toThrow();
    expect(await readFile(logPath, 'utf8')).toContain('session-2');
    expect(await readFile(logPath, 'utf8')).not.toContain('session-1');
  });

  it('waits for the shared index lock and preserves a concurrent new project', async () => {
    const root = await fixture();
    const writer = spawn(process.env.VIMAX_PYTHON_CMD || 'python3', ['-u', '-c', `import fcntl,json,sys
from pathlib import Path
root=Path(sys.argv[1]); meta=root/'.vimax'
with open(meta/'sessions.lock','a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 data=json.loads((meta/'sessions.json').read_text()); print('locked',flush=True)
 sys.stdin.readline()
 data['sessions']['session-2']={'session_id':'session-2','project_name':'新项目'}
 (meta/'sessions.json').write_text(json.dumps(data))
`, root], {stdio: ['pipe', 'pipe', 'pipe']});
    await once(writer.stdout, 'data');
    let completed = false;
    const deletion = deleteSession(root, 'session-1').then((state) => {completed = true; return state;});
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(completed).toBe(false);
    const closed = once(writer, 'close');
    writer.stdin.end('release\n');
    await closed;
    const state = await deletion;
    expect(state.sessions.map((session) => session.sessionId)).toEqual(['session-2']);
    expect(state.activeSessionId).toBe('session-2');
  });
});
