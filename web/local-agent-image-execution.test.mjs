import {chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {IMAGE_EXECUTION_ADAPTER_IDS, generateLocalAgentImage, readGeneratedImage, readImageWorkerInput, supportsLocalImageGeneration, validateImageExecutionRequest} from './local-agent-image-execution.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true}))); });
const IMAGE = {mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='};
const PI_FLAGS = ['--mode', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files'];
const HELP = {
  codex: 'Codex CLI --config --ask-for-approval',
  codexExec: 'codex exec --json --sandbox --ephemeral --skip-git-repo-check --ignore-rules',
  claude: 'Claude Code --print --input-format --output-format --settings --setting-sources --no-session-persistence --permission-mode',
};
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const RESULTS = {
  codex: jsonl({type: 'item.completed', item: {type: 'agent_message', text: '已生成图片，任意路径不用于读取。'}}, {type: 'turn.completed'}),
  claude: jsonl({type: 'result', subtype: 'success', is_error: false, result: '成功 /private/other.png'}),
  pi: jsonl({type: 'response', id: 'frameflow-image-prompt', command: 'prompt', success: true}, {type: 'tool_execution_start', toolName: 'generate_image'}, {type: 'tool_execution_end', toolName: 'generate_image', isError: false}, {type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: '完成'}], stopReason: 'stop'}}, {type: 'agent_settled'}),
};
async function fixture(id = 'codex') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frameflow-image-test-')));
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
  const runner = vi.fn(async (_command, args, opts) => {
    if (args[0] === '--version') return {exitCode: 0, stdout: id === 'codex' ? 'codex-cli 0.160.1' : '2.1.92 (Claude Code)', stderr: ''};
    if (args.join(' ') === 'exec --help') return {exitCode: 0, stdout: HELP.codexExec, stderr: ''};
    if (args[0] === '--help') return {exitCode: 0, stdout: HELP[id], stderr: ''};
    await writeFile(path.join(opts.cwd, 'output.png'), Buffer.from(IMAGE.data, 'base64'));
    return {exitCode: 0, stdout: RESULTS[id], stderr: 'secret-existing-provider-token'};
  });
  const options = {agentId: id, executablePath, prompt: '用现有生图工具生成森林。', referenceImages: [IMAGE], size: [1024, 1024], aspectRatio: '1:1', runCommand: runner, env: {PATH: '/usr/bin', EXISTING_PROVIDER_KEY: 'private-user-key'}};
  return {root, runner, options};
}

