import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access, lstat, mkdtemp, open, realpath, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';

export const EXECUTION_ADAPTER_IDS = Object.freeze(['codex', 'claude', 'pi']);
export function supportsNativeImages(id) { return EXECUTION_ADAPTER_IDS.includes(id); }

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INPUT_LIMIT = 48 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TOTAL_LIMIT = 32 * 1024 * 1024;
const MIME_SUFFIX = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif'};

export function localAgentError(code, message, statusCode = 502) {
  return Object.assign(new Error(message), {code, statusCode});
}
export function validateExecutionRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw localAgentError('invalid_local_agent_request', '本地 Agent 请求格式无效', 400);
  if (!EXECUTION_ADAPTER_IDS.includes(value.agentId)) throw localAgentError('local_agent_not_adapted', '所选 Agent 的创作调用接口尚未适配，请选择 Codex、Claude Code 或 Pi', 422);
  if (typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath) || value.executablePath.length > 4096 || /[\0\r\n]/.test(value.executablePath)) throw localAgentError('invalid_local_agent_path', '请选择有效的 Agent 程序绝对路径', 400);
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > TEXT_LIMIT) throw localAgentError('invalid_local_agent_prompt', '创作请求为空或超出本地 Agent 输入限制', 400);
  if (value.expectedVersion !== undefined && (typeof value.expectedVersion !== 'string' || value.expectedVersion.length > 128 || /[\x00-\x1f]/.test(value.expectedVersion))) throw localAgentError('invalid_local_agent_request', 'Agent 版本确认信息无效', 400);
  const images = value.images ?? [];
  if (!Array.isArray(images) || images.length > 24) throw localAgentError('invalid_local_agent_images', '一次最多传入 24 张图片', 400);
  let total = 0;
  const normalized = images.map((image) => {
    if (!image || !Object.hasOwn(MIME_SUFFIX, image.mimeType) || typeof image.data !== 'string' || image.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw localAgentError('invalid_local_agent_images', '图片格式或大小不符合本地 Agent 输入要求', 400);
    const buffer = Buffer.from(image.data, 'base64');
    total += buffer.length;
    if (!buffer.length || buffer.length > IMAGE_LIMIT || total > IMAGE_TOTAL_LIMIT || !validImageHeader(buffer, image.mimeType)) throw localAgentError('invalid_local_agent_images', '图片内容无效，或图片总大小超过 32 MiB', 400);
    return {mimeType: image.mimeType, data: image.data};
  });
  return {agentId: value.agentId, executablePath: value.executablePath, prompt: value.prompt, images: normalized, ...(value.expectedVersion ? {expectedVersion: value.expectedVersion} : {})};
}

