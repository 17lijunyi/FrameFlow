import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {LOCAL_AGENT_DEFINITIONS as DEFINITIONS, bundledAgentCandidates, staticAgentVersion} from './local-agent-catalog.mjs';
const PROBE_TIMEOUT = 4_000;
const OUTPUT_LIMIT = 96 * 1024;
const TEST_PROMPT = '这是连接测试。不要读取文件、调用工具或执行命令。只回复 FRAMEFLOW_OK。';

/**
 * Discovery never reads credentials or sends a prompt. Only an explicit test()
 * starts an inference request. Persisted settings contain manual paths only.
 * runCommand injection: (absolutePath, args, options) =>
 * {exitCode, stdout, stderr, timedOut?, outputLimitExceeded?, errorCode?}.
 */
export function createLocalAgentManager({repoRoot, env = process.env, homeDir = os.homedir(), runCommand = runLocalCommand, inventoryScanner = defaultInventoryScanner, applicationDirectories, systemDirectories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']}) {
  const settingsPath = path.join(repoRoot, '.vimax', 'local-agents.json');
  const agents = new Map(DEFINITIONS.map((definition) => [definition.id, emptyAgent(definition)]));
  const metadata = new Map();
  let manualPaths = {};
  let loaded = false;
  let initialized = false;
  let checkedAt = null;
  let activeOperation;
  let activeKind;
  let disposed = false;
  const controllers = new Set();
  const queuedChecks = new Map();
  let inventory = {applications: [], customAgents: [], scanLocations: [], scanWarnings: []};
  let checkTail = Promise.resolve();
  let pendingChecks = 0;

  function snapshot() {
    return structuredClone({checkedAt, agents: DEFINITIONS.filter(({id, supported}) => supported || agents.get(id).installed || manualPaths[id]).map(({id}) => agents.get(id)), ...inventory});
  }

  function definitionFor(id) {
    const definition = DEFINITIONS.find((candidate) => candidate.id === id);
    if (!definition) throw requestError('不支持的本地 Agent', 400);
    return definition;
  }

  async function exclusive(operation, kind = 'test') {
    if (disposed) throw requestError('本地 Agent 服务正在关闭', 503);
    if (activeOperation || (kind === 'test' && pendingChecks)) throw requestError('本地 Agent 检测或测试正在进行，请稍后重试', 409);
    const promise = Promise.resolve().then(operation);
    activeOperation = promise;
    activeKind = kind;
    try {
      return await promise;
    } finally {
      activeOperation = undefined;
      activeKind = undefined;
    }
  }

  function scheduleCheck(key, operation) {
    if (disposed) return Promise.reject(requestError('本地 Agent 服务正在关闭', 503));
    if (activeKind === 'test') return Promise.reject(requestError('连接测试正在进行，请稍后重试', 409));
    if (queuedChecks.has(key)) return queuedChecks.get(key);
    pendingChecks += 1;
    const promise = checkTail.then(() => exclusive(operation, 'check'));
    checkTail = promise.catch(() => {});
    queuedChecks.set(key, promise);
    promise.finally(() => { queuedChecks.delete(key); pendingChecks -= 1; }).catch(() => {});
    return promise;
  }

  async function loadManualPaths() {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
      for (const {id} of DEFINITIONS) {
        const value = saved?.manualPaths?.[id];
        if (typeof value === 'string' && path.isAbsolute(value) && value.length <= 4_096 && !value.includes('\0')) {
          manualPaths[id] = value;
        }
      }
    } catch {
      // Missing or damaged path settings do not prevent automatic discovery.
    }
  }

  async function invoke(executablePath, args, binDir, options = {}) {
    if (disposed) return {exitCode: null, stdout: '', stderr: '', errorCode: 'CANCELLED'};
    const commandEnv = {...env, ...options.env,
      PATH: joinedPath([binDir, '/opt/homebrew/bin', '/usr/local/bin', env.PATH, '/usr/bin', '/bin'])};
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const result = await runCommand(executablePath, args, {
        cwd: options.cwd || os.tmpdir(), env: commandEnv,
        timeoutMs: options.timeoutMs || PROBE_TIMEOUT, maxOutputBytes: OUTPUT_LIMIT, signal: controller.signal,
      });
      return {
        ...result,
        stdout: typeof result?.stdout === 'string' ? result.stdout.slice(0, OUTPUT_LIMIT) : '',
        stderr: typeof result?.stderr === 'string' ? result.stderr.slice(0, OUTPUT_LIMIT) : '',
      };
    } catch {
      return {exitCode: null, stdout: '', stderr: '', errorCode: 'SPAWN_FAILED'};
    } finally {
      controllers.delete(controller);
    }
  }

  async function probe(definition, executablePath, binDir) {
    const versionResult = await invoke(executablePath, ['--version'], binDir);
    if (!commandSucceeded(versionResult)) return {failed: probeFailure(versionResult)};
    const versionText = stripControl(versionResult.stdout + '\n' + versionResult.stderr);
    const version = versionText.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0];
    if (!version) return {failed: '候选程序没有返回可识别的版本号'};
    const helpResult = await invoke(executablePath, ['--help'], binDir);
    const help = stripControl(helpResult.stdout + '\n' + helpResult.stderr);
    const identity = definition.id === 'codex' ? /\bcodex(?:[- ]cli)?\b/i
      : definition.id === 'claude' ? /\bclaude(?: code)?\b/i : /\bgemini(?: cli)?\b/i;
    if (!identity.test(versionText) && (!commandSucceeded(helpResult) || !identity.test(help))) {
      return {failed: '候选程序身份与所选 Agent 不匹配'};
    }
    let interfaceHelp = help;
    if (definition.id === 'codex' && commandSucceeded(helpResult)) {
      const result = await invoke(executablePath, ['exec', '--help'], binDir);
      interfaceHelp = commandSucceeded(result) ? stripControl(result.stdout + '\n' + result.stderr) : '';
    }
    const headless = definition.id === 'codex' ? /\bexec\b/i.test(help) && /--json\b/.test(interfaceHelp)
      : /--(?:print|prompt)\b/.test(interfaceHelp);
    const structuredOutput = definition.id === 'codex' ? /--json\b/.test(interfaceHelp)
      : /--output-format\b/.test(interfaceHelp) && /\bjson\b/i.test(interfaceHelp);
    const interfaceStatus = !commandSucceeded(helpResult) ? 'unknown'
      : headless && structuredOutput ? 'available' : 'unavailable';
    let authStatus = 'unknown';
    if (definition.authArgs) {
      const result = await invoke(executablePath, definition.authArgs, binDir);
      if (!result.timedOut && !result.outputLimitExceeded && !result.errorCode) {
        if (definition.id === 'claude') {
          try {
            const auth = JSON.parse(result.stdout);
            if (typeof auth.loggedIn === 'boolean') authStatus = auth.loggedIn ? 'logged_in' : 'logged_out';
          } catch {
            // Older versions do not necessarily support this subcommand.
          }
        } else {
          const text = stripControl(result.stdout + '\n' + result.stderr);
          if (result.exitCode === 0 && /logged in|authenticated/i.test(text)) authStatus = 'logged_in';
          else if (result.exitCode === 1 && /not logged in|not authenticated|no credentials/i.test(text)) authStatus = 'logged_out';
        }
      }
    }
    return {version, authStatus, interfaceStatus, capabilities: {headless, structuredOutput}, interfaceHelp, binDir};
  }

  async function refresh(definition, directories, explicitPath) {
    const previous = agents.get(definition.id);
    let failure;
    const candidates = [
      ...(explicitPath ? [explicitPath] : []),
      ...(manualPaths[definition.id] ? [manualPaths[definition.id]] : []),
      ...directories.flatMap((directory) => [definition.command, ...(definition.aliases || [])].map((command) => path.join(directory, command))),
      ...bundledAgentCandidates(definition, homeDir, applicationDirectories),
    ];
    const seen = new Set();
    const installations = [];
    let primary;
    for (const candidate of candidates) {
      const executablePath = await validatedExecutable(candidate);
      if (!executablePath || seen.has(executablePath)) continue;
      seen.add(executablePath);
      const result = definition.supported
        ? await probe(definition, executablePath, path.dirname(candidate))
        : {version: await staticAgentVersion(definition, executablePath), authStatus: 'unknown', interfaceStatus: 'unknown', capabilities: {headless: false, structuredOutput: false}};
      if (result.failed) {
        failure = result.failed;
        if (candidate === explicitPath) { agents.set(definition.id, {...emptyAgent(definition), statusMessage: failure}); return agents.get(definition.id); }
        continue;
      }
      installations.push({path: executablePath, version: result.version});
      if (!primary) primary = {executablePath, result};
    }
    if (primary) {
      const {executablePath, result} = primary;
      if (definition.supported) metadata.set(definition.id, result);
      else metadata.delete(definition.id);
      const unchanged = previous.executablePath === executablePath && previous.version === result.version;
      const statusMessage = !definition.supported ? definition.id === 'pi' ? '已发现安装入口，可在执行者设置中使用；连接测试尚未适配' : '已发现安装入口，调用接口尚未适配'
        : result.interfaceStatus === 'available'
          ? result.authStatus === 'logged_in' ? '已安装并登录，可进行连接测试'
            : result.authStatus === 'logged_out' ? '已安装，请先在 Agent 中登录'
              : '已识别调用接口，登录状态需要连接测试确认'
          : result.interfaceStatus === 'unavailable' ? '已安装，当前版本未识别到结构化调用接口'
            : '已安装，调用接口检测未完成';
      const agent = {...emptyAgent(definition), installed: true, executablePath, version: result.version,
        authStatus: result.authStatus, interfaceStatus: result.interfaceStatus,
        capabilities: result.capabilities, statusMessage, installations,
        ...(unchanged && previous.lastTest ? {lastTest: previous.lastTest} : {})};
      agents.set(definition.id, agent);
      return agent;
    }
    metadata.delete(definition.id);
    const missing = {...emptyAgent(definition), statusMessage: failure || (manualPaths[definition.id]
      ? '保存的程序路径不可用，请重新选择' : '未找到命令行程序，可以手动指定安装路径')};
    agents.set(definition.id, missing);
    return missing;
  }

  async function scanInternal({agentId, executablePath} = {}) {
    const definition = agentId === undefined ? undefined : definitionFor(agentId);
    if (executablePath !== undefined) {
      if (!definition) throw requestError('指定程序路径时必须选择 Agent', 400);
      if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)
          || executablePath.length > 4_096 || /[\0\r\n]/.test(executablePath)) {
        throw requestError('请输入有效的绝对程序路径', 400);
      }
      const resolved = await validatedExecutable(executablePath);
      if (!resolved) throw requestError('所选路径不是可执行文件', 400);
      if (!definition.supported) {
        const names = new Set([definition.command, ...(definition.aliases || [])]);
        const namedEntry = names.has(path.basename(executablePath)) || names.has(path.basename(resolved));
        const version = namedEntry ? '' : await staticAgentVersion(definition, resolved);
        if (!namedEntry && !version) throw requestError('无法确认所选程序的 Agent 身份，请选择实际程序入口', 400);
      }
    }
    await loadManualPaths();
    const directories = await candidateDirectories(env, homeDir, systemDirectories);
    if (definition) {
      const previous = agents.get(definition.id);
      const previousMetadata = metadata.get(definition.id);
      const result = await refresh(definition, directories, executablePath);
      if (executablePath !== undefined) {
        if (!result.installed) {
          agents.set(definition.id, previous);
          if (previousMetadata) metadata.set(definition.id, previousMetadata);
          throw requestError('无法确认所选程序的 Agent 身份或版本', 400);
        }
        manualPaths = {...manualPaths, [definition.id]: executablePath};
        await mkdir(path.dirname(settingsPath), {recursive: true});
        const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, JSON.stringify({manualPaths}, null, 2) + '\n', {mode: 0o600});
        await rename(temporaryPath, settingsPath);
      }
    } else {
      await Promise.all(DEFINITIONS.map((item) => refresh(item, directories)));
      const entryLocations = DEFINITIONS.flatMap((item) => [
        ...bundledAgentCandidates(item, homeDir, applicationDirectories),
        ...(manualPaths[item.id] ? [manualPaths[item.id]] : []),
      ]).map((candidate) => path.dirname(candidate));
      try {
        const found = await inventoryScanner({repoRoot, homeDir, runCommand, applicationDirectories});
        inventory = {applications: found.applications || [], customAgents: found.customAgents || [], scanLocations: [...new Set([...directories, ...entryLocations, ...(found.scanLocations || [])])], scanWarnings: found.scanWarnings || []};
      } catch { inventory = {...inventory, scanLocations: [...new Set([...directories, ...entryLocations, ...inventory.scanLocations])], scanWarnings: ['桌面应用和自定义 Agent 目录盘点未完成，请重新扫描']}; }
    }
    checkedAt = new Date().toISOString();
    if (!definition) initialized = true;
    return snapshot();
  }

  async function testInternal(agentId) {
    const definition = definitionFor(agentId);
    if (!definition.supported) throw requestError('此 Agent 已发现安装入口，但调用接口尚未适配，暂不支持连接测试', 400);
    await scanInternal({agentId});
    const agent = agents.get(agentId);
    const info = metadata.get(agentId);
    let result;
    if (!agent.installed) result = {status: 'failed', message: '未找到可执行的 Agent 程序'};
    else if (agent.interfaceStatus !== 'available') result = {status: 'failed', message: '当前版本未确认可用的调用接口'};
    else if (agent.authStatus === 'logged_out') result = {status: 'failed', message: '请先在 Agent 中登录，再测试连接'};
    else {
      const requiredFlags = agentId === 'codex'
        ? ['--sandbox', '--ignore-user-config', '--ignore-rules', '--ephemeral'] : agentId === 'claude'
          ? ['--tools', '--disallowedTools', '--strict-mcp-config', '--setting-sources']
          : ['--policy', '--approval-mode', '--extensions', '--allowed-mcp-server-names'];
      if (!requiredFlags.every((flag) => info.interfaceHelp.includes(flag))) {
        result = {status: 'failed', message: '当前版本缺少隔离测试参数，请升级 Agent 后重试'};
      } else {
        // Use an external temporary directory so ancestor project instructions,
        // .env files and FrameFlow's source never enter the connection test.
        const cwd = await mkdtemp(path.join(os.tmpdir(), 'frameflow-agent-test-'));
        try {
          if (agentId === 'gemini') {
            await mkdir(path.join(cwd, '.gemini'));
            await writeFile(path.join(cwd, '.gemini/settings.json'), JSON.stringify({
              tools: {core: []}, hooksConfig: {enabled: false}, skills: {enabled: false},
              context: {fileName: 'FRAMEFLOW_NO_CONTEXT.md'},
            }), {mode: 0o600});
            await writeFile(path.join(cwd, 'deny-tools.toml'),
              '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', {mode: 0o600});
          }
          const args = agentId === 'codex'
            ? ['--ask-for-approval', 'never', 'exec', '--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules',
              '--ephemeral', '--skip-git-repo-check', TEST_PROMPT]
            : agentId === 'claude' ? ['--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
              '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence',
              '--max-turns', '1', '-p', TEST_PROMPT, '--output-format', 'json']
              : ['--policy', path.join(cwd, 'deny-tools.toml'), '--approval-mode', 'default',
                '--extensions', 'none', '--allowed-mcp-server-names', '', '-p', TEST_PROMPT, '--output-format', 'json'];
          const run = await invoke(agent.executablePath, args, info.binDir, {cwd, timeoutMs: 45_000,
            ...(agentId === 'gemini' ? {env: {GEMINI_CLI_TRUST_WORKSPACE: 'true'}} : {})});
          result = commandSucceeded(run) && hasCompletedMarker(agentId, run.stdout)
            ? {status: 'passed', message: '连接成功，已收到测试回复'}
            : {status: 'failed', message: run.timedOut ? '连接测试超时，请检查网络和 Agent 登录状态'
              : run.outputLimitExceeded ? '连接测试输出超出限制，已停止进程'
                : agentId === 'codex' ? '测试使用默认 Agent 服务；未收到有效回复，请检查登录、网络、额度或服务配置'
                  : '未收到有效测试回复，请检查登录、网络、额度或升级 Agent'};
        } finally {
          await rm(cwd, {recursive: true, force: true});
        }
      }
    }
    agent.lastTest = {...result, checkedAt: new Date().toISOString()};
    if (result.status === 'passed') agent.authStatus = 'logged_in';
    checkedAt = agent.lastTest.checkedAt;
    return snapshot();
  }

  return {
    async list() {
      if (!initialized) return activeOperation ? activeOperation : scheduleCheck('all', () => scanInternal());
      return snapshot();
    },
    scan(options = {}) { return scheduleCheck(JSON.stringify(options), () => scanInternal(options)); },
    check(agentId) { definitionFor(agentId); return scheduleCheck(`check:${agentId}`, () => scanInternal({agentId})); },
    test(agentId) { definitionFor(agentId); return exclusive(() => testInternal(agentId)); },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
    },
  };
}

