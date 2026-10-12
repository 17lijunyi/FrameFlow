import {useEffect, useState} from 'react';
import {Blocks, LoaderCircle, Monitor, RefreshCw, Terminal} from 'lucide-react';
import {checkLocalAgent, getLocalAgents, scanLocalAgents, testLocalAgentConnection} from './api';
import {localizeRuntimeText} from './events';
import {
  additionalLocalAgentInstallations,
  formatLocalAgentTime,
  groupLocalAgents,
  LOCAL_AGENT_AUTH_LABELS,
  LOCAL_AGENT_INTERFACE_LABELS,
  LOCAL_AGENT_OPTIONS,
  localAgentCommand,
  localAgentSupportsConnection,
  localAgentTestAvailability,
  mergeLocalAgentResult,
  validateLocalAgentPath,
} from './localAgents';
import type {CustomLocalAgent, LocalAgent, LocalAgentApplication, LocalAgentId, LocalAgentsSnapshot} from './types';

type LocalAgentOperation = {kind: 'scan' | 'manual' | 'check' | 'test'; agentId?: LocalAgentId};

export default function LocalAgentsSettings() {
  const [snapshot, setSnapshot] = useState<LocalAgentsSnapshot>({checkedAt: '', agents: []});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<LocalAgentOperation>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [manualAgentId, setManualAgentId] = useState<LocalAgentId>('codex');
  const [manualPath, setManualPath] = useState('');
  const disabled = loading || Boolean(busy);
  const grouped = groupLocalAgents(snapshot.agents);
  const applications = snapshot.applications || [];
  const customAgents = snapshot.customAgents || [];

  useEffect(() => {
    let cancelled = false;
    void getLocalAgents()
      .then((result) => !cancelled && setSnapshot(result))
      .catch((reason) => !cancelled && setError(errorMessage(reason)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  async function scan(manual = false) {
    if (disabled) return;
    if (manual) {
      const validation = validateLocalAgentPath(manualPath);
      if (validation) { setError(validation); return; }
    }
    setBusy({kind: manual ? 'manual' : 'scan'});
    setError('');
    setFeedback('');
    try {
      const result = await scanLocalAgents(manual ? {agentId: manualAgentId, executablePath: manualPath.trim()} : {});
      setSnapshot(result);
      setFeedback(manual ? '已检测指定安装路径。' : '本地 Agent 检测已完成。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  }

  async function inspect(agent: LocalAgent, kind: 'check' | 'test') {
    if (disabled || !agent.installed) return;
    if (kind === 'test' && !localAgentTestAvailability(agent).enabled) return;
    setBusy({kind, agentId: agent.id});
    setError('');
    setFeedback('');
    try {
      const result = await (kind === 'check' ? checkLocalAgent(agent.id) : testLocalAgentConnection(agent.id));
      setSnapshot((current) => mergeLocalAgentResult(current, result.agent));
      setFeedback(kind === 'check' ? `${agent.name} ${localAgentSupportsConnection(agent) ? '接口' : '安装'}检查已完成。` : `${agent.name} 连接测试已完成，请查看结果。`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="local-agents-settings" aria-labelledby="local-agents-title" aria-busy={disabled}>
      <header>
        <div>
          <h2 id="local-agents-title">本地 Agent</h2>
          <p>识别本地命令行工具、桌面与 IDE 应用、自定义 Agent。发现安装不代表已连接或已接入创作流程，可与下方模型 API 配置并用。</p>
        </div>
        <button type="button" className="local-agents-rescan" onClick={() => void scan()} disabled={disabled}>
          {busy?.kind === 'scan' ? <LoaderCircle className="local-agent-spinner" size={14} /> : <RefreshCw size={14} />}
          {busy?.kind === 'scan' ? '正在检测…' : '重新检测'}
        </button>
      </header>
      <p className="local-agent-operation-note">安装与接口检查不调用模型。连接测试目前支持 Codex、Claude、Gemini，会运行简短任务并消耗对应额度。Codex 测试使用已有登录和默认服务。</p>
      {loading ? (
        <div className="local-agents-loading" role="status"><LoaderCircle className="local-agent-spinner" size={16} />正在检测本地 Agent…</div>
      ) : (
        <>
          <section className="local-agent-group" aria-labelledby="local-agent-cli-title">
            <header><h3 id="local-agent-cli-title">命令行 Agent</h3><span>已发现 {grouped.installed.length} 种工具</span></header>
            {grouped.installed.length ? <div className="local-agent-grid">{grouped.installed.map((agent) => <LocalAgentCard key={agent.id} agent={agent} busy={busy} disabled={disabled} onInspect={(kind) => void inspect(agent, kind)} />)}</div> : <p className="local-agent-group-empty">本次未发现命令行 Agent。可重新检测，或在下方指定安装路径。</p>}
            {grouped.missing.length > 0 && <details className="local-agent-missing"><summary>尚未检测到（{grouped.missing.length}）</summary><div className="local-agent-grid">{grouped.missing.map((agent) => <LocalAgentCard key={agent.id} agent={agent} busy={busy} disabled={disabled} onInspect={(kind) => void inspect(agent, kind)} />)}</div></details>}
          </section>
          <section className="local-agent-group" aria-labelledby="local-agent-app-title">
            <header><h3 id="local-agent-app-title">桌面与 IDE 应用</h3><span>已发现 {applications.length} 个</span></header>
            {applications.length ? <div className="local-agent-discovery-list">{applications.map((application) => <LocalApplicationRow key={`${application.id}-${application.path}`} application={application} />)}</div> : <p className="local-agent-group-empty">本次未发现桌面或 IDE 应用。</p>}
            <p className="local-agent-group-note">这里只确认应用安装；桌面应用与同名命令行工具分别识别。</p>
          </section>
          <section className="local-agent-group" aria-labelledby="local-agent-custom-title">
            <header><h3 id="local-agent-custom-title">自定义 Agent</h3><span>已发现 {customAgents.length} 个</span></header>
            {customAgents.length ? <div className="local-agent-discovery-list">{customAgents.map((agent) => <CustomAgentRow key={`${agent.id}-${agent.path}`} agent={agent} />)}</div> : <p className="local-agent-group-empty">本次未发现自定义 Agent 定义或运行配置。</p>}
            <p className="local-agent-group-note">发现定义或配置不代表 Agent 正在运行，连接方式仍需确认。</p>
          </section>
        </>
      )}
      <details className="local-agent-manual">
        <summary>手动指定安装路径</summary>
        <p>自动检测未找到时，指定已安装程序的绝对路径。</p>
        <form onSubmit={(event) => { event.preventDefault(); void scan(true); }}>
          <label><span>Agent 类型</span><select value={manualAgentId} onChange={(event) => setManualAgentId(event.target.value as LocalAgentId)} disabled={disabled}>{LOCAL_AGENT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}（{option.command}）</option>)}</select></label>
          <label className="local-agent-path-field"><span>安装路径</span><input value={manualPath} onChange={(event) => { setManualPath(event.target.value); setError(''); }} placeholder={`例如 /opt/homebrew/bin/${localAgentCommand(manualAgentId)}`} autoComplete="off" spellCheck={false} disabled={disabled} /></label>
          <button type="submit" disabled={disabled}>{busy?.kind === 'manual' ? '正在检测…' : '检测此路径'}</button>
        </form>
      </details>
      {((snapshot.scanLocations || []).length > 0 || (snapshot.scanWarnings || []).length > 0) && <details className="local-agent-scan-scope"><summary>检测范围与提示{snapshot.scanWarnings?.length ? `（${snapshot.scanWarnings.length} 条提示）` : ''}</summary>{snapshot.scanWarnings?.map((warning, index) => <p className="local-agent-scan-warning" key={index}>{localizeRuntimeText(warning)}</p>)}{snapshot.scanLocations?.length ? <><p>本次检查以下位置；检测结果不保证覆盖全部安装方式。</p><ul>{snapshot.scanLocations.map((location) => <li key={location}>{location}</li>)}</ul></> : null}</details>}
      <div className="local-agents-feedback" aria-live="polite">
        {error ? <p className="is-error" role="alert">{error}</p> : feedback ? <p role="status">{feedback}</p> : null}
        {snapshot.checkedAt && <span>最近检测：<time dateTime={snapshot.checkedAt}>{formatLocalAgentTime(snapshot.checkedAt)}</time></span>}
      </div>
    </section>
  );
}

function LocalAgentCard({agent, busy, disabled, onInspect}: {
  agent: LocalAgent;
  busy?: LocalAgentOperation;
  disabled: boolean;
  onInspect: (kind: 'check' | 'test') => void;
}) {
  const availability = localAgentTestAvailability(agent);
  const supportsConnection = localAgentSupportsConnection(agent);
  const extraInstallations = additionalLocalAgentInstallations(agent);
  const operation = busy?.agentId === agent.id ? busy.kind : undefined;
  return (
    <article className={`local-agent-card ${supportsConnection ? '' : 'discovery-only'}`}>
      <header><h3><Terminal size={16} />{agent.name}</h3><span className={agent.installed ? 'is-installed' : ''}>{agent.installed ? '已安装' : '未检测到'}</span></header>
      <dl>
        <div><dt>安装路径</dt><dd className="local-agent-executable">{agent.executablePath || '未找到'}</dd></div>
        <div><dt>版本</dt><dd>{agent.version || '未确认'}</dd></div>
        {supportsConnection ? <><div><dt>登录状态</dt><dd>{LOCAL_AGENT_AUTH_LABELS[agent.authStatus]}</dd></div><div><dt>接口支持</dt><dd>{LOCAL_AGENT_INTERFACE_LABELS[agent.interfaceStatus]}</dd></div></> : <div><dt>连接适配</dt><dd>尚未验证</dd></div>}
      </dl>
      {extraInstallations.length > 0 && <details className="local-agent-installations"><summary>另有 {extraInstallations.length} 个安装位置</summary><ul>{extraInstallations.map((installation) => <li key={installation.path}><span>{installation.path}</span>{installation.version && <small>版本：{installation.version}</small>}</li>)}</ul></details>}
      {supportsConnection ? <p className="local-agent-capabilities">简短任务：{agent.capabilities.headless ? '支持' : '未确认支持'} · 结构化输出：{agent.capabilities.structuredOutput ? '支持' : '未确认支持'}</p> : <p className="local-agent-capabilities">当前仅识别安装，尚未适配连接测试。</p>}
      <p className="local-agent-status-message">{localizeRuntimeText(agent.statusMessage)}</p>
      {supportsConnection && agent.lastTest && (
        <div className={`local-agent-test-result ${agent.lastTest.status === 'passed' ? 'is-passed' : 'is-failed'}`}>
          <strong>上次连接测试：{agent.lastTest.status === 'passed' ? '已通过' : '未通过'}</strong>
          <p>{localizeRuntimeText(agent.lastTest.message)}</p>
          <time dateTime={agent.lastTest.checkedAt}>{formatLocalAgentTime(agent.lastTest.checkedAt)}</time>
        </div>
      )}
      <div className="local-agent-actions">
        <button type="button" onClick={() => onInspect('check')} disabled={disabled || !agent.installed} aria-label={`检查 ${agent.name} ${supportsConnection ? '接口' : '安装'}`}>{operation === 'check' ? '正在检查…' : supportsConnection ? '检查接口' : '检查安装'}</button>
        {supportsConnection && <button type="button" onClick={() => onInspect('test')} disabled={disabled || !availability.enabled} title={availability.reason} aria-label={`测试 ${agent.name} 连接，运行简短任务并消耗额度`}>{operation === 'test' ? '正在测试…' : '测试连接'}</button>}
      </div>
      {supportsConnection && !availability.enabled && agent.installed && <p className="local-agent-test-hint">{availability.reason}</p>}
    </article>
  );
}

function LocalApplicationRow({application}: {application: LocalAgentApplication}) {
  const kind = {desktop: '桌面应用', ide: 'IDE 应用', assistant: '助手应用'}[application.kind];
  return <article className="local-agent-discovery-row"><span className="local-agent-discovery-icon"><Monitor size={15} /></span><div className="local-agent-discovery-content"><div className="local-agent-discovery-title"><h4>{application.name}</h4><span className="local-agent-discovery-badge is-found">已发现</span></div><p>{kind}{application.version ? ` · ${application.version}` : ' · 版本未确认'}</p><p className="local-agent-discovery-path">{application.path}</p><p>{localizeRuntimeText(application.statusMessage || '已发现应用安装，尚未验证连接方式。')}</p></div></article>;
}

function CustomAgentRow({agent}: {agent: CustomLocalAgent}) {
  return <article className="local-agent-discovery-row"><span className="local-agent-discovery-icon"><Blocks size={15} /></span><div className="local-agent-discovery-content"><div className="local-agent-discovery-title"><h4>{agent.name}</h4><span className="local-agent-discovery-badge">连接未验证</span></div><p>{agent.source}{agent.source ? ' · ' : ''}{agent.kind === 'definition' ? 'Agent 定义' : '运行配置'}</p><p className="local-agent-discovery-path">{agent.path}</p><p>{localizeRuntimeText(agent.statusMessage || '已发现自定义配置，尚未确认运行与连接状态。')}</p></div></article>;
}

function errorMessage(reason: unknown): string {
  return localizeRuntimeText(reason instanceof Error ? reason.message : String(reason));
}
