import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowDown, ArrowLeft, ArrowUp, Check, Download, Film, Loader2, Pause, Play, Plus, RefreshCw, Save, Scissors, Send, Square, Trash2, Undo2, X} from 'lucide-react';
import {scanLocalAgents, uploadWorkspaceFile} from './api';
import type {SessionSummary} from './types';
import type {ExecutorOption} from './executors';
import {cancelVideoEditorJob, clearVideoEditorDraft, getVideoEditor, importVideoEditorSources, isVideoEditorJobActive, persistVideoEditorDraft, planVideoEditor, readVideoEditorDraft, refreshVideoEditorSourceMetadata, renderVideoEditor, saveVideoEditor, validateVideoEditorPlan, videoEditorDuration} from './videoEditor';
import type {VideoEditorFailure, VideoEditorJob, VideoEditorProject, VideoEditorSnapshot} from './videoEditor';
import CapsuleDock from './CapsuleDock';
import './videoEditor.css';

type Props = {session: SessionSummary; onBack: () => void; onArtifactsChanged: () => void};
const timeLabel = (seconds: number) => `${Number(seconds.toFixed(2))} 秒`;
const PREFERRED_AGENT = 'frameflow.video-editor.agent';
const playbackLabel = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;

export default function VideoEditorView({session, onBack, onArtifactsChanged}: Props) {
  const sessionId = session.sessionId;
  const [project, setProject] = useState<VideoEditorProject>();
  const [agents, setAgents] = useState<ExecutorOption[]>([]);
  const [jobs, setJobs] = useState<VideoEditorJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState<{message: string; code?: string}>();
  const [notice, setNotice] = useState('');
  const [recovery, setRecovery] = useState<VideoEditorProject>();
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [selectedSegment, setSelectedSegment] = useState(0);
  const [showOutput, setShowOutput] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [trim, setTrim] = useState<{index: number; start: string; end: string}>();
  const [undoCount, setUndoCount] = useState(0);
  const history = useRef<VideoEditorProject[]>([]);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const draftRef = useRef<VideoEditorProject>();
  const dirtyRef = useRef(false);
  const operationRef = useRef('');
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const artifactsChanged = useRef(onArtifactsChanged);
  artifactsChanged.current = onArtifactsChanged;
  const clearHistory = useCallback(() => { history.current = []; setUndoCount(0); setTrim(undefined); }, []);

  const putProject = useCallback((value: VideoEditorProject, changed: boolean) => {
    draftRef.current = value; dirtyRef.current = changed; setProject(value); setDirty(changed);
    if (changed && !persistVideoEditorDraft(value)) setError({message: '本地草稿暂时无法保留，请先保存再离开剪辑页面。'});
  }, []);
  const fail = useCallback((failure: unknown) => {
    const value = failure as VideoEditorFailure;
    setError({message: value?.message || '剪辑操作未完成，请稍后重试。', code: value?.code});
  }, []);
  const applySnapshot = useCallback((snapshot: VideoEditorSnapshot) => {
    setAgents(snapshot.agents || []); setJobs(snapshot.jobs || []); putProject(snapshot.project, false);
  }, [putProject]);
  const load = useCallback(async () => {
    const context = ++sequence.current; setLoading(true); setError(undefined);
    try {
      const snapshot = await getVideoEditor(sessionId);
      if (context !== sequence.current) return;
      applySnapshot(snapshot); setRecovery(undefined); clearHistory();
      const saved = readVideoEditorDraft(sessionId);
      if (saved && saved.revision === snapshot.project.revision) { putProject(refreshVideoEditorSourceMetadata(saved, snapshot.project), true); setNotice('已恢复上次未保存的编辑。'); }
      else if (saved) setRecovery(saved);
      if (!snapshot.project.agentId && !saved) {
        let preferred = ''; try { preferred = localStorage.getItem(PREFERRED_AGENT) || ''; } catch { /* Optional preference. */ }
        const choice = snapshot.agents.find((agent) => agent.id === preferred && agent.adapterAvailable && agent.available) || snapshot.agents.find((agent) => agent.adapterAvailable && agent.available);
        if (choice) putProject({...snapshot.project, agentId: choice.id}, true);
      }
    } catch (failure) { if (context === sequence.current) fail(failure); }
    finally { if (context === sequence.current) setLoading(false); }
  }, [sessionId, applySnapshot, putProject, fail, clearHistory]);
  useEffect(() => {
    draftRef.current = undefined; dirtyRef.current = false; operationRef.current = ''; setProject(undefined); setJobs([]); setNotice(''); setOperation(''); setRecovery(undefined); setSelectedSourceId(''); setSelectedSegment(0); setShowOutput(false); setPlaying(false); setPlaybackTime(0); clearHistory();
    void load(); return () => { sequence.current += 1; };
  }, [load, clearHistory]);
  useEffect(() => { if (error && contentRef.current) contentRef.current.scrollTop = 0; }, [error?.message]);
  const activeJob = jobs.find(isVideoEditorJobActive);
  const busy = !!operation || !!activeJob;
  useEffect(() => {
    if (!activeJob || loading) return;
    const context = sequence.current; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await getVideoEditor(sessionId);
        if (stopped || context !== sequence.current) return;
        if (dirtyRef.current) {
          setAgents(snapshot.agents); setJobs(snapshot.jobs);
          if (snapshot.project.revision !== draftRef.current?.revision) setError({message: '剪辑项目已在其他窗口更新。你的草稿已保留，请重新核对后保存。', code: 'revision_conflict'});
        } else applySnapshot(snapshot);
        if (!snapshot.jobs.some(isVideoEditorJobActive)) artifactsChanged.current();
      } catch { if (!stopped && context === sequence.current) setError({message: '任务状态暂时无法更新，稍后会继续检查。请勿重复启动任务。'}); }
      if (!stopped) timer = setTimeout(poll, 1800);
    };
    timer = setTimeout(poll, 800); return () => { stopped = true; clearTimeout(timer); };
  }, [!!activeJob, loading, sessionId, applySnapshot]);

  const edit = (update: (current: VideoEditorProject) => VideoEditorProject, changesInput = false) => {
    const current = draftRef.current; if (!current || busy) return;
    const next = update(current);
    if (next === current) return;
    history.current = [...history.current.slice(-39), current]; setUndoCount(history.current.length); setTrim(undefined);
    putProject({...next, planStale: changesInput && !!current.segments.length ? true : next.planStale, output: next.output ? {...next.output, stale: true} : undefined}, true);
    setNotice('');
  };
  const undo = () => {
    const current = draftRef.current, previous = history.current.at(-1); if (!current || !previous || busy) return;
    history.current.pop(); setUndoCount(history.current.length); setTrim(undefined);
    const metadata = new Map(current.sources.map((source) => [source.id, source]));
    const sources = previous.sources.map((source) => ({...(metadata.get(source.id) || source), description: source.description}));
    // Imported sources establish a new server plan fingerprint; an older plan must be rebuilt.
    const needsNewPlan = previous.revision !== current.revision && previous.segments.length > 0;
    // Keep the current server revision and rendered output; undo restores only editable inputs.
    putProject({...current, agentId: previous.agentId, instruction: previous.instruction, sources, segments: previous.segments.map((segment) => ({...segment})), planStale: needsNewPlan || previous.planStale || sources.some((source) => source.missing || source.stale), output: current.output ? {...current.output, stale: true} : undefined}, true);
    setSelectedSegment((index) => Math.min(index, previous.segments.length - 1));
    setNotice(needsNewPlan ? '已撤销素材变更，请重新生成剪辑方案。' : '已撤销上一步编辑。');
  };
  const runOperation = async (name: string, task: (context: number) => Promise<void>) => {
    if (operationRef.current) return;
    const context = sequence.current; operationRef.current = name; setOperation(name); setError(undefined); setNotice('');
    try { await task(context); }
    catch (failure) { if (context === sequence.current) fail(failure); }
    finally { if (context === sequence.current) { operationRef.current = ''; setOperation(''); } }
  };
  const saveCurrent = async (context: number) => {
    const current = draftRef.current; if (!current) return false;
    if (!dirtyRef.current) return true;
    const result = await saveVideoEditor(current);
    if (context !== sequence.current) return false;
    applySnapshot(result); clearVideoEditorDraft(sessionId); clearHistory();
    return true;
  };
  const save = () => runOperation('save', async (context) => { if (await saveCurrent(context)) setNotice('剪辑项目已保存。'); });
  const addSources = (files: File[]) => runOperation('upload', async (context) => {
    if (!files.length) return;
    if (files.length + (draftRef.current?.sources.length || 0) > 20) throw new Error('每个剪辑项目最多添加 20 个视频。');
    if (files.some((file) => !/\.(mp4|mov|webm)$/i.test(file.name))) throw new Error('请选择 MP4、MOV 或 WebM 视频。');
    if (!await saveCurrent(context)) return;
    const paths: string[] = [];
    for (const file of files) {
      const uploaded = await uploadWorkspaceFile(sessionId, file);
      if (context !== sequence.current) return;
      paths.push(uploaded.file.path);
    }
    const previous = draftRef.current!;
    const snapshot = await importVideoEditorSources(sessionId, previous.revision, paths);
    if (context !== sequence.current) return;
    history.current = [...history.current.slice(-39), previous]; setUndoCount(history.current.length); setTrim(undefined);
    applySnapshot(snapshot); artifactsChanged.current(); setNotice(`已添加 ${paths.length} 个视频，可填写剪辑要求。`);
  });
  const plan = () => runOperation('plan', async (context) => {
    if (!draftRef.current?.instruction.trim()) throw new Error('请先填写剪辑要求。');
    if (!await saveCurrent(context)) return;
    const snapshot = await planVideoEditor(sessionId, draftRef.current!.revision);
    if (context === sequence.current) { clearHistory(); applySnapshot(snapshot); setSelectedSourceId(''); setSelectedSegment(0); setShowOutput(false); }
  });
  const render = () => runOperation('render', async (context) => {
    const validation = draftRef.current && validateVideoEditorPlan(draftRef.current);
    if (validation) throw new Error(validation);
    if (!await saveCurrent(context)) return;
    const savedValidation = validateVideoEditorPlan(draftRef.current!);
    if (savedValidation) throw new Error(savedValidation);
    const snapshot = await renderVideoEditor(sessionId, draftRef.current!.revision);
    if (context === sequence.current) applySnapshot(snapshot);
  });
  const cancel = () => runOperation('cancel', async (context) => {
    if (!activeJob) return;
    const snapshot = await cancelVideoEditorJob(sessionId, activeJob.id);
    if (context === sequence.current) applySnapshot(snapshot);
  });
  const rescan = () => runOperation('scan', async (context) => {
    await scanLocalAgents(); const snapshot = await getVideoEditor(sessionId);
    if (context === sequence.current) { setAgents(snapshot.agents); setJobs(snapshot.jobs); setNotice('已更新本地 Agent 检测结果。'); }
  });
  const selectedAgent = agents.find((agent) => agent.id === project?.agentId);
  const usableSources = !!project?.sources.length && project.sources.every((source) => !source.missing && !source.stale);
  const canPlan = usableSources && !!selectedAgent?.available && !!selectedAgent.adapterAvailable && !!project?.instruction.trim();
  const planValidation = project ? validateVideoEditorPlan(project) : '';
  const latestJob = jobs.at(-1);
  const lastJob = latestJob && ['failed', 'cancelled'].includes(latestJob.status) ? latestJob : undefined;
  const moveSegment = (index: number, delta: number) => edit((current) => {
    const target = index + delta; if (target < 0 || target >= current.segments.length) return current;
    const segments = [...current.segments]; [segments[index], segments[target]] = [segments[target], segments[index]];
    return {...current, segments};
  });
  const selectAgent = (agentId: string) => {
    edit((current) => ({...current, agentId}), true);
    try { localStorage.setItem(PREFERRED_AGENT, agentId); } catch { /* Optional preference. */ }
  };
  const previewSource = project?.sources.find((source) => source.id === selectedSourceId) || project?.sources.find((source) => source.id === project.segments[Math.max(0, selectedSegment)]?.sourceId) || project?.sources[0];
  const previewSegment = project && !showOutput && !project.planStale && project.segments[selectedSegment]?.sourceId === previewSource?.id ? project.segments[selectedSegment] : undefined;
  const previewUrl = showOutput ? (project?.output?.missing ? '' : project?.output?.url) : previewSource?.missing || previewSource?.stale ? '' : previewSource?.url;
  const previewStart = previewSegment?.start || 0;
  const previewEnd = showOutput ? project?.output?.duration || 0 : previewSegment?.end || previewSource?.duration || 0;
  const previewDuration = Math.max(0, previewEnd - previewStart);
  useEffect(() => { if (project?.output?.path) setShowOutput(true); }, [project?.output?.path]);
  useEffect(() => {
    const video = previewVideo.current; setPlaying(false); setPlaybackTime(previewStart);
    if (video) { video.pause(); if (video.readyState >= 1) video.currentTime = previewStart; }
  }, [previewUrl, previewStart, previewEnd]);
  const chooseSource = (sourceId: string) => { setSelectedSourceId(sourceId); setShowOutput(false); setSelectedSegment(-1); };
  const chooseSegment = (index: number) => {
    const segment = project?.segments[index]; if (!segment) return;
    setSelectedSegment(index); setSelectedSourceId(segment.sourceId); setShowOutput(false); setTrim(undefined);
  };
  const togglePlayback = () => {
    const video = previewVideo.current; if (!video || !previewUrl) return;
    if (!video.paused) { video.pause(); return; }
    if (video.currentTime < previewStart || video.currentTime >= previewEnd - .02) video.currentTime = previewStart;
    void video.play().catch(() => setError({message: '暂时无法播放此视频，请确认素材可用。'}));
  };
  const openTrim = () => {
    if (trim) { setTrim(undefined); return; }
    const segment = project?.segments[selectedSegment]; if (!segment || busy || project?.planStale) return;
    chooseSegment(selectedSegment); setTrim({index: selectedSegment, start: String(segment.start), end: String(segment.end)});
  };
  const applyTrim = () => {
    const current = draftRef.current; if (!current || !trim || busy) return;
    const start = Number(trim.start), end = Number(trim.end);
    const candidate = {...current, segments: current.segments.map((segment, index) => index === trim.index ? {...segment, start, end} : segment)};
    const validation = !trim.start.trim() || !trim.end.trim() ? '请填写裁切的开始和结束时间。' : validateVideoEditorPlan(candidate);
    if (validation) { setError({message: validation}); return; }
    edit(() => candidate); setNotice('已更新裁切范围；确认方案后再剪辑成片。');
  };

  return <div className="director-view video-editor-view"><div className="video-editor-content" ref={contentRef}>
    <header className="director-header video-editor-header">
      <div><button className="director-text-button video-editor-back" onClick={onBack}><ArrowLeft size={15}/>返回导演台</button><h1>剪辑已有视频 <span>{session.projectName || '未命名项目'}</span></h1><p>选择素材，用一句话制定方案，再确认剪辑。</p></div>
      <div className="director-header-actions"><span className={`director-save-state ${dirty ? 'dirty' : ''}`}>{loading ? '正在载入' : dirty ? '有未保存编辑' : '已保存'}</span><button className="director-button" disabled={busy || !dirty} onClick={save}>{operation === 'save' ? <Loader2 className="director-spin" size={15}/> : <Save size={15}/>}保存</button></div>
    </header>
    {error && <div className="director-notice error" role="alert"><span>{error.message}</span>{error.code === 'revision_conflict' && <button className="director-text-button" disabled={busy} onClick={() => void load()}>重新核对<RefreshCw size={14}/></button>}<button className="director-icon-button" aria-label="关闭错误提示" onClick={() => setError(undefined)}><X size={15}/></button></div>}
    {notice && <div className="director-notice" role="status">{notice}</div>}
    {recovery && <div className="director-notice warning"><span>找到未保存的剪辑草稿，请选择保留哪一份。</span><button className="director-text-button" disabled={busy} onClick={() => { const current = draftRef.current; if (!current) return; clearHistory(); putProject(refreshVideoEditorSourceMetadata({...recovery, planStale: true}, current), true); setRecovery(undefined); setNotice('已恢复草稿；请核对素材并重新生成方案。'); }}>恢复草稿</button><button className="director-text-button" disabled={busy} onClick={() => { clearVideoEditorDraft(sessionId); setRecovery(undefined); }}>使用已保存项目</button></div>}
    {loading ? <div className="director-loading"><Loader2 className="director-spin" size={25}/><p>正在载入剪辑项目…</p></div> : !project ? <div className="director-welcome"><Scissors size={32}/><h2>暂时无法载入剪辑项目</h2><button className="director-button" onClick={() => void load()}><RefreshCw size={15}/>重新载入</button></div> : <>
      <div className="video-editor-grid">
        <div className="video-editor-workspace">
          <section className="video-editor-preview" aria-label="视频预览">
            <div className="director-section-head"><div><strong>{showOutput ? (project.output?.stale || dirty ? '上次剪辑成片' : '成片预览') : previewSource?.name || '准备你的第一段视频'}</strong>{previewUrl && <span>{showOutput ? '成片' : previewSegment ? `方案片段 ${selectedSegment + 1}` : '原素材'} · {timeLabel(previewDuration)}</span>}</div>
              {project.output && <button className="director-text-button" disabled={showOutput ? !project.sources.length : !!project.output.missing} onClick={() => { setShowOutput(!showOutput); setSelectedSegment(-1); }}>{showOutput ? '查看素材' : '查看成片'}</button>}
            </div>
            <div className={`video-editor-screen ${previewUrl ? '' : 'empty'}`}>
              {previewUrl ? <video ref={previewVideo} src={previewUrl} playsInline preload="metadata" aria-label={showOutput ? '剪辑成片' : `${previewSource?.name || '视频'} 原视频`} onLoadedMetadata={() => { if (previewVideo.current) previewVideo.current.currentTime = previewStart; setPlaybackTime(previewStart); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => { const video = event.currentTarget; setPlaybackTime(video.currentTime); if (previewSegment && video.currentTime >= previewEnd) { video.pause(); setPlaybackTime(previewEnd); } }}/>
                : <div className="video-editor-empty-preview"><Film size={38}/><strong>{project.sources.length ? '这段视频暂时不可用' : '添加你已有的视频'}</strong><p>{project.sources.length ? '文件已丢失或改变，请重新导入素材。' : '导入素材后，在底部填写剪辑要求。'}</p><button className="director-button primary" disabled={busy || project.sources.length >= 20} onClick={() => fileInput.current?.click()}><Plus size={15}/>添加视频</button></div>}
            </div>
            {showOutput && (project.output?.stale || dirty) && <p className="video-editor-hint">这是上次的结果，重新剪辑会另存一份新成片。</p>}
          </section>
          {!!project.segments.length && <section className="video-editor-plan" aria-label="剪辑方案">
            <div className="director-section-head"><div><strong>确认剪辑方案</strong><span>{project.segments.length} 个片段 · {timeLabel(videoEditorDuration(project.segments))}</span></div><span className="video-editor-plan-format">{project.settings.aspectRatio} · {project.settings.resolution}</span></div>
            <p className="video-editor-hint">点选片段预览，可调整时间与顺序；确认后才会剪辑。</p>
            {project.planStale && <p className="video-editor-stale">素材或剪辑要求已改变，请重新生成方案。</p>}
            <div className="video-editor-segments">{project.segments.map((segment, index) => {
              const source = project.sources.find((item) => item.id === segment.sourceId);
              return <div className={`video-editor-segment ${selectedSegment === index && !showOutput ? 'selected' : ''}`} key={`${index}-${segment.sourceId}`}>
                <button className="video-editor-segment-number" aria-label={`预览片段 ${index + 1}`} aria-pressed={selectedSegment === index && !showOutput} onClick={() => chooseSegment(index)}>{index + 1}</button>
                <div><button className="video-editor-segment-name" onClick={() => chooseSegment(index)}>{source?.name || '素材已移除'}</button><div className="video-editor-segment-times"><label>从<input type="number" aria-label={`片段 ${index + 1} 开始时间`} min={0} max={source?.duration} step="0.1" value={segment.start} disabled={busy || project.planStale} onChange={(event) => edit((current) => ({...current, segments: current.segments.map((item, i) => i === index ? {...item, start: Number(event.target.value)} : item)}))}/></label><label>到<input type="number" aria-label={`片段 ${index + 1} 结束时间`} min={0} max={source?.duration} step="0.1" value={segment.end} disabled={busy || project.planStale} onChange={(event) => edit((current) => ({...current, segments: current.segments.map((item, i) => i === index ? {...item, end: Number(event.target.value)} : item)}))}/></label><span>秒</span></div></div>
                <div className="video-editor-segment-tools"><button className="director-icon-button" aria-label={`片段 ${index + 1} 上移`} disabled={busy || project.planStale || index === 0} onClick={() => { moveSegment(index, -1); if (selectedSegment === index) setSelectedSegment(index - 1); else if (selectedSegment === index - 1) setSelectedSegment(index); }}><ArrowUp size={14}/></button><button className="director-icon-button" aria-label={`片段 ${index + 1} 下移`} disabled={busy || project.planStale || index === project.segments.length - 1} onClick={() => { moveSegment(index, 1); if (selectedSegment === index) setSelectedSegment(index + 1); else if (selectedSegment === index + 1) setSelectedSegment(index); }}><ArrowDown size={14}/></button><button className="director-icon-button danger" aria-label={`移除片段 ${index + 1}`} disabled={busy || project.planStale} onClick={() => { edit((current) => ({...current, segments: current.segments.filter((_, i) => i !== index)})); setSelectedSegment(Math.max(0, selectedSegment > index ? selectedSegment - 1 : selectedSegment)); }}><Trash2 size={14}/></button></div>
              </div>;
            })}</div>
            {planValidation && !project.planStale && <p className="video-editor-stale" role="status">{planValidation}</p>}
          </section>}
        </div>
        <aside className="video-editor-materials">
          <section aria-label="视频素材"><div className="director-section-head"><div><strong>视频素材</strong><span>{project.sources.length}/20 个</span></div><button className="director-text-button" disabled={busy || project.sources.length >= 20} onClick={() => fileInput.current?.click()}>{operation === 'upload' ? <Loader2 className="director-spin" size={14}/> : <Plus size={14}/>}添加视频</button><input ref={fileInput} type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" multiple hidden onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; if (files.length) void addSources(files); }}/></div>
            {project.sources.length ? <div className="video-editor-sources">{project.sources.map((source, index) => <article className={`video-editor-source ${!showOutput && source.id === previewSource?.id ? 'selected' : ''}`} key={source.id}>
              <button className="video-editor-source-preview" aria-label={`预览 ${source.name}`} disabled={source.missing || source.stale} onClick={() => chooseSource(source.id)}>{!source.missing && !source.stale ? <video src={source.url} preload="metadata" muted playsInline/> : <Film size={24}/>}<span><Play size={13}/></span></button>
              <div className="video-editor-source-info"><strong>{index + 1}. {source.name}</strong><span>{timeLabel(source.duration)}{source.missing ? ' · 文件已丢失，请重新导入' : source.stale ? ' · 文件已改变，请重新导入' : ''}</span><label className="video-editor-source-description"><span>素材描述</span><input aria-label={`${source.name} 素材描述`} value={source.description || ''} placeholder="可选：说明视频内容" disabled={busy} maxLength={1000} onChange={(event) => edit((current) => ({...current, sources: current.sources.map((item) => item.id === source.id ? {...item, description: event.target.value} : item)}), true)}/></label></div>
              <button className="director-icon-button danger" aria-label={`移除 ${source.name}`} disabled={busy} onClick={() => edit((current) => ({...current, sources: current.sources.filter((item) => item.id !== source.id), segments: current.segments.filter((item) => item.sourceId !== source.id)}), true)}><Trash2 size={15}/></button>
            </article>)}</div> : <div className={`video-editor-drop ${busy ? 'busy' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!busy) void addSources(Array.from(event.dataTransfer.files)); }}><Plus size={25}/><strong>拖入视频素材</strong><p>支持 MP4、MOV 和 WebM</p></div>}
            <p className="video-editor-hint">原视频保留，剪辑结果另存。</p>
          </section>
          <div className="video-editor-agent-label"><strong>{selectedAgent?.name || '选择本地 Agent'}</strong><button className="director-text-button" disabled={busy} onClick={rescan}>{operation === 'scan' ? <Loader2 className="director-spin" size={14}/> : <RefreshCw size={14}/>}重新检测</button></div>
          {!agents.some((agent) => agent.adapterAvailable && agent.available) && <p className="video-editor-stale">当前没有可调用的本地 Agent，请检查安装并重新检测。</p>}
          <p className="video-editor-hint">沿用 Agent 当前配置，按素材描述、时间和顺序制定方案。</p>
          {activeJob && <div className="video-editor-job" role="status"><strong>{activeJob.operation === 'plan' ? 'Agent 正在制定方案' : '正在剪辑视频'}</strong><p>{activeJob.message}{activeJob.progress !== undefined ? ` · ${Math.round(activeJob.progress <= 1 ? activeJob.progress * 100 : activeJob.progress)}%` : ''}</p><button className="director-button" disabled={!!operation} onClick={cancel}><Square size={13}/>取消任务</button><small>离开剪辑页后，任务会继续执行。</small></div>}
          {!activeJob && lastJob && <div className={`video-editor-job ${lastJob.status === 'failed' ? 'failed' : ''}`} role="status"><strong>{lastJob.status === 'failed' ? '上次任务未完成' : '任务已取消'}</strong><p>{lastJob.error?.message || lastJob.message}</p></div>}
        </aside>
      </div>
      <CapsuleDock>
        <div className="capsule-playback video-editor-playback"><button className="capsule-icon-button" aria-label={playing ? '暂停预览' : '播放预览'} disabled={!previewUrl} onClick={togglePlayback}>{playing ? <Pause size={19}/> : <Play size={19}/>}</button><div><span>{playbackLabel(Math.min(previewDuration, Math.max(0, playbackTime - previewStart)))} <small>/ {playbackLabel(previewDuration)}</small></span><input type="range" aria-label="视频预览进度" min={previewStart} max={Math.max(previewEnd, previewStart + .01)} step="0.01" value={Math.min(previewEnd, Math.max(previewStart, playbackTime))} disabled={!previewUrl} onChange={(event) => { const value = Number(event.target.value); if (previewVideo.current) previewVideo.current.currentTime = value; setPlaybackTime(value); }}/></div></div>
        <div className="capsule-command video-editor-command">
          {trim ? <div className="video-editor-trim-controls"><span>片段 {trim.index + 1}</span><label>从<input type="number" aria-label="裁切开始时间" min={0} step="0.1" value={trim.start} disabled={busy} onChange={(event) => setTrim({...trim, start: event.target.value})}/></label><label>到<input type="number" aria-label="裁切结束时间" min={0} step="0.1" value={trim.end} disabled={busy} onChange={(event) => setTrim({...trim, end: event.target.value})}/></label><span>秒</span><button className="capsule-icon-button" aria-label="应用裁切范围" disabled={busy} onClick={applyTrim}><Check size={17}/></button><button className="capsule-icon-button" aria-label="取消裁切" onClick={() => setTrim(undefined)}><X size={17}/></button></div> : <>
            <select aria-label="执行 Agent" value={project.agentId} disabled={busy} onChange={(event) => selectAgent(event.target.value)}><option value="">选择 Agent</option>{project.agentId && !selectedAgent && <option value={project.agentId} disabled>所选 Agent 已不在检测结果中</option>}{agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.adapterAvailable || !agent.available}>{agent.name}{!agent.adapterAvailable ? ' · 待适配' : !agent.available ? ' · 未就绪' : ''}</option>)}</select>
            <textarea aria-label="剪辑要求" rows={1} value={project.instruction} maxLength={4000} placeholder="告诉 Agent 怎么剪，如：第二段取 2–7 秒，再接第一段前 3 秒" disabled={busy} onChange={(event) => edit((current) => ({...current, instruction: event.target.value}), true)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!busy && canPlan) void plan(); } }}/>
            <button className="capsule-icon-button primary" aria-label="生成剪辑方案" title="生成方案，确认后再剪辑" disabled={busy || !canPlan} onClick={plan}>{operation === 'plan' || activeJob?.operation === 'plan' ? <Loader2 className="director-spin" size={17}/> : <Send size={17}/>}</button>
          </>}
        </div>
        <div className="capsule-actions video-editor-actions"><button className={`capsule-icon-button ${trim ? 'active' : ''}`} aria-label={trim ? '退出裁切' : '裁切所选片段'} title={project.segments.length ? '选择一个方案片段后裁切' : '先生成剪辑方案'} disabled={busy || project.planStale || !project.segments[selectedSegment]} onClick={openTrim}><Scissors size={18}/></button><button className="capsule-icon-button" aria-label="撤销上一步编辑" disabled={busy || !undoCount} onClick={undo}><Undo2 size={18}/></button><button className="capsule-confirm-button" disabled={busy || !!planValidation} onClick={render}>{operation === 'render' || activeJob?.operation === 'render' ? <Loader2 className="director-spin" size={16}/> : <Check size={16}/>}确认剪辑</button>{project.output && !project.output.missing && <a className="capsule-icon-button" aria-label="下载成片" title={project.output.stale || dirty ? '下载上次剪辑成片' : '下载成片'} href={project.output.url} download="FrameFlow-剪辑.mp4"><Download size={18}/></a>}</div>
      </CapsuleDock>
    </>}
  </div></div>;
}
