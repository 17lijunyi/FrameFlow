import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {discoverLocalAgentInventory} from './local-agent-inventory.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, {force: true, recursive: true}))));
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'frameflow-agent-inventory-')));
  roots.push(root);
  const homeDir = path.join(root, 'home');
  const repoRoot = path.join(root, 'repo');
  const applicationDirectories = [path.join(root, 'Applications'), path.join(homeDir, 'Applications')];
  await Promise.all([homeDir, repoRoot, ...applicationDirectories].map((directory) => mkdir(directory, {recursive: true})));
  const manifests = new Map();
  const readApplicationInfo = vi.fn(async (file) => {
    if (!manifests.has(file)) throw new Error('unreadable');
    return manifests.get(file);
  });
  async function app(name, info, directory = applicationDirectories[0]) {
    const appPath = path.join(directory, name);
    await mkdir(path.join(appPath, 'Contents'), {recursive: true});
    manifests.set(path.join(appPath, 'Contents/Info.plist'), info);
    return appPath;
  }
  async function file(relative, content = 'private definition content') {
    const filePath = path.join(homeDir, relative);
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, content);
    return filePath;
  }
  const options = {homeDir, repoRoot, applicationDirectories, readApplicationInfo};
  return {root, homeDir, repoRoot, applicationDirectories, options, app, file, readApplicationInfo};
}

