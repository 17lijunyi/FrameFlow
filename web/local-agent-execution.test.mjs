import {chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough, Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EXECUTION_ADAPTER_IDS, executeLocalAgent, readWorkerInput, runAgentProcess, supportsNativeImages, validateExecutionRequest} from './local-agent-execution.mjs';

const roots = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))); });
const PI_FLAGS = ['--mode', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'];
const HELP = {
  codex: 'Codex CLI --config --ask-for-approval',
  codexExec: 'codex exec --json --sandbox --ephemeral --skip-git-repo-check --image --ignore-rules',
  claude: 'Claude Code --print --input-format --output-format --tools --disallowedTools --strict-mcp-config --mcp-config --settings --setting-sources --no-session-persistence --disable-slash-commands',
};
const IMAGE = {mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='};
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const RESULTS = {
  codex: jsonl({type: 'item.completed', item: {type: 'agent_message', text: '正文：画面包含一个人物。'}}, {type: 'turn.completed', usage: {}}),
  claude: jsonl({type: 'system', subtype: 'init'}, {type: 'result', subtype: 'success', is_error: false, result: '正文：画面包含一个人物。'}),
  pi: jsonl({type: 'response', id: 'frameflow-prompt', command: 'prompt', success: true}, {type: 'message_end', message: {role: 'assistant', content: [{type: 'thinking', thinking: 'private reasoning'}, {type: 'text', text: '正文：画面包含一个人物。'}], stopReason: 'stop'}}, {type: 'agent_end'}, {type: 'agent_settled'}),
};
async function fixture(id = 'codex') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameflow-execution-test-'));
  roots.push(root);
  let executablePath = path.join(root, 'bin', id);
  if (id === 'pi') {
    executablePath = path.join(root, 'package/dist/bundle/cli.js');
    await mkdir(path.join(root, 'package/dist/cli'), {recursive: true});
    await writeFile(path.join(root, 'package/package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '0.85.1', bin: {pi: 'dist/bundle/cli.js'}}));
    await writeFile(path.join(root, 'package/dist/cli/args.js'), PI_FLAGS.map((flag) => JSON.stringify(flag)).join('\n'));
  }
  await mkdir(path.dirname(executablePath), {recursive: true});
  await writeFile(executablePath, '#!/bin/sh\nexit 0\n'); await chmod(executablePath, 0o755);
  const runner = vi.fn(async (command, args) => {
    if (args[0] === '--version') return {exitCode: 0, stdout: id === 'codex' ? 'codex-cli 0.160.1' : '2.1.92 (Claude Code)', stderr: ''};
    if (args.join(' ') === 'exec --help') return {exitCode: 0, stdout: HELP.codexExec, stderr: ''};
    if (args[0] === '--help') return {exitCode: 0, stdout: HELP[id], stderr: ''};
    if (command.endsWith('/.venv/bin/python')) return {exitCode: 0, stdout: '["github","quoted.server"]', stderr: ''};
    return {exitCode: 0, stdout: RESULTS[id], stderr: 'private diagnostic token-never-echo'};
  });
  const options = {agentId: id, executablePath, prompt: '请检查这些像素。', images: [IMAGE], runCommand: runner, homeDir: root, repoRoot: root, env: {PATH: '/usr/bin', CUSTOM_PROVIDER_KEY: 'private-existing-key', CODEX_HOME: path.join(root, 'codex-home')}};
  return {root, executablePath, runner, options};
}

describe('local Agent execution adapters', () => {
  it('exports only implemented adapters without guessing the selected model modality', () => {
    expect(EXECUTION_ADAPTER_IDS).toEqual(['codex', 'claude', 'pi']);
    expect(supportsNativeImages('pi')).toBe(true);
    expect(supportsNativeImages('hermes')).toBe(false);
  });
  it('passes Codex actual image files and keeps user provider settings while disabling native execution', async () => {
    const {options, runner} = await fixture();
    let jobOptions;
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (command, args, opts) => {
      if (args.at(-1) === '-') {
        jobOptions = opts;
        const imagePath = args[args.indexOf('--image') + 1];
        expect(await readFile(imagePath)).toEqual(Buffer.from(IMAGE.data, 'base64'));
        expect((await stat(imagePath)).mode & 0o777).toBe(0o600);
        expect(args).toContain('read-only'); expect(args).toContain('never');
        expect(args).not.toContain('--ignore-user-config');
        expect(args).toContain('features.shell_tool=false'); expect(args).toContain('features.unified_exec=false');
        expect(args).toContain('features.hooks=false'); expect(args).toContain('features.multi_agent=false');
        expect(args).toContain('mcp_servers."github".enabled=false'); expect(args).toContain('mcp_servers."quoted.server".enabled=false');
        expect(opts.input).toBe(options.prompt); expect(opts.input).not.toContain(imagePath);
        expect(opts.env.CUSTOM_PROVIDER_KEY).toBe('private-existing-key');
      }
      return implementation(command, args, opts);
    });
    expect(await executeLocalAgent(options)).toEqual({text: '正文：画面包含一个人物。'});
    await expect(stat(jobOptions.cwd)).rejects.toMatchObject({code: 'ENOENT'});
    expect(JSON.stringify(await executeLocalAgent(options))).not.toMatch(/token-never-echo|private-existing-key/);
  });
  it('passes Claude native base64 image blocks, retains user settings, and excludes native tools/hooks/MCP', async () => {
    const {options, runner} = await fixture('claude');
    expect(await executeLocalAgent(options)).toEqual({text: '正文：画面包含一个人物。'});
    const [, args, opts] = runner.mock.calls.at(-1);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args).toContain('{"disableAllHooks":true}'); expect(args).toContain('{"mcpServers":{}}'); expect(args).toContain('mcp__*');
    expect(JSON.parse(opts.input).message.content).toEqual([{type: 'text', text: options.prompt}, {type: 'image', source: {type: 'base64', media_type: IMAGE.mimeType, data: IMAGE.data}}]);
    expect(opts.env.CUSTOM_PROVIDER_KEY).toBe('private-existing-key');
    await expect(stat(opts.cwd)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('verifies Pi statically and sends exact RPC ImageContent without probing help or version', async () => {
    const {options, runner} = await fixture('pi');
    expect(await executeLocalAgent({...options, expectedVersion: '0.85.1'})).toEqual({text: '正文：画面包含一个人物。'});
    expect(runner).toHaveBeenCalledTimes(1);
    const [, args, opts] = runner.mock.calls[0];
    expect(args).toEqual(['--mode', 'rpc', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files']);
    expect(JSON.parse(opts.input)).toEqual({id: 'frameflow-prompt', type: 'prompt', message: options.prompt, images: [{type: 'image', ...IMAGE}]});
    expect(opts.closeStdinOn).toBe('agent_settled');
    expect(JSON.stringify(await executeLocalAgent(options))).not.toContain('private reasoning');
  });
  it.each(['codex', 'claude', 'pi'])('refuses changed %s versions before inference', async (id) => {
    const {options, runner} = await fixture(id);
    await expect(executeLocalAgent({...options, expectedVersion: '0.0.1'})).rejects.toMatchObject({code: 'executor_changed', statusCode: 409});
    expect(runner.mock.calls.every(([, args]) => args.includes('--help') || args.includes('--version'))).toBe(true);
  });
  it('does not accept a different executable merely located under a Pi package', async () => {
    const {options, root, runner} = await fixture('pi');
    const fake = path.join(root, 'package/dist/bundle/unrelated'); await writeFile(fake, ''); await chmod(fake, 0o755);
    await expect(executeLocalAgent({...options, executablePath: fake})).rejects.toMatchObject({code: 'local_agent_identity_mismatch'});
    expect(runner).not.toHaveBeenCalled();
  });
  it('rejects unverified Pi interface flags and symlinked public metadata without running Pi', async () => {
    const {options, root, runner} = await fixture('pi');
    const source = path.join(root, 'package/dist/cli/args.js');
    await writeFile(source, PI_FLAGS.filter((flag) => flag !== '--no-tools').map((flag) => JSON.stringify(flag)).join('\n'));
    await expect(executeLocalAgent(options)).rejects.toMatchObject({code: 'local_agent_interface_unavailable'});
    await rm(source); await writeFile(path.join(root, 'private'), PI_FLAGS.join(' ')); await symlink(path.join(root, 'private'), source);
    await expect(executeLocalAgent(options)).rejects.toMatchObject({code: 'local_agent_interface_unavailable'});
    expect(runner).not.toHaveBeenCalled();
  });
  it('refuses unsupported Agents, malformed paths, empty prompts, and fake/oversized images before any executable runs', async () => {
    const {options, runner} = await fixture();
    for (const patch of [{agentId: 'hermes'}, {executablePath: 'relative'}, {prompt: ''}, {prompt: 'x'.repeat(1024 * 1024 + 1)}, {images: [{mimeType: 'image/png', data: 'not base64'}]}, {images: [{mimeType: 'image/png', data: Buffer.from('hello').toString('base64')}]}, {images: Array(25).fill(IMAGE)}, {images: [{mimeType: 'image/png', data: 'A'.repeat(12 * 1024 * 1024)}]}]) {
      await expect(executeLocalAgent({...options, ...patch})).rejects.toMatchObject({statusCode: expect.any(Number)});
    }
    expect(runner).not.toHaveBeenCalled();
  });
  it('checks Agent identity before inference and never exposes raw diagnostics', async () => {
    const {options, runner} = await fixture('claude');
    runner.mockResolvedValue({exitCode: 0, stdout: 'unrelated program 1.2.3', stderr: 'credential-private'});
    const error = await executeLocalAgent(options).catch((error) => error);
    expect(error.code).toBe('local_agent_identity_mismatch'); expect(error.message).not.toContain('credential-private');
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it.each(['codex', 'claude', 'pi'])('rejects failed, truncated and contaminated %s protocols without returning their raw content', async (id) => {
    const {options, runner} = await fixture(id);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (command, args, opts) => opts.input ? {exitCode: 0, stdout: 'secret-provider-diagnostic\n' + RESULTS[id], stderr: ''} : implementation(command, args, opts));
    const error = await executeLocalAgent(options).catch((error) => error);
    expect(error.code).toBe('invalid_local_agent_result'); expect(error.message).not.toContain('secret-provider');
    runner.mockImplementation(async (command, args, opts) => opts.input ? {exitCode: 1, stdout: 'secret-provider-diagnostic', stderr: ''} : implementation(command, args, opts));
    await expect(executeLocalAgent(options)).rejects.toMatchObject({code: 'local_agent_failed'});
    runner.mockImplementation(async (command, args, opts) => opts.input ? {exitCode: 0, stdout: RESULTS[id], stderr: '', outputLimitExceeded: true} : implementation(command, args, opts));
    await expect(executeLocalAgent(options)).rejects.toMatchObject({code: 'local_agent_output_limit'});
  });
  it('requires completion and never accepts Pi tool activity or thinking as an answer', async () => {
    const {options, runner} = await fixture('pi');
    runner.mockResolvedValue({exitCode: 0, stdout: RESULTS.pi.replace('{"type":"agent_settled"}\n', ''), stderr: ''});
    await expect(executeLocalAgent(options)).rejects.toMatchObject({code: 'local_agent_failed'});
    runner.mockResolvedValue({exitCode: 0, stdout: RESULTS.pi + jsonl({type: 'tool_execution_start'}), stderr: ''});
    await expect(executeLocalAgent(options)).rejects.toMatchObject({code: 'local_agent_failed'});
  });
  it('cancels promptly during inference and cleans isolated files', async () => {
    const {options, runner} = await fixture('pi'); const controller = new AbortController(); let cwd;
    runner.mockImplementation(async (_command, _args, opts) => {
      cwd = opts.cwd;
      controller.abort();
      return {exitCode: null, errorCode: 'CANCELLED', stdout: '', stderr: ''};
    });
    await expect(executeLocalAgent({...options, signal: controller.signal})).rejects.toMatchObject({code: 'local_agent_cancelled'});
    await expect(stat(cwd)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('enforces a deadline across probing and inference', async () => {
    const {options, runner} = await fixture('pi');
    runner.mockImplementation(async (_command, _args, opts) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({exitCode: null, stdout: '', stderr: ''}), {once: true})));
    await expect(executeLocalAgent({...options, timeoutMs: 30})).rejects.toMatchObject({code: 'local_agent_timeout'});
  });
  it('keeps worker request fields narrow and returns safe JSON for invalid input without starting a CLI', async () => {
    const {options} = await fixture('pi');
    const request = await readWorkerInput(Readable.from([JSON.stringify({...options, runCommand: undefined, env: {SECRET: 'drop-this'}, expectedVersion: '0.85.1', arbitraryArgs: ['--yolo']})]));
    expect(request).toEqual({agentId: 'pi', executablePath: options.executablePath, prompt: options.prompt, images: [IMAGE], expectedVersion: '0.85.1'});
    const worker = spawnSync(process.execPath, [path.resolve('local-agent-worker.mjs')], {input: '{invalid secret-token}', encoding: 'utf8', timeout: 3000});
    expect(worker.status).toBe(1); expect(JSON.parse(worker.stdout)).toMatchObject({error: {code: 'invalid_local_agent_request'}});
    expect(worker.stderr).toBe(''); expect(worker.stdout).not.toContain('secret-token');
    expect(() => validateExecutionRequest({...options, expectedVersion: 'bad\nversion'})).toThrow();
  });
});

function fakeChild() {
  const child = new EventEmitter(); child.pid = 98765; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = vi.fn();
  return child;
}
describe('bounded Agent process runner', () => {
  it('uses shell:false, decodes UTF-8 across chunks, and closes Pi stdin only at settled', async () => {
    const child = fakeChild(); const spawnProcess = vi.fn(() => child); const terminateProcess = vi.fn();
    const pending = runAgentProcess('/mock/pi', [], {cwd: '/tmp', env: {}, input: '{"type":"prompt"}\n', timeoutMs: 1000, closeStdinOn: 'agent_settled', spawnProcess, terminateProcess});
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({shell: false, detached: process.platform !== 'win32'});
    expect(child.stdin.writableEnded).toBe(false);
    const text = Buffer.from(jsonl({type: 'message_end', text: '中文'}, {type: 'agent_settled'})); const offset = text.indexOf(Buffer.from('中文')) + 1;
    child.stdout.write(text.subarray(0, offset)); child.stdout.write(text.subarray(offset));
    expect(child.stdin.writableEnded).toBe(true); child.emit('close', 0);
    const result = await pending; expect(result.stdout).toContain('中文'); expect(result.stdout).not.toContain('�'); expect(terminateProcess).not.toHaveBeenCalled();
  });
  it('terminates only its own process group on overflow, escalates, and clears kill timers after close', async () => {
    vi.useFakeTimers(); const child = fakeChild(); const terminateProcess = vi.fn();
    const pending = runAgentProcess('/mock/pi', [], {cwd: '/tmp', env: {}, timeoutMs: 1000, maxOutputBytes: 4, spawnProcess: () => child, terminateProcess});
    child.stderr.write('secret diagnostic'); expect(terminateProcess).toHaveBeenCalledWith(child, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(250); expect(terminateProcess).toHaveBeenCalledWith(child, 'SIGKILL');
    child.emit('close', null); const result = await pending; expect(result.outputLimitExceeded).toBe(true); expect(result.stderr).toBe('');
    const count = terminateProcess.mock.calls.length; await vi.advanceTimersByTimeAsync(2000); expect(terminateProcess).toHaveBeenCalledTimes(count);
  });
  it('handles cancellation without spawning after an already-aborted signal', async () => {
    const controller = new AbortController(); controller.abort(); const spawnProcess = vi.fn();
    expect(await runAgentProcess('/mock/pi', [], {signal: controller.signal, timeoutMs: 1000, spawnProcess})).toMatchObject({errorCode: 'CANCELLED'});
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it('does not send delayed signals to a process that closes during termination grace', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); const child = fakeChild(); const terminateProcess = vi.fn();
    const pending = runAgentProcess('/mock/pi', [], {cwd: '/tmp', env: {}, signal: controller.signal, timeoutMs: 1000, spawnProcess: () => child, terminateProcess});
    controller.abort(); child.emit('close', null); expect(await pending).toMatchObject({errorCode: 'CANCELLED'});
    await vi.advanceTimersByTimeAsync(2000); expect(terminateProcess).toHaveBeenCalledTimes(1);
  });
});
