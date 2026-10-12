import {Fragment, useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Check, ChevronRight, Eye, Film, Image as ImageIcon, LoaderCircle, RefreshCw, Sparkles, X} from 'lucide-react';
import {
  createExecutorSelection, effectiveExecutorId, EXECUTOR_GENERATION_LABELS, EXECUTOR_IMAGE_LABELS,
  executorApiSection, executorDraft, executorRoleStatus, getExecutors, orderedExecutorOptions,
  saveExecutorSelection, scanExecutors, updateExecutorSelectionConfig, validateExecutorSelection,
} from './executors';
import type {ExecutorImageGeneration, ExecutorImageInput, ExecutorOption, ExecutorRole, ExecutorSelectionDraft, ExecutorSnapshot} from './executors';
import type {AgentConfig, ConfigSection} from './types';
import './executors.css';

type ApiSection = 'llm' | 'image' | 'video';
type Props = {
  config?: AgentConfig; configLoading: boolean; configError?: string;
  managementSaving?: boolean;
  assistantExtra?: ReactNode;
  renderApiEditor: (section: ApiSection, draft: ConfigSection, onChange: (field: keyof ConfigSection, value: string) => void, disabled: boolean) => ReactNode;
  onSelectionSaved: (config: AgentConfig, touchedSection?: ApiSection) => void;
  focusRole?: ExecutorRole; focusRequest?: number;
};
const titles: Record<ExecutorRole, string> = {assistant: '创作助手', image: '图像生成', video: '视频生成', script: '剧本策划', storyboard: '分镜提示词', vision: '看图与审片'};
const descriptions: Record<ExecutorRole, string> = {assistant: '对话、剧本与分镜', image: '图像 API 或 Agent 生图工具', video: '视频服务 API', script: '故事结构与剧情', storyboard: '镜头描述与画面提示词', vision: '用到图片时确认看图能力'};
const mainRoles: ExecutorRole[] = ['assistant', 'image', 'video'];
const professionalRoles: ExecutorRole[] = ['script', 'storyboard', 'vision'];
function optionName(option?: ExecutorOption) {
  if (!option) return '未检测到';
  return option.id === 'api' ? '模型 API' : option.id === 'image_api' ? '图像 API' : option.id === 'video_api' ? '视频 API' : option.name;
}
function executableForRole(option: ExecutorOption, role: ExecutorRole) {
  return option.adapterAvailable && option.available && (role !== 'image' || option.kind === 'api' || option.imageGenerationTransport) && (role !== 'vision' || option.imageTransport);
}
function failureMessage(reason: unknown) {
  const message = reason instanceof Error ? reason.message : '保存失败，请稍后重试。';
  const sections: Record<string, string> = {llm: '创作助手', image: '图像生成', video: '视频生成'};
  const fields: Record<string, string> = {base_url: '服务地址', api_key: '密钥', api_provider: '接口平台', model_provider: '模型提供方', model: '模型名称'};
  return message.replace(/\b(llm|image|video)\.(base_url|api_key|api_provider|model_provider|model)\b/g, (_, section: string, field: string) => `${sections[section]}${fields[field]}`);
}