// The only model work is the explicit execute() invocation. Metadata checks
// never run Pi: its --help can load user extensions and migrate configuration.
export async function executeLocalAgent({signal, timeoutMs = 300_000, env = process.env, homeDir = os.homedir(), runCommand = runAgentProcess, repoRoot = REPO_ROOT, ...input}) {
  const request = validateExecutionRequest(input);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw localAgentError('invalid_local_agent_request', '本地 Agent 超时参数无效', 400);
  let executablePath;
  try {
    executablePath = await realpath(request.executablePath);
    if (!(await stat(executablePath)).isFile()) throw new Error();
    await access(executablePath, constants.X_OK);
  } catch { throw localAgentError('local_agent_unavailable', 'Agent 程序不可用，请重新扫描或选择程序入口', 422); }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) controller.abort();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let cwd;
  const commandEnv = {...env, PATH: [...new Set([path.dirname(request.executablePath), '/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH || '').split(path.delimiter), '/usr/bin', '/bin'].filter(Boolean))].join(path.delimiter)};
  function ensureActive() {
    if (controller.signal.aborted) throw localAgentError(timedOut ? 'local_agent_timeout' : 'local_agent_cancelled', timedOut ? '本地 Agent 请求超时，请检查服务后重试' : '本地 Agent 请求已取消', timedOut ? 504 : 409);
  }
  async function invoke(command, args, options = {}) {
    ensureActive();
    let result;
    try { result = await runCommand(command, args, {cwd, env: commandEnv, signal: controller.signal, timeoutMs: Math.max(1, Math.min(deadline - Date.now(), options.timeoutMs || timeoutMs)), maxOutputBytes: OUTPUT_LIMIT, ...options}); }
    catch { ensureActive(); throw localAgentError('local_agent_unavailable', '无法启动本地 Agent，请检查安装和运行环境', 503); }
    ensureActive();
    if (result?.timedOut) throw localAgentError('local_agent_timeout', '本地 Agent 请求超时，请检查服务后重试', 504);
    if (result?.outputLimitExceeded || Buffer.byteLength(result?.stdout || '') > OUTPUT_LIMIT || Buffer.byteLength(result?.stderr || '') > OUTPUT_LIMIT) throw localAgentError('local_agent_output_limit', '本地 Agent 响应超过限制，任务已停止');
    if (result?.errorCode || result?.exitCode !== 0) throw localAgentError('local_agent_failed', '本地 Agent 调用失败，请检查登录、模型服务、网络和额度');
    return typeof result.stdout === 'string' ? result.stdout : '';
  }
  try {
    ensureActive();
    cwd = await mkdtemp(path.join(os.tmpdir(), 'frameflow-agent-execution-'));
    let args;
    let stdin;
    if (request.agentId === 'pi') {
      verifyVersion(request.expectedVersion, await verifyPi(executablePath));
      args = ['--mode', 'rpc', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'];
      stdin = JSON.stringify({id: 'frameflow-prompt', type: 'prompt', message: request.prompt, images: request.images.map((image) => ({type: 'image', ...image}))}) + '\n';
    } else {
      const version = await invoke(executablePath, ['--version'], {timeoutMs: 4_000});
      const help = await invoke(executablePath, ['--help'], {timeoutMs: 4_000});
      const identity = request.agentId === 'codex' ? /\bcodex(?:[- ]cli)?\b/i : /\bclaude(?: code)?\b/i;
      if (!identity.test(version + '\n' + help) || !/\b\d+\.\d+\.\d+/.test(version)) throw localAgentError('local_agent_identity_mismatch', '无法确认所选程序的 Agent 身份，请选择实际程序入口', 400);
      verifyVersion(request.expectedVersion, version.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0]);
      if (request.agentId === 'codex') {
        const execHelp = await invoke(executablePath, ['exec', '--help'], {timeoutMs: 4_000});
        requireFlags(execHelp, ['--json', '--sandbox', '--ephemeral', '--skip-git-repo-check', '--image']);
        requireFlags(help, ['--config', '--ask-for-approval']);
        const mcpNames = await codexMcpNames({env: commandEnv, homeDir, repoRoot, invoke});
        const overrides = ['features.shell_tool=false', 'features.unified_exec=false', 'features.hooks=false', 'features.codex_hooks=false', 'features.multi_agent=false', 'features.apps=false', 'features.skills=false', 'features.skill_mcp_dependency_install=false', 'features.shell_snapshot=false', 'apps._default.enabled=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'notify=[]',
          ...mcpNames.map((name) => `mcp_servers.${JSON.stringify(name)}.enabled=false`)];
        args = ['--ask-for-approval', 'never', ...overrides.flatMap((value) => ['--config', value]), 'exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check'];
        if (execHelp.includes('--ignore-rules')) args.push('--ignore-rules');
        for (let index = 0; index < request.images.length; index++) {
          const image = request.images[index];
          const imagePath = path.join(cwd, `image-${index}${MIME_SUFFIX[image.mimeType]}`);
          await writeFile(imagePath, Buffer.from(image.data, 'base64'), {mode: 0o600, flag: 'wx'});
          args.push('--image', imagePath);
        }
        args.push('-');
        stdin = request.prompt;
      } else {
        // --max-turns is a documented print-mode flag hidden by some CLI help versions.
        requireFlags(help, ['--print', '--input-format', '--output-format', '--tools', '--disallowedTools', '--strict-mcp-config', '--mcp-config', '--settings', '--setting-sources', '--no-session-persistence']);
        args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--max-turns', '1'];
        if (help.includes('--disable-slash-commands')) args.push('--disable-slash-commands');
        const content = [{type: 'text', text: request.prompt}, ...request.images.map(({mimeType, data}) => ({type: 'image', source: {type: 'base64', media_type: mimeType, data}}))];
        stdin = JSON.stringify({type: 'user', message: {role: 'user', content}}) + '\n';
      }
    }
    ensureActive();
    const stdout = await invoke(executablePath, args, {input: stdin, ...(request.agentId === 'pi' ? {closeStdinOn: 'agent_settled'} : {})});
    return {text: parseResult(request.agentId, stdout)};
  } catch (error) {
    ensureActive();
    if (error?.code && Number.isInteger(error.statusCode)) throw error;
    throw localAgentError('local_agent_failed', '本地 Agent 调用失败，请检查安装、登录和服务配置');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (cwd) await rm(cwd, {recursive: true, force: true}).catch(() => {});
  }
}

export function requireFlags(help, flags) {
  if (!flags.every((flag) => new RegExp(`${flag}(?=[\\s,=]|$)`).test(help))) throw localAgentError('local_agent_interface_unavailable', '当前 Agent 版本缺少所需调用参数，请升级后重试', 422);
}
export function verifyVersion(expected, current) {
  if (expected && expected !== current) throw localAgentError('executor_changed', 'Agent 安装版本已改变，请在设置中重新确认执行者', 409);
}

export async function verifyPi(executablePath) {
  let directory = path.dirname(executablePath);
  for (let depth = 0; depth < 7 && directory !== path.dirname(directory); depth++, directory = path.dirname(directory)) {
    let manifest;
    try { manifest = JSON.parse(await readPublicText(path.join(directory, 'package.json'))); } catch { continue; }
    if (!['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'].includes(manifest.name) || !/^[0-9][0-9A-Za-z.+_-]{0,95}$/.test(manifest.version || '')) continue;
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi;
    let actualEntry;
    try { if (typeof entry === 'string') actualEntry = await realpath(path.resolve(directory, entry)); } catch { /* A broken package entry cannot establish identity. */ }
    if (actualEntry !== executablePath) continue;
    let source;
    try { source = await readPublicText(path.join(directory, 'dist/cli/args.js')); } catch {
      throw localAgentError('local_agent_interface_unavailable', 'Pi 安装包缺少可验证的参数定义，请升级或选择完整 CLI 安装', 422);
    }
    requireFlags(source.replace(/["']/g, ' '), ['--mode', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']);
    return manifest.version;
  }
  throw localAgentError('local_agent_identity_mismatch', '无法确认所选程序的 Pi 身份，请选择实际程序入口', 400);
}
async function readPublicText(filePath) {
  const limit = 256 * 1024;
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('invalid public metadata');
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > limit) throw new Error('invalid public metadata');
    const buffer = Buffer.alloc(limit + 1);
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('metadata exceeds limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

async function codexMcpNames({env, homeDir, repoRoot, invoke}) {
  const configHome = env.CODEX_HOME || path.join(homeDir, '.codex');
  if (!path.isAbsolute(configHome) || /[\0\r\n]/.test(configHome)) throw localAgentError('invalid_local_agent_config', 'Codex 配置目录无效，请检查本地 Agent 设置', 422);
  const python = path.join(repoRoot, '.venv/bin/python');
  // Print only server names. Configuration values and credentials remain local.
  const script = `import json,os,stat,sys,tomllib\np=sys.argv[1]\nnames=set()\ntry:\n s=os.lstat(p)\n if not stat.S_ISREG(s.st_mode) or s.st_size>1048576: raise ValueError()\n fd=os.open(p,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)|getattr(os,"O_NONBLOCK",0))\n with os.fdopen(fd,"rb") as f:\n  s=os.fstat(f.fileno())\n  if not stat.S_ISREG(s.st_mode) or s.st_size>1048576: raise ValueError()\n  b=f.read(1048577)\n  if len(b)>1048576: raise ValueError()\n d=tomllib.loads(b.decode("utf-8"))\n def walk(v,depth=0):\n  if depth>20: raise ValueError()\n  if not isinstance(v,dict): return\n  m=v.get("mcp_servers",{})\n  if not isinstance(m,dict): raise ValueError()\n  names.update(m.keys())\n  for x in v.values():\n   if isinstance(x,dict): walk(x,depth+1)\n walk(d)\n if len(names)>128 or any(not isinstance(x,str) or not x or len(x)>128 or any(ord(c)<32 for c in x) for x in names): raise ValueError()\nexcept FileNotFoundError: pass\nexcept Exception: sys.exit(2)\nprint(json.dumps(sorted(names)))`;
  let output;
  try { output = await invoke(python, ['-I', '-c', script, path.join(configHome, 'config.toml')], {timeoutMs: 4_000}); }
  catch (error) { if (['local_agent_cancelled', 'local_agent_timeout'].includes(error.code)) throw error; throw localAgentError('invalid_local_agent_config', '无法读取 Codex 工具配置，请检查配置格式和本地 Python 环境', 422); }
  try {
    const names = JSON.parse(output);
    if (!Array.isArray(names) || names.length > 128 || names.some((name) => typeof name !== 'string' || !name || name.length > 128 || /[\x00-\x1f]/.test(name))) throw new Error();
    return names;
  } catch { throw localAgentError('invalid_local_agent_config', '无法验证 Codex 工具配置，请检查配置后重试', 422); }
}

function parseResult(id, stdout) {
  let events;
  try {
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 20_000) throw new Error();
    events = lines.map((line) => JSON.parse(line));
    if (events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) throw new Error();
  } catch { throw localAgentError('invalid_local_agent_result', '本地 Agent 没有返回有效的结构化结果，请检查版本和服务配置'); }
  let text;
  if (id === 'codex') {
    if (events.some((event) => ['error', 'turn.failed'].includes(event.type)) || !events.some((event) => event.type === 'turn.completed')) throw localAgentError('local_agent_failed', 'Codex 请求未完成，请检查登录、模型服务和额度');
    const messages = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
    text = messages.at(-1)?.item.text;
  } else if (id === 'claude') {
    const result = events.filter((event) => event.type === 'result').at(-1);
    if (!result || result.is_error || result.subtype !== 'success') throw localAgentError('local_agent_failed', 'Claude Code 请求未完成，请检查登录、模型服务和额度');
    text = result.result;
  } else {
    const response = events.find((event) => event.type === 'response' && event.id === 'frameflow-prompt' && event.command === 'prompt');
    const messages = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant');
    const message = messages.at(-1)?.message;
    if (!response?.success || !events.some((event) => event.type === 'agent_settled') || !message || ['error', 'aborted'].includes(message.stopReason)
      || events.some((event) => event.type === 'tool_execution_start' || event.type === 'error')) throw localAgentError('local_agent_failed', 'Pi 请求未完成，请检查登录、模型服务和额度');
    text = (message.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  }
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > TEXT_LIMIT) throw localAgentError('invalid_local_agent_result', '本地 Agent 返回空回复或回复超过限制');
  return text;
}
function validImageHeader(buffer, mime) {
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === 'image/gif') return buffer.length >= 6 && /^(GIF87a|GIF89a)$/.test(buffer.subarray(0,6).toString());
  return buffer.length >= 12 && buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP';
}

/** Private, bounded stdio. No raw CLI output is logged or returned to callers. */
export function runAgentProcess(command, args, {cwd, env, input = '', signal, timeoutMs, maxOutputBytes = OUTPUT_LIMIT, closeStdinOn, spawnProcess = spawn, terminateProcess = terminateGroup}) {
  return new Promise((resolve) => {
    let child; let stdout = ''; let stderr = ''; let bytes = 0; let pending = ''; let closed = false; let settled = false; let stopped = false;
    let timer; let killTimer; let finishTimer; let errorCode; let timedOut = false; let outputLimitExceeded = false;
    const outDecoder = new StringDecoder('utf8'); const errDecoder = new StringDecoder('utf8');
    function finish(exitCode) {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(finishTimer); signal?.removeEventListener('abort', abort);
      resolve({exitCode, stdout, stderr, timedOut, outputLimitExceeded, ...(errorCode ? {errorCode} : {})});
    }
    function stop() {
      if (stopped || closed) return; stopped = true;
      try { terminateProcess(child, 'SIGTERM'); } catch { /* Already exited. */ }
      killTimer = setTimeout(() => { if (!closed) { try { terminateProcess(child, 'SIGKILL'); } catch { /* Already exited. */ } } }, 250);
      finishTimer = setTimeout(() => finish(null), 1000);
    }
    function abort() { errorCode = 'CANCELLED'; stop(); }
    function collect(channel, chunk) {
      if (settled || stopped) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { outputLimitExceeded = true; stop(); return; }
      const text = channel === 'stdout' ? outDecoder.write(chunk) : errDecoder.write(chunk);
      if (channel === 'stdout') {
        stdout += text;
        if (closeStdinOn) {
          pending += text;
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try { if (JSON.parse(line).type === closeStdinOn) child.stdin.end(); } catch { /* Validated after completion. */ }
          }
        }
      } else stderr += text;
    }
    if (signal?.aborted) { errorCode = 'CANCELLED'; finish(null); return; }
    try { child = spawnProcess(command, args, {cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']}); }
    catch { errorCode = 'SPAWN_FAILED'; finish(null); return; }
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.stdin.on('error', () => { /* Exit status/protocol decide whether a broken pipe was fatal. */ });
    child.once('error', () => { errorCode = 'SPAWN_FAILED'; stop(); });
    child.once('close', (exitCode) => { closed = true; clearTimeout(killTimer); stdout += outDecoder.end(); stderr += errDecoder.end(); finish(exitCode); });
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (closeStdinOn) child.stdin.write(input); else child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
function terminateGroup(child, signal) {
  if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, signal); else child?.kill(signal);
}

export async function readWorkerInput(stream) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > INPUT_LIMIT) throw localAgentError('invalid_local_agent_request', '本地 Agent 输入超过限制', 400);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try { return validateExecutionRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error.code && error.statusCode) throw error; throw localAgentError('invalid_local_agent_request', '本地 Agent 输入不是有效 JSON', 400); }
}