describe('local Agent application and definition inventory', () => {
  it('discovers renamed known Apps by public bundle identity, without claiming a model connection', async () => {
    const {options, app, readApplicationInfo} = await fixture();
    const cursorPath = await app('Renamed editor.app', {CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92', CFBundleDisplayName: 'Cursor', CFBundleShortVersionString: '3.2.1'});
    await app('Harness.app', {CFBundleIdentifier: 'com.deepseek.dsh', CFBundleName: 'DeepSeek Harness', CFBundleShortVersionString: '0.2.0-rc.2'});
    await app('Kimi.app', {CFBundleIdentifier: 'com.moonshot.kimichat.kmp.mac', CFBundleName: 'Kimi'});
    const result = await discoverLocalAgentInventory(options);
    expect(result.applications).toHaveLength(3);
    expect(result.applications.find(({name}) => name === 'Cursor')).toMatchObject({path: cursorPath, version: '3.2.1', kind: 'ide'});
    expect(result.applications.every(({statusMessage}) => /尚未|不代表/.test(statusMessage))).toBe(true);
    expect(readApplicationInfo.mock.calls.every(([file]) => file.endsWith('Contents/Info.plist'))).toBe(true);
  });

  it('excludes unrelated Apps, web wrappers and packaged agent plugins', async () => {
    const {options, app, applicationDirectories} = await fixture();
    await app('DeepSeek.app', {CFBundleIdentifier: 'com.apple.Safari.WebApp.test', CFBundleName: 'DeepSeek'});
    await app('Claude.app', {CFBundleIdentifier: 'com.apple.Safari.WebApp.other'});
    await app('Text Editor.app', {CFBundleIdentifier: 'example.editor'});
    await mkdir(path.join(applicationDirectories[0], 'Foundry.app/Contents/Resources/aionext-codex.zip'), {recursive: true});
    const result = await discoverLocalAgentInventory(options);
    expect(result.applications.map(({name}) => name)).toEqual(['Foundry']);
    expect(result.customAgents).toEqual([]);
    expect(result.scanWarnings.some((message) => message.includes('Foundry.app'))).toBe(true);
  });

  it('does not classify an unrelated bundle solely from a known App filename', async () => {
    const {options, app} = await fixture();
    await app('Claude.app', {CFBundleIdentifier: 'example.ordinary.editor', CFBundleName: 'Ordinary editor'});
    expect((await discoverLocalAgentInventory(options)).applications).toEqual([]);
  });

  it('keeps scanning after malformed public plist metadata', async () => {
    const {options, app} = await fixture();
    await app('Claude.app', null);
    await app('Cursor.app', []);
    await app('Kimi.app', {CFBundleIdentifier: 'com.moonshot.kimichat.kmp.mac', CFBundleName: 'Kimi', CFBundleShortVersionString: '2.1'});
    const result = await discoverLocalAgentInventory(options);
    expect(result.applications.find(({name}) => name === 'Kimi')).toMatchObject({version: '2.1'});
    expect(result.scanWarnings).toHaveLength(2);
  });

  it('accepts bounded public metadata larger than 16 KiB', async () => {
    const f = await fixture();
    const appPath = await f.app('Cursor.app', {});
    await writeFile(path.join(appPath, 'Contents/Info.plist'), 'public plist');
    const publicInfo = {CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92', CFBundleName: 'Cursor', CFBundleShortVersionString: '3.23', publicDocumentTypes: 'x'.repeat(20_000)};
    const runCommand = vi.fn(async () => ({exitCode: 0, stdout: JSON.stringify(publicInfo)}));
    const {readApplicationInfo: ignored, ...options} = f.options;
    const result = await discoverLocalAgentInventory({...options, runCommand});
    expect(result.applications[0]).toMatchObject({name: 'Cursor', version: '3.23'});
    expect(runCommand).toHaveBeenCalledWith('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path.join(appPath, 'Contents/Info.plist')], expect.objectContaining({timeoutMs: 1500, maxOutputBytes: 128 * 1024}));
    expect(result.scanWarnings).toEqual([]);
  });

  it('never follows public plist links outside their App bundle or launches an App executable', async () => {
    const f = await fixture();
    const appPath = await f.app('Foundry.app', {});
    const outside = await f.file('outside.plist', 'PRIVATE_CONFIG_BODY');
    await symlink(outside, path.join(appPath, 'Contents/Info.plist'));
    const runCommand = vi.fn();
    const {readApplicationInfo: ignored, ...options} = f.options;
    const result = await discoverLocalAgentInventory({...options, runCommand});
    expect(runCommand).not.toHaveBeenCalled();
    expect(result.scanWarnings.some((message) => message.includes('Foundry.app'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CONFIG_BODY');
  });

  it('deduplicates application symlinks and preserves the same product installed twice', async () => {
    const {options, app, applicationDirectories} = await fixture();
    const info = {CFBundleIdentifier: 'com.deepseek.dsh', CFBundleName: 'DeepSeek Harness'};
    const first = await app('DeepSeek Harness.app', info);
    await symlink(first, path.join(applicationDirectories[1], 'Alias.app'));
    await app('DeepSeek Harness.app', info, applicationDirectories[1]);
    const result = await discoverLocalAgentInventory(options);
    expect(result.applications).toHaveLength(2);
    expect(new Set(result.applications.map(({id}) => id)).size).toBe(2);
  });

  it('does not let an unreadable unknown alias hide a known installation', async () => {
    const f = await fixture();
    const appPath = await f.app('Foundry.app', null);
    await symlink(appPath, path.join(f.applicationDirectories[0], '00 Alias.app'));
    await symlink(await f.file('ordinary-file', 'not an App'), path.join(f.applicationDirectories[0], 'Claude.app'));
    const result = await discoverLocalAgentInventory(f.options);
    expect(result.applications.map(({name}) => name)).toEqual(['Foundry']);
  });

  it('lists custom definition names and profiles without reading secrets or counting skills and instructions', async () => {
    const {options, homeDir, repoRoot, file} = await fixture();
    await file('.claude/agents/director.md', 'AUTH_TOKEN=must-never-be-returned');
    await file('.codex/agents/planner.toml');
    await file('.cursor/agents/creative/reviewer.md');
    await file('.claude/agents/AGENTS.md');
    await file('.claude/agents/CLAUDE.md');
    await file('.claude/agents/SKILL.md');
    await file('.claude/agents/SOUL.md');
    await file('.claude/agents/README.zh-CN.md');
    await file('.claude/agents/skills/animation/SKILL.md');
    await file('.claude/agents/instructions/overview.md');
    await file('.claude/skills/not-an-agent/SKILL.md');
    await file('.openclaw/workspace/SOUL.md');
    await file('.openclaw/agents/main/agent/models.json', 'PRIVATE_MODEL_CONFIG');
    await file('.openclaw/agents/main/sessions/session.json');
    await file('.hermes/profiles/film/config.yaml', 'PRIVATE_HERMES_CONFIG');
    await mkdir(path.join(repoRoot, '.opencode/agents'), {recursive: true});
    await writeFile(path.join(repoRoot, '.opencode/agents/scriptwriter.md'), 'PRIVATE_SCRIPTWRITER');
    const result = await discoverLocalAgentInventory(options);
    expect(result.customAgents.map(({name}) => name).sort()).toEqual(['creative/reviewer', 'director', 'film', 'main', 'planner', 'scriptwriter']);
    expect(result.customAgents.filter(({kind}) => kind === 'profile')).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/must-never-be-returned|PRIVATE_/);
    expect(result.scanLocations).toContain(path.join(homeDir, '.claude/agents'));
    expect(result.scanLocations).not.toContain(path.join(homeDir, '.claude/skills'));
  });

  it('bounds definition scans and reports a partial scan', async () => {
    const {options, file} = await fixture();
    await Promise.all(Array.from({length: 205}, (_, index) => file(`.claude/agents/agent-${String(index).padStart(3, '0')}.md`)));
    const result = await discoverLocalAgentInventory(options);
    expect(result.customAgents).toHaveLength(200);
    expect(result.scanWarnings.some((message) => message.includes('上限'))).toBe(true);
  });

  it('does not traverse nested directory symlinks or read broken definition links', async () => {
    const {options, homeDir, file} = await fixture();
    await file('.cursor/agents/director.md');
    await symlink(path.join(homeDir, '.cursor/agents'), path.join(homeDir, '.cursor/agents/loop'));
    await symlink('/nonexistent/frameflow-agent.md', path.join(homeDir, '.cursor/agents/missing.md'));
    const result = await discoverLocalAgentInventory(options);
    expect(result.customAgents.map(({name}) => name)).toEqual(['director']);
  });
});