function emptyAgent({id, name, supported}) {
  return {id, name, installed: false, executablePath: '', version: '', authStatus: 'unknown',
    interfaceStatus: 'unknown', statusMessage: '尚未检测', capabilities: {headless: false, structuredOutput: false}, connectionSupport: supported ? 'supported' : 'discovery_only', installations: []};
}

function requestError(message, statusCode) { return Object.assign(new Error(message), {statusCode}); }
function stripControl(value) { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); }
function commandSucceeded(result) { return result?.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded && !result.errorCode; }
function probeFailure(result) { return result.timedOut ? '程序检测超时，已停止进程'
  : result.outputLimitExceeded ? '程序检测输出超出限制，已停止进程' : '程序启动或版本检测失败'; }
function joinedPath(parts) { return [...new Set(parts.flatMap((part) => typeof part === 'string' ? part.split(path.delimiter) : []).filter(Boolean))].join(path.delimiter); }

async function validatedExecutable(value) {
  try {
    if (!path.isAbsolute(value)) return null;
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isFile()) return null;
    await access(resolved, constants.X_OK);
    return resolved;
  } catch { return null; }
}

async function candidateDirectories(env, homeDir, systemDirectories) {
  const directories = (env.PATH || '').split(path.delimiter).filter((value) => path.isAbsolute(value)).slice(0, 40);
  directories.push(...systemDirectories,
    ...['.local/bin', 'bin', '.npm-global/bin', '.npm/bin', '.volta/bin', '.asdf/shims', '.local/share/pnpm',
      '.nvm/current/bin', '.bun/bin', '.docker/cli-plugins'].map((value) => path.join(homeDir, value)));
  for (const key of ['NVM_BIN', 'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'FNM_MULTISHELL_PATH', 'VOLTA_HOME']) {
    if (typeof env[key] !== 'string' || !path.isAbsolute(env[key])) continue;
    directories.push(env[key], path.join(env[key], 'bin'));
  }
  for (const [parent, suffix] of [
    [path.join(homeDir, '.nvm/versions/node'), 'bin'],
    [path.join(homeDir, '.local/share/fnm/node-versions'), 'installation/bin'],
    [path.join(homeDir, 'Library/Application Support/fnm/node-versions'), 'installation/bin'],
  ]) {
    try {
      const entries = await readdir(parent, {withFileTypes: true});
      entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .sort((a, b) => b.name.localeCompare(a.name, 'en', {numeric: true})).slice(0, 12)
        .forEach((entry) => directories.push(path.join(parent, entry.name, suffix)));
    } catch { /* This version manager is not installed. */ }
  }
  return [...new Set(directories)].slice(0, 100);
}

function hasCompletedMarker(agentId, stdout) {
  try {
    if (agentId === 'gemini') {
      const result = JSON.parse(stdout);
      return !result.error && result.response?.trim() === 'FRAMEFLOW_OK';
    }
    if (agentId === 'claude') {
      const result = JSON.parse(stdout);
      return result.type === 'result' && result.is_error !== true && result.result?.trim() === 'FRAMEFLOW_OK';
    }
    const events = stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    return events.some((event) => event.type === 'turn.completed')
      && !events.some((event) => event.type === 'turn.failed' || event.type === 'error')
      && events.some((event) => event.type === 'item.completed' && event.item?.type === 'agent_message'
        && event.item.text?.trim() === 'FRAMEFLOW_OK');
  } catch { return false; }
}

/** Bounded child process runner; outputs stay private to metadata parsers. */
export async function runLocalCommand(executablePath, args, {cwd, env, timeoutMs, maxOutputBytes, signal: abortSignal}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let killTimer;
    let finishTimer;
    let timeout;
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(finishTimer);
      abortSignal?.removeEventListener('abort', stop);
      // Keep an already scheduled SIGKILL: a descendant can survive its parent.
      resolve({stdout, stderr, timedOut, outputLimitExceeded, ...result});
    }
    function signal(signalName) {
      try {
        if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, signalName);
        else child?.kill(signalName);
      } catch { /* Process group already exited. */ }
    }
    function stop() {
      signal('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => signal('SIGKILL'), 250);
        killTimer.unref();
        finishTimer = setTimeout(() => finish({exitCode: null, errorCode: 'PROCESS_STOPPED'}), 700);
      }
    }
    try {
      child = spawn(executablePath, args, {cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    } catch {
      finish({exitCode: null, errorCode: 'SPAWN_FAILED'});
      return;
    }
    function collect(channel, chunk) {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { outputLimitExceeded = true; stop(); return; }
      if (channel === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    }
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', () => finish({exitCode: null, errorCode: 'SPAWN_FAILED'}));
    child.on('close', (exitCode) => finish({exitCode}));
    abortSignal?.addEventListener('abort', stop, {once: true});
    timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (abortSignal?.aborted) stop();
  });
}

async function defaultInventoryScanner(options) {
  const {discoverLocalAgentInventory} = await import('./local-agent-inventory.mjs');
  return discoverLocalAgentInventory(options);
}