export default function ExecutorSettings({config, configLoading, configError, managementSaving = false, assistantExtra, renderApiEditor, onSelectionSaved, focusRole, focusRequest}: Props) {
  const [snapshot, setSnapshot] = useState<ExecutorSnapshot>();
  const [selection, setSelection] = useState<ExecutorSelectionDraft>();
  const [busy, setBusy] = useState<'load' | 'scan' | 'save' | 'refresh' | ''>('load');
  const [error, setError] = useState('');
  const [panelError, setPanelError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [professionalOpen, setProfessionalOpen] = useState(false);
  const mounted = useRef(false);
  const lifecycle = useRef(0);
  const operation = useRef(true);
  const pendingRefresh = useRef(false);
  const snapshotRef = useRef<ExecutorSnapshot>();
  const panel = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const openPanelRef = useRef<(role: ExecutorRole) => void>(() => {});
  const handledFocus = useRef<number>();

  function apply(next: ExecutorSnapshot) { snapshotRef.current = next; setSnapshot(next); }
  async function refresh(scan = false) {
    if (!mounted.current) return;
    if (operation.current) { if (!scan) pendingRefresh.current = true; return; }
    const context = lifecycle.current;
    operation.current = true; setBusy(scan ? 'scan' : 'refresh'); setError('');
    try {
      const result = scan ? await scanExecutors() : await getExecutors();
      if (mounted.current && context === lifecycle.current) { apply(result); if (scan) setFeedback('检测已更新。'); }
    } catch (reason) {
      if (mounted.current && context === lifecycle.current) setError(failureMessage(reason));
    } finally { if (mounted.current && context === lifecycle.current) finish(); }
  }
  function finish() {
    operation.current = false; saving.current = false; setBusy('');
    if (pendingRefresh.current) { pendingRefresh.current = false; void refresh(); }
  }
  useEffect(() => {
    mounted.current = true; operation.current = true;
    const context = ++lifecycle.current;
    const configSaved = () => { void refresh(); };
    window.addEventListener('frameflow:model-config-saved', configSaved);
    void getExecutors().then((result) => {
      if (mounted.current && context === lifecycle.current) apply(result);
    }).catch((reason) => {
      if (mounted.current && context === lifecycle.current) setError(failureMessage(reason));
    }).finally(() => { if (mounted.current && context === lifecycle.current) finish(); });
    return () => { mounted.current = false; lifecycle.current += 1; window.removeEventListener('frameflow:model-config-saved', configSaved); };
  }, []);

  function openPanel(role: ExecutorRole) {
    const current = snapshotRef.current;
    if (!current || operation.current || managementSaving) return;
    if (professionalRoles.includes(role)) setProfessionalOpen(true);
    setSelection(createExecutorSelection(current, role, current.roles[role], config));
    setShowAll(false); setPanelError(''); setFeedback('');
  }
  openPanelRef.current = openPanel;
  useEffect(() => {
    if (!focusRole || !snapshot || busy || managementSaving || !focusRequest || handledFocus.current === focusRequest) return;
    handledFocus.current = focusRequest;
    openPanelRef.current(focusRole);
  }, [focusRole, focusRequest, snapshot, busy, managementSaving]);
  useEffect(() => {
    if (!config || !snapshot) return;
    setSelection((current) => {
      if (!current || current.config || !executorApiSection(snapshot.options.find((item) => item.id === current.executorId))) return current;
      return {...current, config: createExecutorSelection(snapshot, current.role, current.executorId, config).config};
    });
  }, [config, snapshot]);

  const panelOpen = !!selection;
  useEffect(() => {
    if (!panelOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('.executor-dialog-close')?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { if (!saving.current) { event.preventDefault(); setSelection(undefined); setPanelError(''); } return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')).filter((element) => {
        if (!element.getClientRects().length) return false;
        for (let ancestor = element.parentElement; ancestor && ancestor !== panel.current; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(':scope > summary')?.contains(element)) return false;
        }
        return true;
      });
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKey); previousFocus?.focus(); };
  }, [panelOpen]);

  function choose(id: string) {
    if (!snapshot || !selection || operation.current || managementSaving) return;
    setSelection(createExecutorSelection(snapshot, selection.role, id, config)); setPanelError('');
  }
  function close() { if (!saving.current) { setSelection(undefined); setPanelError(''); } }
  async function save() {
    if (!snapshot || !selection || operation.current || managementSaving) return;
    const validation = validateExecutorSelection(snapshot, selection);
    if (validation) { setPanelError(validation); return; }
    const section = executorApiSection(snapshot.options.find((item) => item.id === selection.executorId));
    if (section && (configLoading || configError || !selection.config)) { setPanelError(configError || '接口配置尚未载入，请稍后重试。'); return; }
    const context = lifecycle.current;
    operation.current = true; saving.current = true; setBusy('save'); setPanelError('');
    try {
      const result = await saveExecutorSelection(snapshot, selection);
      if (!mounted.current || context !== lifecycle.current) return;
      apply(result.executors); onSelectionSaved(result.config, section);
      setSelection(undefined); setFeedback(`${titles[selection.role]}已更新。`);
    } catch (reason) { if (mounted.current && context === lifecycle.current) setPanelError(failureMessage(reason)); }
    finally { if (mounted.current && context === lifecycle.current) finish(); }
  }

  function roleRow(role: ExecutorRole) {
    if (!snapshot) return null;
    const option = snapshot.options.find((item) => item.id === effectiveExecutorId(role, snapshot.roles));
    const status = executorRoleStatus(role, snapshot, executorDraft(snapshot));
    const inherited = snapshot.roles[role] === 'inherit';
    const Icon = role === 'assistant' ? Sparkles : role === 'image' ? ImageIcon : role === 'video' ? Film : role === 'vision' ? Eye : ChevronRight;
    return <div key={role} className={`executor-summary-row ${mainRoles.includes(role) ? 'is-main' : ''}`} data-role={role}>
      <span className="executor-summary-icon"><Icon size={18} /></span>
      <div className="executor-summary-title"><h3>{titles[role]}</h3><p>{descriptions[role]}</p></div>
      <div className="executor-summary-selection"><strong>{inherited ? '跟随创作助手' : optionName(option)}</strong><small className={`is-${status.tone}`}>{inherited ? `当前：${optionName(option)}` : option?.kind === 'api' && status.tone === 'ready' ? option.model || status.label : status.label}</small></div>
      <button type="button" className="executor-button" aria-label={`更换${titles[role]}`} disabled={!!busy || managementSaving} onClick={() => openPanel(role)}>更换<ChevronRight size={13}/></button>
    </div>;
  }

  const selectedOption = snapshot?.options.find((item) => item.id === selection?.executorId);
  const apiSection = executorApiSection(selectedOption);
  const options = selection && snapshot ? orderedExecutorOptions(selection.role, snapshot.options) : [];
  const visibleOptions = options.filter((option) => showAll || option.kind === 'api' || executableForRole(option, selection!.role) || option.id === selection?.executorId);
  const hiddenCount = options.length - visibleOptions.length;
  const panelDisabled = !!busy || managementSaving;
  return <section className="executor-settings" aria-labelledby="executor-settings-title" aria-busy={!!busy}>
    <header className="executor-settings-header"><div><h2 id="executor-settings-title">创作配置</h2><p>选好三个执行者，即可开始创作。</p></div><button type="button" className="executor-button executor-rescan" disabled={!!busy || panelOpen || managementSaving} onClick={() => void refresh(true)}>{busy === 'scan' ? <LoaderCircle className="executor-spinner" size={14}/> : <RefreshCw size={14}/>}重新检测</button></header>
    {!snapshot ? <div className="executor-loading" role="status">{busy ? <><LoaderCircle size={16} className="executor-spinner"/>正在读取设置…</> : '读取失败，请重新检测。'}</div> : <>
      <div className={`executor-main-choices ${assistantExtra ? 'has-assistant-extra' : ''}`}>{mainRoles.map((role) => <Fragment key={role}>{roleRow(role)}{role === 'assistant' && assistantExtra}</Fragment>)}</div>
      <details className="executor-professional" open={professionalOpen} onToggle={(event) => setProfessionalOpen(event.currentTarget.open)}><summary>专业分工<small>剧本 · 分镜 · 审图</small></summary><p>需要时单独更换；剧本和分镜默认跟随创作助手。</p><div>{professionalRoles.map(roleRow)}</div></details>
    </>}
    {(error || feedback) && <div className={`executor-feedback ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || feedback}</div>}
    {selection && snapshot && createPortal(<div className="executor-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="executor-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby="executor-dialog-title" aria-busy={panelDisabled}>
      <header className="executor-dialog-header"><div><h2 id="executor-dialog-title">更换{titles[selection.role]}</h2><p>{selection.role === 'video' ? '选择视频服务 API。' : '选择 API 或本地 Agent。'}</p></div><button type="button" className="executor-dialog-close" aria-label="关闭选择面板" disabled={panelDisabled} onClick={close}><X size={18}/></button></header>
      <div className="executor-dialog-body"><fieldset className="executor-options" disabled={panelDisabled}><legend className="sr-only">{titles[selection.role]}执行者</legend>
        {(selection.role === 'script' || selection.role === 'storyboard') && <label className={`executor-option ${selection.executorId === 'inherit' ? 'is-selected' : ''}`}><input type="radio" name="executor-choice" value="inherit" checked={selection.executorId === 'inherit'} onChange={() => choose('inherit')}/><span><strong>跟随创作助手</strong><small>{optionName(snapshot.options.find((item) => item.id === snapshot.roles.assistant))}</small></span>{selection.executorId === 'inherit' && <Check size={16}/>}</label>}
        {visibleOptions.map((option) => <label key={option.id} className={`executor-option ${option.id === selection.executorId ? 'is-selected' : ''}`}><input type="radio" name="executor-choice" value={option.id} checked={option.id === selection.executorId} onChange={() => choose(option.id)}/><span><strong>{optionName(option)}</strong><small>{option.kind === 'api' ? '填写模型与密钥' : executableForRole(option, selection.role) ? '使用 Agent 自身配置' : !option.adapterAvailable || (selection.role === 'image' && !option.imageGenerationTransport) ? '待适配 · 可保存选择' : '未就绪 · 请检查安装与登录'}</small></span>{option.id === selection.executorId && <Check size={16}/>}</label>)}
      </fieldset>
      {(hiddenCount > 0 || showAll) && <button type="button" className="executor-show-all" disabled={panelDisabled} aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? '收起其他检测结果' : `查看全部检测结果（另 ${hiddenCount} 项）`}</button>}
      {selectedOption && selectedOption.kind !== 'api' && !executableForRole(selectedOption, selection.role) && <p className="executor-panel-note">该 Agent 尚不能在此环节自动执行。可保留选择，接入就绪后再使用。</p>}
      {apiSection && <div className="executor-api-editor">{selection.config ? renderApiEditor(apiSection, selection.config, (field, value) => { setSelection((current) => current?.config ? updateExecutorSelectionConfig(current, {...current.config, [field]: value}) : current); setPanelError(''); }, panelDisabled) : <p role="status">正在读取接口配置…</p>}{configError && <p className="executor-panel-error" role="alert">{configError}</p>}</div>}
      {selection.role === 'image' && selectedOption?.kind === 'cli' && <div className="executor-capability"><label htmlFor="executor-image-tools">这个 Agent 能通过工具生图吗？</label><select id="executor-image-tools" value={selection.imageGeneration || 'unknown'} disabled={panelDisabled} onChange={(event) => { setSelection({...selection, imageGeneration: event.target.value as ExecutorImageGeneration}); setPanelError(''); }}>{(['unknown', 'available', 'unavailable'] as const).map((value) => <option key={value} value={value}>{EXECUTOR_GENERATION_LABELS[value]}</option>)}</select><p>{selection.imageGeneration === 'available' ? '按你的确认使用其生图工具；工具可能另用 API。' : selection.imageGeneration === 'unavailable' ? '请选择其他 Agent 或图像 API。' : '可先保存，生成图片前需确认。看图能力与生图工具独立。'}</p></div>}
      {selection.role === 'vision' && selectedOption && <div className="executor-capability"><label htmlFor="executor-vision-input">当前模型能读取图片吗？</label><select id="executor-vision-input" value={selection.imageInput || 'unknown'} disabled={panelDisabled} onChange={(event) => { setSelection({...selection, imageInput: event.target.value as ExecutorImageInput}); setPanelError(''); }}>{(['unknown', 'vision', 'text_only'] as const).map((value) => <option key={value} value={value}>{EXECUTOR_IMAGE_LABELS[value]}</option>)}</select><p>{selection.imageInput === 'vision' ? '这是你对当前模型的确认；更换模型后需重新确认。' : selection.imageInput === 'text_only' ? '当前模型不能看图，请选择其他执行者。' : '不根据安装或登录状态推断视觉能力。用到图片前需确认。'}</p></div>}
      {panelError && <p className="executor-panel-error" role="alert">{panelError}</p>}
      </div><footer className="executor-dialog-footer"><button type="button" className="executor-button" disabled={panelDisabled} onClick={close}>取消</button><button type="button" className="executor-button primary" disabled={panelDisabled || !!apiSection && (configLoading || !!configError || !selection.config)} onClick={() => void save()}>{busy === 'save' && <LoaderCircle className="executor-spinner" size={14}/>} {busy === 'save' ? '正在保存…' : '保存并使用'}</button></footer>
    </div></div>, document.body)}
  </section>;
}
