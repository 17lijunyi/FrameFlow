import {constants} from 'node:fs';
import {access, lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {localAgentError, requireFlags, runAgentProcess, validateExecutionRequest, verifyPi, verifyVersion} from './local-agent-execution.mjs';

// These are invocation adapters, not a claim that an installation has an image tool.
export const IMAGE_EXECUTION_ADAPTER_IDS = Object.freeze(['codex', 'claude', 'pi']);
export function supportsLocalImageGeneration(id) { return IMAGE_EXECUTION_ADAPTER_IDS.includes(id); }
// A tool may include one generated image in JSONL before saving its file.
// Bound that traffic without excluding an 8 MiB image encoded as base64.
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const INPUT_LIMIT = 48 * 1024 * 1024;
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SUFFIX = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif'};

export function validateImageExecutionRequest(value) {
  const request = validateExecutionRequest({...value, images: value?.referenceImages ?? []});
  const result = {agentId: request.agentId, executablePath: request.executablePath, prompt: request.prompt, referenceImages: request.images, ...(request.expectedVersion ? {expectedVersion: request.expectedVersion} : {})};
  if (value.size !== undefined) {
    const validString = typeof value.size === 'string' && /^[A-Za-z0-9: xX._-]{1,64}$/.test(value.size);
    const validPair = Array.isArray(value.size) && value.size.length === 2 && value.size.every((n) => Number.isInteger(n) && n >= 1 && n <= 16384);
    if (!validString && !validPair) throw localAgentError('invalid_local_agent_request', '生图尺寸参数无效', 400);
    result.size = validPair ? [...value.size] : value.size;
  }
  if (value.aspectRatio !== undefined) {
    if (typeof value.aspectRatio !== 'string' || !/^(?:auto|[1-9]\d{0,4}:[1-9]\d{0,4})$/.test(value.aspectRatio)) throw localAgentError('invalid_local_agent_request', '生图宽高比参数无效', 400);
    result.aspectRatio = value.aspectRatio;
  }
  return result;
}

export async function generateLocalAgentImage({signal, timeoutMs = 300_000, env = process.env, homeDir = os.homedir(), runCommand = runAgentProcess, ...input}) {
  const request = validateImageExecutionRequest(input);
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
  // Keep provider/model/auth and user tool configuration. No global config is changed.
  const commandEnv = {...env, PATH: [...new Set([path.dirname(request.executablePath), '/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH || '').split(path.delimiter), '/usr/bin', '/bin'].filter(Boolean))].join(path.delimiter)};
  function ensureActive() {
    if (controller.signal.aborted) throw localAgentError(timedOut ? 'local_agent_timeout' : 'local_agent_cancelled', timedOut ? '本地 Agent 生图超时，请检查服务后重试' : '本地 Agent 生图已取消', timedOut ? 504 : 409);
  }
  async function invoke(args, options = {}) {
    ensureActive();
    let result;
    try { result = await runCommand(executablePath, args, {cwd, env: commandEnv, signal: controller.signal, timeoutMs: Math.max(1, Math.min(deadline - Date.now(), options.timeoutMs || timeoutMs)), maxOutputBytes: OUTPUT_LIMIT, ...options}); }
    catch { ensureActive(); throw localAgentError('local_agent_unavailable', '无法启动本地 Agent，请检查安装和运行环境', 503); }
    ensureActive();
    if (result?.timedOut) throw localAgentError('local_agent_timeout', '本地 Agent 生图超时，请检查服务后重试', 504);
    if (result?.outputLimitExceeded || Buffer.byteLength(result?.stdout || '') > OUTPUT_LIMIT || Buffer.byteLength(result?.stderr || '') > OUTPUT_LIMIT) throw localAgentError('local_agent_output_limit', '本地 Agent 响应超过限制，生图任务已停止');
    if (result?.errorCode || result?.exitCode !== 0) throw localAgentError('local_agent_image_failed', '本地 Agent 生图失败，请检查自身生图工具、权限、登录和服务配置');
    return typeof result.stdout === 'string' ? result.stdout : '';
  }
  try {
    ensureActive();
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frameflow-agent-image-')));
    // Providers' tools may need their own temporary files; keep those in this job.
    commandEnv.TMPDIR = cwd;
    commandEnv.TMP = cwd;
    commandEnv.TEMP = cwd;
    let args;
    if (request.agentId === 'pi') {
      verifyVersion(request.expectedVersion, await verifyPi(executablePath));
      // Global extensions/skills/tools remain enabled; no unrelated project instructions.
      args = ['--mode', 'rpc', '--no-session', '--no-context-files'];
    } else {
      const version = await invoke(['--version'], {timeoutMs: 4_000});
      const help = await invoke(['--help'], {timeoutMs: 4_000});
      const identity = request.agentId === 'codex' ? /\bcodex(?:[- ]cli)?\b/i : /\bclaude(?: code)?\b/i;
      if (!identity.test(version + '\n' + help) || !/\b\d+\.\d+\.\d+/.test(version)) throw localAgentError('local_agent_identity_mismatch', '无法确认所选程序的 Agent 身份，请选择实际程序入口', 400);
      verifyVersion(request.expectedVersion, version.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0]);
      if (request.agentId === 'codex') {
        const execHelp = await invoke(['exec', '--help'], {timeoutMs: 4_000});
        requireFlags(execHelp, ['--json', '--sandbox', '--ephemeral', '--skip-git-repo-check']);
        requireFlags(help, ['--config', '--ask-for-approval']);
        const overrides = ['features.hooks=false', 'features.codex_hooks=false', 'features.multi_agent=false', 'features.skill_mcp_dependency_install=false', 'project_doc_max_bytes=0', 'notify=[]', 'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true'];
        args = ['--ask-for-approval', 'never', ...overrides.flatMap((value) => ['--config', value]), 'exec', '--json', '--sandbox', 'workspace-write', '--ephemeral', '--skip-git-repo-check'];
        if (execHelp.includes('--ignore-rules')) args.push('--ignore-rules');
        args.push('-');
      } else {
        requireFlags(help, ['--print', '--input-format', '--output-format', '--settings', '--setting-sources', '--no-session-persistence', '--permission-mode']);
        // Preserve user MCP/plugins and permission rules. A denied tool must fail safely.
        args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--permission-mode', 'default', '--no-session-persistence', '--max-turns', '24'];
      }
    }
    ensureActive();
    const referenceDirectory = path.join(cwd, 'references');
    await mkdir(referenceDirectory, {mode: 0o700});
    const references = [];
    for (let index = 0; index < request.referenceImages.length; index++) {
      ensureActive();
      const image = request.referenceImages[index];
      const imagePath = path.join(referenceDirectory, `reference-${index + 1}${SUFFIX[image.mimeType]}`);
      await writeFile(imagePath, Buffer.from(image.data, 'base64'), {mode: 0o600, flag: 'wx'});
      references.push(imagePath);
    }
    const outputPath = path.join(cwd, 'output.png');
    try { await lstat(outputPath); throw localAgentError('invalid_local_agent_image_result', '生图任务的输出位置已被占用，请重试'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const task = buildImageTask(request, outputPath, references, cwd);
    const inputText = request.agentId === 'pi'
      ? JSON.stringify({id: 'frameflow-image-prompt', type: 'prompt', message: task}) + '\n'
      : request.agentId === 'claude'
        ? JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'text', text: task}]}}) + '\n'
        : task;
    const stdout = await invoke(args, {input: inputText, ...(request.agentId === 'pi' ? {closeStdinOn: 'agent_settled'} : {})});
    ensureImageTaskCompleted(request.agentId, stdout);
    ensureActive();
    const image = await readGeneratedImage(outputPath, cwd);
    ensureActive();
    return {image};
  } catch (error) {
    ensureActive();
    if (error?.code && Number.isInteger(error.statusCode)) throw error;
    throw localAgentError('local_agent_image_failed', '本地 Agent 生图失败，请检查自身生图工具和权限配置');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (cwd) await rm(cwd, {recursive: true, force: true}).catch(() => {});
  }
}

function buildImageTask(request, outputPath, references, cwd) {
  return `你正在为 FrameFlow 执行一个明确授权的单张图片生成任务。\n使用你已配置且可用的真实生图工具或插件，保留用户原有服务和模型。不要安装工具或修改全局配置。所有本轮写入限定在任务目录 ${JSON.stringify(cwd)}。\n请生成一张 PNG 图片，并将原始图片字节保存到唯一结果文件 ${JSON.stringify(outputPath)}。若工具产生其他位置的图片，请复制或转换到该文件；不得只回复描述、路径、链接或伪造成功，不得用 SVG、占位图或程序绘制冒充生图。没有可用工具或权限不足时明确失败。\n参考图片按顺序位于：${JSON.stringify(references)}。这些文件提供给生图工具使用，无需通过文字模型原生图片输入。\n尺寸要求：${JSON.stringify({size: request.size ?? null, aspectRatio: request.aspectRatio ?? null})}。\n用户的图片创作要求如下：\n${request.prompt}`;
}

function ensureImageTaskCompleted(id, stdout) {
  let events;
  try {
    const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 20_000) throw new Error();
    events = lines.map((line) => JSON.parse(line));
    if (events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))) throw new Error();
  } catch { throw localAgentError('invalid_local_agent_result', '本地 Agent 没有返回有效的结构化生图结果，请检查版本和工具配置'); }
  if (id === 'codex') {
    if (!events.some((event) => event.type === 'turn.completed') || events.some((event) => ['error', 'turn.failed'].includes(event.type))) throw localAgentError('local_agent_image_failed', 'Codex 生图任务未完成，请检查生图工具和服务配置');
  } else if (id === 'claude') {
    const result = events.filter((event) => event.type === 'result').at(-1);
    if (!result || result.is_error || result.subtype !== 'success') throw localAgentError('local_agent_image_failed', 'Claude Code 生图任务未完成，请检查工具权限和服务配置');
  } else {
    const response = events.find((event) => event.type === 'response' && event.id === 'frameflow-image-prompt' && event.command === 'prompt');
    const message = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
    if (!response?.success || !events.some((event) => event.type === 'agent_settled') || !message || ['error', 'aborted'].includes(message.stopReason) || events.some((event) => event.type === 'error')) throw localAgentError('local_agent_image_failed', 'Pi 生图任务未完成，请检查生图扩展和服务配置');
  }
}

