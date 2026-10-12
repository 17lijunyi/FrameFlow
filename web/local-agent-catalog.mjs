import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import path from 'node:path';

// Entries without a FrameFlow protocol adapter are inventoried, never executed.
export const LOCAL_AGENT_DEFINITIONS = [
  {id: 'codex', name: 'Codex CLI', command: 'codex', authArgs: ['login', 'status'], supported: true},
  {id: 'claude', name: 'Claude Code', command: 'claude', authArgs: ['auth', 'status'], supported: true},
  {id: 'gemini', name: 'Gemini CLI', command: 'gemini', supported: true},
  {id: 'pi', name: 'Pi Coding Agent', command: 'pi', packages: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']},
  {id: 'hermes', name: 'Hermes Agent', command: 'hermes'},
  {id: 'opencode', name: 'OpenCode', command: 'opencode', packages: ['opencode-ai']},
  {id: 'openclaw', name: 'OpenClaw', command: 'openclaw', aliases: ['clawdbot', 'moltbot'], packages: ['openclaw', 'clawdbot', 'moltbot']},
  {id: 'cagent', name: 'Docker Agent / cagent', command: 'cagent', aliases: ['docker-agent']},
  {id: 'qwen', name: 'Qwen Code', command: 'qwen', packages: ['@qwen-code/qwen-code']},
  {id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', packages: ['@github/copilot']},
  // The IDE's "cursor" launcher is not the Cursor Agent CLI.
  {id: 'cursor', name: 'Cursor Agent CLI', command: 'cursor-agent'},
  {id: 'amp', name: 'Amp', command: 'amp', packages: ['@sourcegraph/amp']},
  {id: 'goose', name: 'Goose', command: 'goose'},
  {id: 'aider', name: 'Aider', command: 'aider'},
  {id: 'droid', name: 'Factory Droid', command: 'droid'},
  {id: 'kilo', name: 'Kilo Code', command: 'kilo', aliases: ['kilocode'], packages: ['@kilocode/cli']},
  {id: 'codebuddy', name: 'CodeBuddy CLI', command: 'codebuddy', packages: ['@tencent-ai/codebuddy-code', '@tencent-ai/codebuddy']},
  {id: 'dsh', name: 'DeepSeek Harness CLI', command: 'dsh'},
  {id: 'lorca', name: 'Lorca CLI', command: 'lorca'},
  {id: 'aioncore', name: 'AionCore', command: 'aioncore'},
];

export function bundledAgentCandidates(definition, homeDir, applicationDirectories = ['/Applications', path.join(homeDir, 'Applications')]) {
  const candidates = [];
  for (const applications of applicationDirectories) {
    if (definition.id === 'codex') {
      for (const app of ['ChatGPT.app', 'Codex.app']) candidates.push(
        path.join(applications, app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
        path.join(applications, app, 'Contents/Resources/codex'));
    } else if (definition.id === 'dsh') candidates.push(path.join(applications, 'DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'));
    else if (definition.id === 'lorca') candidates.push(path.join(applications, 'Orbi Dev.app/Contents/Resources/bin/lorca'));
    else if (definition.id === 'aioncore') for (const architecture of ['darwin-arm64', 'darwin-x64']) candidates.push(path.join(applications, `Foundry.app/Contents/Resources/bundled-aioncore/${architecture}/aioncore`));
    else if (definition.id === 'cagent') candidates.push(path.join(applications, 'Docker.app/Contents/Resources/cli-plugins/docker-agent'));
  }
  if (definition.id === 'hermes') candidates.push(path.join(homeDir, '.hermes/hermes-agent/venv/bin/hermes'));
  if (definition.id === 'cagent') candidates.push(path.join(homeDir, '.docker/cli-plugins/docker-agent'));
  if (definition.id === 'cursor') candidates.push(path.join(homeDir, '.cursor-agent/bin/cursor-agent'), path.join(homeDir, '.cursor-agent/bin/agent'));
  if (definition.id === 'opencode') candidates.push(path.join(homeDir, '.opencode/bin/opencode'));
  if (definition.id === 'openclaw') candidates.push(path.join(homeDir, '.openclaw/bin/openclaw'));
  return candidates;
}

export async function staticAgentVersion(definition, executablePath) {
  // Only installed-package metadata is read, never provider/auth configuration.
  if (definition.id === 'hermes') {
    const root = path.dirname(path.dirname(path.dirname(executablePath)));
    try {
      const text = await readSmallText(path.join(root, 'pyproject.toml'));
      const project = text.split(/^\[project\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0] || '';
      if (/^name\s*=\s*["']hermes-agent["']/m.test(project)) return cleanVersion(project.match(/^version\s*=\s*["']([^"']+)["']/m)?.[1]);
    } catch { /* Some packaged installations do not retain pyproject.toml. */ }
  }
  if (definition.packages?.length) {
    let directory = path.dirname(executablePath);
    for (let depth = 0; depth < 7 && directory !== path.dirname(directory); depth += 1, directory = path.dirname(directory)) {
      try {
        const manifest = JSON.parse(await readSmallText(path.join(directory, 'package.json')));
        if (definition.packages.includes(manifest.name)) return cleanVersion(manifest.version);
      } catch { /* A binary or wrapper need not have an npm manifest. */ }
    }
  }
  if (definition.id === 'aioncore') {
    try { const manifest = JSON.parse(await readSmallText(path.join(path.dirname(executablePath), 'manifest.json'))); return cleanVersion(manifest.version); }
    catch { /* Public bundle metadata is optional. */ }
  }
  return '';
}

async function readSmallText(filePath) {
  const limit = 256 * 1024;
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('unsafe package metadata');
  // NOFOLLOW rejects a replaced symlink; NONBLOCK avoids blocking if a FIFO
  // replaces the regular file between lstat and open. Recheck the opened inode.
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > limit) throw new Error('unsafe package metadata');
    const buffer = Buffer.alloc(limit + 1);
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('package metadata too large');
    return buffer.subarray(0, bytesRead).toString('utf8');
  }
  finally { await file.close(); }
}
function cleanVersion(value) { return typeof value === 'string' && /^[0-9][0-9A-Za-z.+_-]{0,95}$/.test(value) ? value : ''; }
