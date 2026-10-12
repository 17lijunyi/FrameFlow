import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readdir, realpath, stat} from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const APPLICATION_LIMIT = 240;
const DEFINITION_LIMIT = 200;
const PLIST_OUTPUT_LIMIT = 128 * 1024;
const INSTRUCTION_FILES = new Set([
  'agents.md', 'claude.md', 'gemini.md', 'skill.md', 'soul.md', 'tools.md', 'user.md',
  'identity.md', 'heartbeat.md', 'bootstrap.md', 'instructions.md', 'readme.md',
]);
const NON_AGENT_DIRECTORIES = new Set(['skills', 'instructions', 'sessions', 'credentials']);
const APPLICATIONS = new Map([
  ['com.openai.codex', 'desktop'], ['com.openai.chat', 'assistant'],
  ['com.anthropic.claudefordesktop', 'desktop'], ['com.anthropic.claude', 'desktop'],
  ['com.deepseek.dsh', 'desktop'], ['com.aionui.app', 'desktop'], ['app.lorca.dev', 'desktop'],
  ['com.anysphere.sand', 'desktop'], ['com.kangfenmao.CherryStudio', 'desktop'],
  ['com.todesktop.230313mzl4w4u92', 'ide'], ['com.trae.app', 'ide'],
  ['com.exafunction.windsurf', 'ide'], ['com.microsoft.VSCode', 'ide'],
  ['com.bot.neotix.doubao', 'assistant'], ['com.work.pc.doubao', 'desktop'],
  ['com.moonshot.kimichat.kmp.mac', 'assistant'], ['com.alibaba.tongyi', 'assistant'],
  ['com.meta.endo', 'assistant'], ['ai.opencode.desktop', 'desktop'],
  ['com.ollama.ollama', 'desktop'], ['ai.elementlabs.lmstudio', 'desktop'],
]);
const APPLICATION_NAMES = new Map([
  ['Codex.app', 'desktop'], ['ChatGPT.app', 'desktop'], ['Claude.app', 'desktop'],
  ['DeepSeek Harness.app', 'desktop'], ['Foundry.app', 'desktop'], ['AionUi.app', 'desktop'],
  ['Orbi Dev.app', 'desktop'], ['Grok Bot.app', 'desktop'], ['Cherry Studio.app', 'desktop'],
  ['Cursor.app', 'ide'], ['Trae.app', 'ide'], ['Windsurf.app', 'ide'],
  ['Visual Studio Code.app', 'ide'], ['Doubao.app', 'assistant'], ['DoubaoWork.app', 'desktop'],
  ['Kimi.app', 'assistant'], ['Qianwen.app', 'assistant'], ['Muse.app', 'assistant'],
  ['OpenCode.app', 'desktop'], ['Ollama.app', 'desktop'], ['LM Studio.app', 'desktop'],
]);

function identity(prefix, value) {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function safeText(value, limit = 160) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';
}