export async function readGeneratedImage(outputPath, cwd) {
  let file;
  try {
    const info = await lstat(outputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < PNG_HEADER.length || info.size > IMAGE_LIMIT) throw new Error();
    const resolved = await realpath(outputPath);
    if (path.dirname(resolved) !== cwd || path.basename(resolved) !== 'output.png') throw new Error();
    file = await open(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const current = await file.stat();
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size < PNG_HEADER.length || current.size > IMAGE_LIMIT) throw new Error();
    const buffer = Buffer.alloc(IMAGE_LIMIT + 1);
    let total = 0;
    while (total < buffer.length) {
      const {bytesRead} = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total < PNG_HEADER.length || total > IMAGE_LIMIT || !buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) throw new Error();
    return {mimeType: 'image/png', data: buffer.subarray(0, total).toString('base64')};
  } catch (error) {
    if (error.code === 'ENOENT') throw localAgentError('local_agent_image_missing', 'Agent 没有生成图片文件；请先在该 Agent 中配置并允许生图工具', 422);
    throw localAgentError('invalid_local_agent_image_result', 'Agent 生成的图片文件无效、超出 8 MiB 或不在本轮任务目录中');
  } finally { if (file) await file.close().catch(() => {}); }
}

export async function readImageWorkerInput(stream) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > INPUT_LIMIT) throw localAgentError('invalid_local_agent_request', '本地 Agent 生图输入超过限制', 400);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try { return validateImageExecutionRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error.code && error.statusCode) throw error; throw localAgentError('invalid_local_agent_request', '本地 Agent 生图输入不是有效 JSON', 400); }
}
