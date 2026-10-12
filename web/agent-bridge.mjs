import {spawn} from 'node:child_process';

const STARTUP_CODES = new Set(['missing_llm_api_key', 'invalid_config', 'invalid_session', 'runtime_startup_failed',
  'invalid_executor_settings', 'executor_unavailable', 'executor_adapter_unavailable', 'executor_runtime_unavailable']);
const DIAGNOSTIC_LIMIT = 12_000;
const STDOUT_BUFFER_LIMIT = 2 * 1024 * 1024;

/** A child is usable only after the runtime explicitly emits a JSONL ready event. */
export function createAgentBridge({repoRoot, resolveCommand, readSessions, broadcast, startupTimeoutMs = 30_000,
  spawnProcess = spawn, terminateProcess = terminateAgentProcess}) {
  let current = null;
  let activeSessionId = '';
  let status = {type: 'bridge_status', status: 'idle', message: '创作助手待命中'};
  const children = new Set();

  function setStatus(next) {
    status = {type: 'bridge_status', ...next};
    broadcast(status);
  }

  function isCurrent(context) { return current === context && !context.finished; }

  function cleanup(context) {
    clearTimeout(context.startupTimer);
    clearTimeout(context.killTimer);
    context.killTimer = null;
    children.delete(context);
  }

  function terminate(context) {
    if (context.closed || context.terminating) return;
    context.terminating = true;
    // Release the idle Python stdin loop, then allow its worker/CLI cleanup to finish.
    try { context.child.stdin?.end(); } catch { /* Pipe already closed. */ }
    try { terminateProcess(context.child, 'SIGTERM'); } catch { /* Child already stopped. */ }
    context.killTimer = setTimeout(() => {
      context.killTimer = null;
      if (context.closed) return;
      try { terminateProcess(context.child, 'SIGKILL'); } catch { /* Child already stopped. */ }
    }, 3_000);
    context.killTimer.unref?.();
  }

  function flushStartupDiagnostic(context) {
    if (!context.stderr.trim()) return;
    broadcast({type: 'terminal', stream: 'stderr', line: context.stderr});
    context.stderr = '';
  }

  function fail(context, error) {
    if (!isCurrent(context)) return;
    error.phase = context.ready ? 'runtime' : 'startup';
    context.finished = true;
    current = null;
    clearTimeout(context.startupTimer);
    flushStartupDiagnostic(context);
    setStatus({status: 'error', phase: error.phase, message: error.message, code: error.code, ...(error.action ? {action: error.action} : {})});
    broadcast({type: 'error', phase: error.phase, code: error.code,
      message: error.message, ...(error.action ? {action: error.action} : {})});
    if (!context.ready) context.reject(error);
    terminate(context);
  }

  function refreshSessions(context) {
    if (!readSessions) return;
    Promise.resolve().then(() => readSessions()).then((state) => {
      if (!isCurrent(context)) return;
      activeSessionId = state.activeSessionId || activeSessionId;
      broadcast({type: 'sessions_changed', ...state, activeSessionId});
    }).catch(() => {
      // Session metadata failure must not manufacture runtime readiness.
    });
  }

  function consumeLine(context, line) {
    if (!isCurrent(context) || !line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      broadcast({type: 'terminal', stream: 'stdout', line: boundedDiagnostic(line)});
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'ready') {
      if (context.ready || context.exited || context.closed) return;
      context.ready = true;
      context.stderr = '';
      clearTimeout(context.startupTimer);
      setStatus({status: 'ready', message: '创作助手已就绪'});
      refreshSessions(context);
      context.resolve({ok: true});
      return;
    }
    if (event.type === 'error' && event.phase === 'startup' && !context.ready) {
      const code = STARTUP_CODES.has(event.code) ? event.code : 'runtime_startup_failed';
      const message = typeof event.message === 'string' && event.message.trim()
        ? boundedDiagnostic(event.message) : '创作助手启动失败，请检查配置';
      fail(context, bridgeError(message, code, code === 'runtime_startup_failed' ? 500 : 422,
        event.action === 'open_settings' ? 'open_settings' : undefined));
      return;
    }
    if (event.type === 'session') {
      activeSessionId = event.session?.active_session_id || activeSessionId;
      refreshSessions(context);
    }
    broadcast(event);
  }

  function stop(reason = 'user') {
    const context = current;
    if (context) {
      current = null;
      context.finished = true;
      clearTimeout(context.startupTimer);
      if (!context.ready) context.reject(Object.assign(bridgeError('创作助手启动已取消，请重新启动', 'agent_start_cancelled', 409), {phase: 'startup'}));
      terminate(context);
    }
    const message = reason === 'switch' ? '正在切换工作区'
      : reason === 'config' ? '配置已更新' : reason === 'shutdown' ? '创作助手已停止' : '生成已停止';
    setStatus({status: 'stopped', message});
  }

  async function start({newSession = false, sessionId = '', projectName = ''} = {}) {
    if (newSession && sessionId) throw bridgeError('请选择新建项目或打开已有项目', 'invalid_session_request', 400);
    stop('switch');
    activeSessionId = sessionId;
    setStatus({status: 'starting', message: newSession ? '正在创建工作区' : '正在打开工作区'});
    let child;
    try {
      const {command, args = []} = resolveCommand();
      const sessionArgs = newSession
        ? ['--new-session', ...(projectName ? ['--new-session-name', projectName] : [])]
        : sessionId ? ['--session', sessionId] : [];
      child = spawnProcess(command, [...args, 'main_agent.py', '--jsonl', '--stdin-repl', ...sessionArgs], {
        cwd: repoRoot, env: {...process.env, FRAMEFLOW_NODE_PATH: process.execPath}, shell: false,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      const error = Object.assign(bridgeError('无法启动创作助手，请检查本地 Python 环境', 'agent_spawn_failed', 500), {phase: 'startup'});
      setStatus({status: 'error', phase: error.phase, message: error.message, code: error.code});
      throw error;
    }
    let resolve;
    let reject;
    const readyPromise = new Promise((success, failure) => { resolve = success; reject = failure; });
    readyPromise.catch(() => {});
    const context = {child, resolve, reject, ready: false, finished: false, exited: false, closed: false,
      terminating: false, stdout: '', stderr: ''};
    current = context;
    children.add(context);
    context.startupTimer = setTimeout(() => {
      fail(context, bridgeError('创作助手启动超时，请检查本地环境后重试', 'agent_start_timeout', 504));
    }, startupTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!isCurrent(context)) return;
      context.stdout += String(chunk);
      const lines = context.stdout.split(/\r?\n/);
      context.stdout = lines.pop() || '';
      for (const line of lines) consumeLine(context, line);
      if (context.stdout.length > STDOUT_BUFFER_LIMIT) {
        fail(context, bridgeError('创作助手输出格式异常，请重新启动', 'agent_protocol_error', 502));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (!isCurrent(context)) return;
      if (context.ready) broadcast({type: 'terminal', stream: 'stderr', line: boundedDiagnostic(String(chunk))});
      else context.stderr = boundedDiagnostic(context.stderr + String(chunk));
    });
    child.stdin.on('error', () => {
      fail(context, bridgeError('创作助手连接已断开，请重新启动', 'agent_connection_lost', 502));
    });
    child.on('error', () => {
      fail(context, bridgeError('无法启动创作助手，请检查本地 Python 环境', 'agent_spawn_failed', 500));
    });
    child.on('exit', () => {
      // The child may exit before its last stdout/stderr data is delivered.
      // Refuse writes now, but let close finish draining the JSONL protocol.
      context.exited = true;
    });
    child.on('close', (code, signal) => {
      context.closed = true;
      cleanup(context);
      if (isCurrent(context) && context.stdout.trim()) {
        const lastLine = context.stdout;
        context.stdout = '';
        consumeLine(context, lastLine);
      }
      if (!isCurrent(context)) return;
      if (!context.ready) {
        fail(context, bridgeError('创作助手未能完成启动，请检查配置和本地环境', 'runtime_startup_failed', 500));
      } else {
        context.finished = true;
        current = null;
        const stopped = code === 0 || signal === 'SIGTERM';
        setStatus({status: stopped ? 'stopped' : 'error',
          message: stopped ? '创作助手已停止' : '创作助手意外退出，请重新启动',
          ...(!stopped ? {code: 'agent_runtime_exited'} : {})});
      }
    });
    return readyPromise;
  }

  return {
    start, stop,
    sendMessage(text) {
      if (!current?.ready || current.exited || !current.child.stdin.writable || status.status !== 'ready') {
        throw Object.assign(bridgeError(status.status === 'starting' ? '创作助手正在启动，请稍后再发送'
          : status.status === 'error' ? status.message : '创作助手尚未启动',
        status.code || 'agent_not_ready', 409, status.action), {phase: status.phase || 'runtime'});
      }
      current.child.stdin.write(`${text}\n`);
    },
    snapshot() { return {...status}; },
    get activeSessionId() { return activeSessionId; },
    set activeSessionId(value) { activeSessionId = value; },
    get running() { return Boolean(current && !current.exited); },
    dispose() {
      stop('shutdown');
      for (const context of children) terminate(context);
    },
  };
}

function bridgeError(message, code, statusCode, action) {
  return Object.assign(new Error(message), {code, statusCode, ...(action ? {action} : {})});
}

function boundedDiagnostic(text) {
  const safe = text.replace(/\b(?:sk|rk)-[a-zA-Z0-9_-]{12,}\b/g, '[密钥已隐藏]')
    .replace(/(\bauthorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/(\b(?:api[_-]?key|token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]');
  return safe.length > DIAGNOSTIC_LIMIT ? `${safe.slice(-DIAGNOSTIC_LIMIT)}\n[日志已截断]` : safe;
}

function terminateAgentProcess(child, signal) {
  if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
  else child.kill(signal);
}