describe('independent local Agent image generation', () => {
  it('lists invocation adapters without asserting installed image tools or model image input', () => {
    expect(IMAGE_EXECUTION_ADAPTER_IDS).toEqual(['codex', 'claude', 'pi']);
    expect(supportsLocalImageGeneration('pi')).toBe(true);
    expect(supportsLocalImageGeneration('hermes')).toBe(false);
  });
  it.each(['codex', 'claude', 'pi'])('accepts a real new %s output PNG and gives tools reference paths, without native image blocks', async (id) => {
    const {options, runner} = await fixture(id);
    const implementation = runner.getMockImplementation();
    let cwd;
    runner.mockImplementation(async (command, args, opts) => {
      if (opts.input) {
        cwd = opts.cwd;
        const referencePath = path.join(cwd, 'references', 'reference-1.png');
        expect(await readFile(referencePath)).toEqual(Buffer.from(IMAGE.data, 'base64'));
        expect((await lstat(referencePath)).mode & 0o777).toBe(0o600);
        expect(opts.env.EXISTING_PROVIDER_KEY).toBe('private-user-key');
        expect(opts.env.TMPDIR).toBe(cwd);
        expect(opts.input).toContain(referencePath);
        expect(opts.input).toContain(path.join(cwd, 'output.png'));
        expect(opts.input).not.toContain(IMAGE.data);
        expect(args).not.toContain('--image');
        if (id === 'pi') expect(JSON.parse(opts.input)).toMatchObject({type: 'prompt', id: 'frameflow-image-prompt'});
        if (id === 'pi') expect(JSON.parse(opts.input)).not.toHaveProperty('images');
        if (id === 'claude') expect(JSON.parse(opts.input).message.content.every((block) => block.type === 'text')).toBe(true);
      }
      return implementation(command, args, opts);
    });
    expect(await generateLocalAgentImage(options)).toEqual({image: IMAGE});
    await expect(lstat(cwd)).rejects.toMatchObject({code: 'ENOENT'});
    if (id === 'pi') expect(runner).toHaveBeenCalledTimes(1);
  });
  it('limits Codex writes to workspace, retains tools/plugins/provider, and never enables full access or installs dependencies', async () => {
    const {options, runner} = await fixture(); await generateLocalAgentImage(options);
    const [, args] = runner.mock.calls.at(-1);
    expect(args).toContain('workspace-write'); expect(args).toContain('never');
    for (const value of ['features.hooks=false', 'features.skill_mcp_dependency_install=false', 'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true']) expect(args).toContain(value);
    for (const value of ['--ignore-user-config', 'danger-full-access', '--dangerously-bypass-approvals-and-sandbox', 'features.shell_tool=false', 'features.skills=false', 'features.apps=false']) expect(args).not.toContain(value);
    expect(args.some((value) => value.includes('mcp_servers.'))).toBe(false);
  });
  it('preserves Claude configured tools and MCP without bypassing its user permission rules', async () => {
    const {options, runner} = await fixture('claude'); await generateLocalAgentImage(options);
    const [, args] = runner.mock.calls.at(-1);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).toContain('{"disableAllHooks":true}');
    for (const flag of ['--tools', '--strict-mcp-config', '--mcp-config', '--disallowedTools', '--dangerously-skip-permissions', '--disable-slash-commands']) expect(args).not.toContain(flag);
  });
  it('allows Pi tool execution events and global extensions while excluding unrelated project context', async () => {
    const {options, runner} = await fixture('pi');
    expect(await generateLocalAgentImage(options)).toEqual({image: IMAGE});
    expect(runner.mock.calls[0][1]).toEqual(['--mode', 'rpc', '--no-session', '--no-context-files']);
    expect(runner.mock.calls[0][2].closeStdinOn).toBe('agent_settled');
  });
  it.each(['codex', 'claude', 'pi'])('refuses a changed %s executable version before generation', async (id) => {
    const {options, runner} = await fixture(id);
    await expect(generateLocalAgentImage({...options, expectedVersion: '0.0.1'})).rejects.toMatchObject({code: 'executor_changed', statusCode: 409});
    expect(runner.mock.calls.some(([, , opts]) => opts.input)).toBe(false);
  });
  it('rejects metadata identity mismatch and unsupported Agents without accepting arbitrary executables', async () => {
    const {options, runner} = await fixture('claude');
    await expect(generateLocalAgentImage({...options, agentId: 'hermes'})).rejects.toMatchObject({code: 'local_agent_not_adapted'});
    expect(runner).not.toHaveBeenCalled();
    runner.mockResolvedValue({exitCode: 0, stdout: 'unknown tool 1.2.3', stderr: 'secret-token'});
    const error = await generateLocalAgentImage(options).catch((error) => error);
    expect(error.code).toBe('local_agent_identity_mismatch'); expect(error.message).not.toContain('secret-token');
  });
  it('rejects text-only success, arbitrary output paths, and preexisting metadata outputs', async () => {
    const {options, runner, root} = await fixture('pi');
    const outside = path.join(root, 'other.png'); await writeFile(outside, Buffer.from(IMAGE.data, 'base64'));
    runner.mockResolvedValue({exitCode: 0, stdout: RESULTS.pi, stderr: ''});
    await expect(generateLocalAgentImage(options)).rejects.toMatchObject({code: 'local_agent_image_missing'});
    expect(await readFile(outside)).toEqual(Buffer.from(IMAGE.data, 'base64'));
    const codex = await fixture();
    const implementation = codex.runner.getMockImplementation();
    codex.runner.mockImplementation(async (command, args, opts) => {
      if (args[0] === '--help') await writeFile(path.join(opts.cwd, 'output.png'), Buffer.from(IMAGE.data, 'base64'));
      return implementation(command, args, opts);
    });
    await expect(generateLocalAgentImage(codex.options)).rejects.toMatchObject({code: 'invalid_local_agent_image_result'});
    expect(codex.runner.mock.calls.some(([, , opts]) => opts.input)).toBe(false);
  });
  it('refuses symlinked, empty, non-PNG, over-limit and FIFO outputs without reading their targets', async () => {
    const {root} = await fixture('pi');
    const directory = path.join(root, 'output'); await mkdir(directory);
    const outputPath = path.join(directory, 'output.png');
    const external = path.join(root, 'external.png'); await writeFile(external, Buffer.from(IMAGE.data, 'base64'));
    await symlink(external, outputPath);
    await expect(readGeneratedImage(outputPath, directory)).rejects.toMatchObject({code: 'invalid_local_agent_image_result'});
    await rm(outputPath);
    for (const data of [Buffer.alloc(0), Buffer.from('PNG text placeholder'), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
      await writeFile(outputPath, data);
      await expect(readGeneratedImage(outputPath, directory)).rejects.toMatchObject({code: 'invalid_local_agent_image_result'});
    }
    await rm(outputPath); await mkdir(outputPath);
    await expect(readGeneratedImage(outputPath, directory)).rejects.toMatchObject({code: 'invalid_local_agent_image_result'});
    await rm(outputPath, {recursive: true});
    if (process.platform !== 'win32') {
      expect(spawnSync('mkfifo', [outputPath]).status).toBe(0);
      await expect(readGeneratedImage(outputPath, directory)).rejects.toMatchObject({code: 'invalid_local_agent_image_result'});
    }
    await expect(readGeneratedImage(external, directory)).rejects.toMatchObject({code: 'invalid_local_agent_image_result'});
  });
  it.each(['codex', 'claude', 'pi'])('rejects contaminated/failed %s protocols even when an output file exists', async (id) => {
    const {options, runner} = await fixture(id);
    const implementation = runner.getMockImplementation();
    runner.mockImplementation(async (command, args, opts) => {
      const result = await implementation(command, args, opts);
      return opts.input ? {...result, stdout: 'private-key-diagnostic\n' + result.stdout} : result;
    });
    const error = await generateLocalAgentImage(options).catch((error) => error);
    expect(error.code).toBe('invalid_local_agent_result'); expect(error.message).not.toContain('private-key');
    runner.mockImplementation(async (command, args, opts) => {
      const result = await implementation(command, args, opts);
      return opts.input ? {...result, exitCode: 1} : result;
    });
    await expect(generateLocalAgentImage(options)).rejects.toMatchObject({code: 'local_agent_image_failed'});
  });
  it('cleans reference/output files on timeout, cancellation and bounded stdout failure', async () => {
    const {options, runner} = await fixture('pi'); let cwd;
    runner.mockImplementation(async (_command, _args, opts) => {
      cwd = opts.cwd;
      return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({exitCode: null, stdout: '', stderr: ''}), {once: true}));
    });
    await expect(generateLocalAgentImage({...options, timeoutMs: 25})).rejects.toMatchObject({code: 'local_agent_timeout'});
    await expect(lstat(cwd)).rejects.toMatchObject({code: 'ENOENT'});
    const controller = new AbortController();
    runner.mockImplementation(async (_command, _args, opts) => { cwd = opts.cwd; controller.abort(); return {exitCode: null, stdout: '', stderr: ''}; });
    await expect(generateLocalAgentImage({...options, signal: controller.signal})).rejects.toMatchObject({code: 'local_agent_cancelled'});
    await expect(lstat(cwd)).rejects.toMatchObject({code: 'ENOENT'});
    runner.mockImplementation(async (_command, _args, opts) => { cwd = opts.cwd; return {exitCode: 0, stdout: RESULTS.pi, stderr: 'secret', outputLimitExceeded: true}; });
    await expect(generateLocalAgentImage(options)).rejects.toMatchObject({code: 'local_agent_output_limit'});
    await expect(lstat(cwd)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('bounds reference bytes, prompt, geometry and worker input fields', async () => {
    const {options, runner} = await fixture('pi');
    for (const patch of [{referenceImages: Array(25).fill(IMAGE)}, {referenceImages: [{mimeType: 'image/png', data: 'invalid'}]}, {referenceImages: [{mimeType: 'image/png', data: 'A'.repeat(12 * 1024 * 1024)}]}, {prompt: 'x'.repeat(1024 * 1024 + 1)}, {size: [20000, 1]}, {size: '1\n--flag'}, {aspectRatio: '16:0'}]) {
      await expect(generateLocalAgentImage({...options, ...patch})).rejects.toMatchObject({statusCode: 400});
    }
    expect(runner).not.toHaveBeenCalled();
    expect(validateImageExecutionRequest({...options, size: '1024x1024'}).size).toBe('1024x1024');
    const request = await readImageWorkerInput(Readable.from([JSON.stringify({...options, runCommand: undefined, expectedVersion: '0.85.1', env: {SECRET: 'drop'}, arbitraryArgs: ['--yolo']})]));
    expect(request).toEqual({agentId: 'pi', executablePath: options.executablePath, prompt: options.prompt, referenceImages: [IMAGE], expectedVersion: '0.85.1', size: [1024, 1024], aspectRatio: '1:1'});
  });
  it('worker emits only safe error JSON for invalid requests and never raw stderr', () => {
    const worker = spawnSync(process.execPath, [path.resolve('local-agent-image-worker.mjs')], {input: '{invalid-secret-token}', encoding: 'utf8', timeout: 3000});
    expect(worker.status).toBe(1); expect(JSON.parse(worker.stdout)).toMatchObject({error: {code: 'invalid_local_agent_request'}});
    expect(worker.stderr).toBe(''); expect(worker.stdout).not.toContain('secret-token');
  });
  it('worker cancellation terminates its fake CLI group and cleans references', async () => {
    const {options, root} = await fixture('pi');
    const marker = path.join(root, 'started.json');
    await writeFile(options.executablePath, `#!/usr/bin/env node\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.stdin.resume();setInterval(()=>{},1000);\n`);
    const worker = spawn(process.execPath, [path.resolve('local-agent-image-worker.mjs')], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = ''; let stderr = '';
    worker.stdout.on('data', (chunk) => { stdout += chunk; }); worker.stderr.on('data', (chunk) => { stderr += chunk; });
    const completion = once(worker, 'close');
    worker.stdin.end(JSON.stringify({...options, runCommand: undefined, env: undefined}));
    const started = await waitFor(async () => { try { return JSON.parse(await readFile(marker, 'utf8')); } catch { return null; } });
    expect(await readFile(path.join(started.cwd, 'references/reference-1.png'))).toEqual(Buffer.from(IMAGE.data, 'base64'));
    worker.kill('SIGTERM');
    expect((await completion)[0]).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({error: {code: 'local_agent_cancelled'}}); expect(stderr).toBe('');
    expect(() => process.kill(started.pid, 0)).toThrow();
    await expect(lstat(started.cwd)).rejects.toMatchObject({code: 'ENOENT'});
  });
  it('worker notices a fake Python parent exit and terminates its own CLI instead of leaving an orphan', async () => {
    const {options, root} = await fixture('pi');
    const marker = path.join(root, 'parent-started.json');
    await writeFile(options.executablePath, `#!/usr/bin/env node\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.stdin.resume();setInterval(()=>{},1000);\n`);
    const request = JSON.stringify({...options, runCommand: undefined, env: undefined});
    const code = `const fs=require('node:fs');const cp=require('node:child_process');const w=cp.spawn(process.execPath,[${JSON.stringify(path.resolve('local-agent-image-worker.mjs'))}],{stdio:['pipe','ignore','ignore']});w.stdin.end(${JSON.stringify(request)});const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(t);process.exit(0)}},10);setTimeout(()=>process.exit(2),3000);`;
    const parent = spawn(process.execPath, ['-e', code], {stdio: 'ignore'});
    const completion = once(parent, 'close');
    const started = await waitFor(async () => { try { return JSON.parse(await readFile(marker, 'utf8')); } catch { return null; } });
    expect((await completion)[0]).toBe(0);
    await waitFor(async () => { try { process.kill(started.pid, 0); return null; } catch { return true; } });
    await waitFor(async () => { try { await lstat(started.cwd); return null; } catch (error) { return error.code === 'ENOENT'; } });
  });
});

async function waitFor(read, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('fake worker did not reach the expected lifecycle state');
}