async function readPlist(file, runCommand) {
  const resolved = await realpath(file);
  const bundleRoot = path.dirname(path.dirname(file));
  // App aliases are resolved by the scanner; an Info.plist link must still stay in that bundle.
  if (!resolved.startsWith(`${bundleRoot}${path.sep}`)) throw new Error('PLIST_OUTSIDE_BUNDLE');
  const info = await stat(resolved);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('INVALID_PLIST_FILE');
  const args = ['-convert', 'json', '-o', '-', '--', file];
  if (runCommand) {
    const result = await runCommand('/usr/bin/plutil', args, {
      cwd: '/private/tmp', env: {PATH: '/usr/bin:/bin'}, timeoutMs: 1500, maxOutputBytes: PLIST_OUTPUT_LIMIT,
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.errorCode) throw new Error('PLIST_FAILED');
    return JSON.parse(result.stdout);
  }
  const result = await execFileAsync('/usr/bin/plutil', args, {timeout: 1500, maxBuffer: PLIST_OUTPUT_LIMIT});
  return JSON.parse(result.stdout);
}

/** Read only public App metadata and Agent definition names, never definition contents or credentials. */
export async function discoverLocalAgentInventory({
  repoRoot, homeDir, runCommand,
  applicationDirectories = ['/Applications', path.join(homeDir, 'Applications')],
  readApplicationInfo = (file) => readPlist(file, runCommand),
}) {
  const applications = [];
  const customAgents = [];
  const scanLocations = [];
  const scanWarnings = [];
  const seenApplications = new Set();
  const seenDefinitions = new Set();

  async function entriesAt(directory) {
    scanLocations.push(directory);
    try {
      return (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') scanWarnings.push(`无法访问 ${directory}，该目录未完成扫描`);
      return [];
    }
  }

  for (const directory of [...new Set(applicationDirectories)]) {
    const entries = (await entriesAt(directory)).filter((entry) => entry.name.endsWith('.app') && (entry.isDirectory() || entry.isSymbolicLink()));
    if (entries.length > APPLICATION_LIMIT) scanWarnings.push(`${directory} 的应用超过 ${APPLICATION_LIMIT} 个，部分应用未扫描`);
    // Each wave is bounded; no application executable is launched for inventory.
    for (let offset = 0; offset < Math.min(entries.length, APPLICATION_LIMIT); offset += 6) {
      await Promise.all(entries.slice(offset, Math.min(offset + 6, APPLICATION_LIMIT)).map(async (entry) => {
        const appPath = path.join(directory, entry.name);
        let resolved;
        try {
          resolved = await realpath(appPath);
          if (!(await stat(resolved)).isDirectory()) return;
        } catch { return; }
        if (seenApplications.has(resolved)) return;
        let info = {};
        try {
          const metadata = await readApplicationInfo(path.join(resolved, 'Contents/Info.plist'));
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('INVALID_PLIST_METADATA');
          info = metadata;
        }
        catch {
          if (APPLICATION_NAMES.has(entry.name)) scanWarnings.push(`${appPath} 的公开应用信息不可读，版本未确认`);
        }
        const bundleId = safeText(info.CFBundleIdentifier);
        // Safari website wrappers and browser helpers are not independent Agent installations.
        if (bundleId.startsWith('com.apple.Safari.WebApp.')) return;
        // A readable, different bundle identity must not become an Agent just because of its filename.
        const kind = APPLICATIONS.get(bundleId) || (!bundleId && APPLICATION_NAMES.get(entry.name));
        if (!kind || seenApplications.has(resolved)) return;
        seenApplications.add(resolved);
        applications.push({
          id: identity('app', resolved), name: safeText(info.CFBundleDisplayName || info.CFBundleName) || entry.name.slice(0, -4),
          path: appPath, version: safeText(info.CFBundleShortVersionString || info.CFBundleVersion), bundleId, kind,
          statusMessage: kind === 'ide' ? '已发现 IDE；Agent 插件的启用、登录与调用接口尚未验证'
            : kind === 'assistant' ? '已发现 AI 助手应用；尚未适配后台调用接口'
              : '已发现桌面应用；安装状态不代表已接入 FrameFlow',
        });
      }));
    }
  }

  const definitions = [
    ['Claude Code', '.claude/agents'], ['Codex', '.codex/agents'], ['Gemini', '.gemini/agents'],
    ['Cursor', '.cursor/agents'], ['OpenCode', '.config/opencode/agents'], ['OpenCode', '.config/opencode/agent'],
    ['OpenCode', '.opencode/agents'], ['OpenCode', '.opencode/agent'], ['Qwen', '.qwen/agents'],
  ].map(([source, directory]) => ({source, directory: path.join(homeDir, directory)}));
  for (const [source, directory] of [
    ['Claude Code（当前项目）', '.claude/agents'], ['Codex（当前项目）', '.codex/agents'],
    ['Gemini（当前项目）', '.gemini/agents'], ['Cursor（当前项目）', '.cursor/agents'],
    ['OpenCode（当前项目）', '.opencode/agents'], ['OpenCode（当前项目）', '.opencode/agent'],
  ]) definitions.push({source, directory: path.join(repoRoot, directory)});

  for (const {source, directory} of definitions) {
    let inspected = 0;
    let capped = false;
    async function walk(folder, depth) {
      if (inspected >= DEFINITION_LIMIT) { capped = true; return; }
      const entries = await entriesAt(folder);
      if (entries.length > DEFINITION_LIMIT) capped = true;
      for (const entry of entries.slice(0, DEFINITION_LIMIT)) {
        if (inspected >= DEFINITION_LIMIT) { capped = true; break; }
        inspected += 1;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          if (NON_AGENT_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          if (depth < 3) await walk(file, depth + 1);
          else capped = true;
          continue;
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!/\.(md|toml|yaml|yml|json)$/i.test(entry.name) || INSTRUCTION_FILES.has(entry.name.toLowerCase()) || /^readme[._-].*\.md$/i.test(entry.name)) continue;
        let resolved;
        try {
          resolved = await realpath(file);
          if (!(await stat(resolved)).isFile()) continue;
        } catch { continue; }
        if (seenDefinitions.has(resolved)) continue;
        seenDefinitions.add(resolved);
        customAgents.push({id: identity('definition', resolved), name: path.relative(directory, file).replace(/\.[^.]+$/, ''),
          path: file, source, kind: 'definition', statusMessage: '已发现定义文件；未读取内容，配置有效性与调用方式尚未验证'});
      }
    }
    await walk(directory, 0);
    if (capped) scanWarnings.push(`${directory} 达到扫描数量或深度上限，部分定义未扫描`);
  }

  for (const [source, directory] of [
    ['OpenClaw', path.join(homeDir, '.openclaw/agents')], ['Hermes', path.join(homeDir, '.hermes/profiles')],
  ]) {
    const entries = (await entriesAt(directory)).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    if (entries.length > DEFINITION_LIMIT) scanWarnings.push(`${directory} 超过 ${DEFINITION_LIMIT} 个配置目录，部分目录未扫描`);
    for (const entry of entries.slice(0, DEFINITION_LIMIT)) {
      const file = path.join(directory, entry.name);
      customAgents.push({id: identity('profile', file), name: entry.name, path: file, source, kind: 'profile',
        statusMessage: '已发现 Agent 配置目录；运行服务与调用接口尚未验证'});
    }
  }
  return {
    applications: applications.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    customAgents: customAgents.sort((a, b) => `${a.source}/${a.name}`.localeCompare(`${b.source}/${b.name}`)),
    scanLocations: [...new Set(scanLocations)], scanWarnings,
  };
}
