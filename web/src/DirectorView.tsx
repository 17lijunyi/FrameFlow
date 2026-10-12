import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowDown, ArrowRight, ArrowUp, ChevronDown, Check, Clapperboard, Copy, Download, Film, Image as ImageIcon, Loader2, Pause, Play, Plus, RefreshCw, Save, Scissors, Send, Settings2, Sparkles, Square, Trash2, Undo2, Upload, X} from 'lucide-react';
import CapsuleDock from './CapsuleDock';
import {getArtifacts, uploadWorkspaceFile} from './api';
import type {Artifact, SessionSummary} from './types';
import {
  canMergeDirectorMetadata, cancelDirectorJob, clearDirectorDraft, createDirectorShot, defaultDirectorDuration, directorRenderSignature, directorTimeline,
  duplicateDirectorShot, exportDirector, getDirector, importDirector, isDirectorJobActive,
  isDirectorVersionStale, mergeDirectorMetadata, moveDirectorShot, persistDirectorDraft, readDirectorDraft,
  renderDirectorShot, saveDirector, selectedDirectorVersion, usableDirectorVersion, validateDirectorShot,
} from './director';
import type {DirectorCapabilities, DirectorFailure, DirectorJob, DirectorProject, DirectorShot, DirectorSnapshot} from './director';
import './director.css';

type Props = {
  session: SessionSummary | undefined; artifacts: Artifact[];
  onCreateProject: () => void; onOpenAssistant: () => void; onOpenSettings: () => void;
  onArtifactsChanged: () => void; assistantName: string; onSelectAssistant: () => void; onOpenEditor: () => void; onAskAssistant: (prompt: string) => void;
};
type Notice = {message: string; action?: 'open_settings'; code?: string};
type DraftHistory = {project: DirectorProject; dirty: boolean; selectedId: string};
const timeLabel = (seconds: number) => `${Number(seconds.toFixed(1))} 秒`;
const playbackLabel = (seconds: number) => `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;
const metadataSignature = (draft: DirectorProject) => JSON.stringify([draft.export, draft.shots.map((shot) => [shot.id, shot.versions, shot.currentFingerprint])]);
const jobLabel = {queued: '等待开始', running: '正在处理', completed: '已完成', failed: '失败', cancelled: '已停止本地等待'};

export default function DirectorView({session, artifacts, onCreateProject, onOpenAssistant, onOpenSettings, onArtifactsChanged, onOpenEditor, onAskAssistant, assistantName, onSelectAssistant}: Props) {
  const [project, setProject] = useState<DirectorProject>();
  const [jobs, setJobs] = useState<DirectorJob[]>([]);
  const [capabilities, setCapabilities] = useState<DirectorCapabilities>({});
  const [selectedId, setSelectedId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState<Notice>();
  const [notice, setNotice] = useState('');
  const [recovery, setRecovery] = useState<DirectorProject>();
  const [localAssets, setLocalAssets] = useState<Artifact[]>([]);
  const [previewMode, setPreviewMode] = useState<'video' | 'first' | 'last'>('video');
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [undoCount, setUndoCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const undoRef = useRef<DraftHistory[]>([]);
  const draftRef = useRef<DirectorProject>();
  const contentRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  const editSeq = useRef(0);
  const contextSeq = useRef(0);
  const operationRef = useRef('');
  const serverSignatures = useRef(new Map<string, string>());
  const serverMetadata = useRef('');
  const artifactsChangedRef = useRef(onArtifactsChanged);
  artifactsChangedRef.current = onArtifactsChanged;
  const sessionId = session?.sessionId || '';

  const clearUndo = useCallback(() => { undoRef.current = []; setUndoCount(0); }, []);

  useEffect(() => {
    // Stacked layouts scroll as a page. Bring a new actionable error back into
    // view after a button near the bottom received browser focus.
    if (error && contentRef.current) contentRef.current.scrollTop = 0;
  }, [error?.message]);

  const fail = useCallback((failure: unknown) => {
    const err = failure as DirectorFailure;
    setError({message: err?.message || '操作未完成，请稍后重试。', action: err?.action, code: err?.code});
  }, []);

  const putDraft = useCallback((draft: DirectorProject, changed: boolean) => {
    draftRef.current = draft;
    dirtyRef.current = changed;
    setProject(draft);
    setDirty(changed);
    if (changed && !persistDirectorDraft(draft)) setError({message: '本地草稿暂时无法保留，请保存后再离开导演台。'});
  }, []);

  const edit = useCallback((update: (draft: DirectorProject) => DirectorProject) => {
    const current = draftRef.current;
    if (!current) return;
    const next = update(current);
    if (next === current) return;
    undoRef.current = [...undoRef.current.slice(-49), {project: current, dirty: dirtyRef.current, selectedId}];
    setUndoCount(undoRef.current.length);
    editSeq.current += 1;
    putDraft(next, true);
    setNotice('');
  }, [putDraft, selectedId]);

  const undo = () => {
    if (operationRef.current) return;
    const previous = undoRef.current.pop();
    if (!previous || previous.project.sessionId !== draftRef.current?.sessionId || previous.project.revision !== draftRef.current.revision) {
      clearUndo();
      return;
    }
    editSeq.current += 1;
    setUndoCount(undoRef.current.length);
    putDraft(previous.project, previous.dirty);
    if (!previous.dirty) clearDirectorDraft(previous.project.sessionId);
    setSelectedId(previous.selectedId);
    setNotice('已撤销上一步编辑。');
  };

  const applySnapshot = useCallback((snapshot: DirectorSnapshot, expectedEdit?: number, acknowledgedInput?: DirectorProject) => {
    const current = draftRef.current;
    if (!current || current.sessionId !== snapshot.project.sessionId || snapshot.project.revision < current.revision) return false;
    setJobs(snapshot.jobs || []);
    setCapabilities(snapshot.capabilities || {});
    if (dirtyRef.current && !canMergeDirectorMetadata(current, snapshot.project, acknowledgedInput)) {
      setError({message: '项目分镜已在其他窗口更新。你的草稿已保留，请重新核对后再保存。', code: 'revision_conflict'});
      return false;
    }
    serverSignatures.current = new Map(snapshot.project.shots.map((shot) => [shot.id, directorRenderSignature(shot, snapshot.project.settings)]));
    const unchanged = expectedEdit !== undefined ? editSeq.current === expectedEdit : !dirtyRef.current;
    // Undo covers local edits only. A save or new server revision establishes
    // a new baseline so it can never restore an older generated-video version.
    const nextMetadata = metadataSignature(snapshot.project);
    if (snapshot.project.revision !== current.revision || nextMetadata !== serverMetadata.current || (unchanged && expectedEdit !== undefined)) clearUndo();
    serverMetadata.current = nextMetadata;
    if (unchanged) {
      putDraft(snapshot.project, false);
      if (expectedEdit !== undefined) clearDirectorDraft(current.sessionId);
    } else {
      putDraft(mergeDirectorMetadata(current, snapshot.project, acknowledgedInput), true);
    }
    setSelectedId((id) => {
      const shots = unchanged ? snapshot.project.shots : current.shots;
      return shots.some((shot) => shot.id === id) ? id : shots[0]?.id || '';
    });
    return true;
  }, [putDraft, clearUndo]);

  const load = useCallback(async () => {
    if (!sessionId) { setLoading(false); return; }
    const context = ++contextSeq.current;
    setLoading(true);
    setError(undefined);
    try {
      const snapshot = await getDirector(sessionId);
      if (context !== contextSeq.current) return;
      clearUndo();
      serverMetadata.current = metadataSignature(snapshot.project);
      const savedDraft = readDirectorDraft(sessionId);
      serverSignatures.current = new Map(snapshot.project.shots.map((shot) => [shot.id, directorRenderSignature(shot, snapshot.project.settings)]));
      setJobs(snapshot.jobs || []);
      setCapabilities(snapshot.capabilities || {});
      setRecovery(undefined);
      const compatibleDraft = savedDraft && (savedDraft.revision === snapshot.project.revision || canMergeDirectorMetadata(savedDraft, snapshot.project));
      if (compatibleDraft) {
        putDraft(mergeDirectorMetadata({...savedDraft, planRevision: snapshot.project.planRevision}, snapshot.project), true);
        setNotice('已恢复上次未保存的编辑。');
      } else {
        putDraft(snapshot.project, false);
        if (savedDraft) setRecovery(savedDraft);
      }
      setSelectedId((compatibleDraft ? savedDraft : snapshot.project)?.shots[0]?.id || '');
    } catch (failure) {
      if (context === contextSeq.current) fail(failure);
    } finally {
      if (context === contextSeq.current) setLoading(false);
    }
  }, [sessionId, fail, putDraft, clearUndo]);

  useEffect(() => {
    draftRef.current = undefined;
    dirtyRef.current = false;
    editSeq.current = 0;
    operationRef.current = '';
    serverMetadata.current = '';
    setProject(undefined); setDirty(false); setJobs([]); setSelectedId(''); setOperation('');
    setLocalAssets([]); setNotice(''); setRecovery(undefined); setPreviewMode('video');
    clearUndo(); setAssistantPrompt(''); setPlaying(false); setPlaybackTime(0); setPlaybackDuration(0);
    void load();
    return () => { contextSeq.current += 1; };
  }, [load, clearUndo]);

  const activeJobs = jobs.filter(isDirectorJobActive);
  const hasActiveJobs = activeJobs.length > 0;
  useEffect(() => {
    if (!sessionId || !hasActiveJobs || loading) return;
    const context = contextSeq.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await getDirector(sessionId);
        if (stopped || context !== contextSeq.current) return;
        applySnapshot(snapshot);
        if (!(snapshot.jobs || []).some(isDirectorJobActive)) artifactsChangedRef.current();
        setError((current) => current?.message.startsWith('任务状态暂时无法更新') ? undefined : current);
      } catch {
        if (!stopped && context === contextSeq.current) setError({message: '任务状态暂时无法更新，稍后会继续检查。请勿重复点击生成。'});
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId, hasActiveJobs, loading, applySnapshot]);

  const runOperation = async (name: string, task: (context: number) => Promise<void>) => {
    if (operationRef.current) return;
    const context = contextSeq.current;
    operationRef.current = name;
    setOperation(name); setError(undefined); setNotice('');
    try { await task(context); }
    catch (failure) { if (context === contextSeq.current) fail(failure); }
    finally {
      if (context === contextSeq.current) { operationRef.current = ''; setOperation(''); }
    }
  };

  const saveCurrent = async (context: number): Promise<boolean> => {
    const draft = draftRef.current;
    if (!draft || context !== contextSeq.current) return false;
    if (!dirtyRef.current) return true;
    const sequence = editSeq.current;
    const snapshot = await saveDirector(draft);
    if (context !== contextSeq.current) return false;
    if (!applySnapshot(snapshot, sequence, draft)) return false;
    if (editSeq.current !== sequence) {
      setNotice('已保存之前的编辑；你刚才的改动仍在草稿中，请再次保存。');
      return false;
    }
    setNotice('分镜已保存。');
    return true;
  };

  const save = () => runOperation('save', async (context) => { await saveCurrent(context); });
  const generate = (shotId: string) => runOperation('render', async (context) => {
    const initial = draftRef.current?.shots.find((shot) => shot.id === shotId);
    if (!initial) return;
    const validation = validateDirectorShot(initial, capabilities);
    if (validation) throw new Error(validation);
    if (!await saveCurrent(context)) return;
    if (!draftRef.current?.shots.some((shot) => shot.id === shotId)) return;
    const sequence = editSeq.current;
    const snapshot = await renderDirectorShot(sessionId, shotId, draftRef.current.revision);
    if (context !== contextSeq.current) return;
    applySnapshot(snapshot, sequence);
  });
  const cancel = (job: DirectorJob) => runOperation('cancel', async (context) => {
    const snapshot = await cancelDirectorJob(sessionId, job.id);
    if (context === contextSeq.current) applySnapshot(snapshot);
  });
  const importShots = () => runOperation('import', async (context) => {
    if (draftRef.current?.shots.length && !window.confirm('导入会替换当前分镜。已有素材仍保留在素材库，是否继续？')) return;
    if (!await saveCurrent(context)) return;
    const sequence = editSeq.current;
    const snapshot = await importDirector(sessionId, draftRef.current!.revision);
    if (context !== contextSeq.current) return;
    applySnapshot(snapshot, sequence);
    artifactsChangedRef.current();
    setNotice(`已导入 ${snapshot.project.shots.length} 个镜头。`);
  });
  const exportMovie = () => runOperation('export', async (context) => {
    if (!await saveCurrent(context)) return;
    const sequence = editSeq.current;
    const snapshot = await exportDirector(sessionId, draftRef.current!.revision);
    if (context !== contextSeq.current) return;
    applySnapshot(snapshot, sequence);
  });

  const allAssets = useMemo(() => {
    const unique = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
    for (const asset of localAssets) unique.set(asset.path, asset);
    return [...unique.values()];
  }, [artifacts, localAssets]);
  const imageAssets = allAssets.filter((asset) => asset.kind === 'image' && /\.(png|jpe?g|webp|gif)$/i.test(asset.path));
  const mediaUrl = (path: string) => allAssets.find((asset) => asset.path === path)?.url || `/api/artifact?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  const updateShot = (shotId: string, patch: Partial<DirectorShot>) => edit((draft) => ({...draft, shots: draft.shots.map((shot) => shot.id === shotId ? {...shot, ...patch} : shot)}));
  const uploadFrame = async (shotId: string, slot: 'firstFrame' | 'lastFrame', file: File) => {
    await runOperation('upload', async (context) => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) && !(!file.type && /\.(png|jpe?g|webp|gif)$/i.test(file.name))) throw new Error('首尾帧支持 PNG、JPEG、WebP 和 GIF 图片，请转换格式后上传。');
      const result = await uploadWorkspaceFile(sessionId, file);
      if (context !== contextSeq.current) return;
      updateShot(shotId, {[slot]: result.file.path});
      artifactsChangedRef.current();
      try {
        const resultAssets = await getArtifacts(sessionId);
        if (context === contextSeq.current) setLocalAssets(resultAssets.artifacts);
      } catch { /* The uploaded path can already be previewed through the artifact endpoint. */ }
    });
  };

  const addShot = () => {
    const draft = draftRef.current;
    if (!draft) return;
    const duration = defaultDirectorDuration(capabilities);
    const shot = createDirectorShot(draft.shots.length, duration);
    edit((current) => ({...current, shots: [...current.shots, shot]}));
    setSelectedId(shot.id); setPreviewMode('first');
  };
  const selectedShot = project?.shots.find((shot) => shot.id === selectedId) || project?.shots[0];
  const selectedIndex = project?.shots.findIndex((shot) => shot.id === selectedShot?.id) ?? -1;
  const selectedVersion = selectedShot && selectedDirectorVersion(selectedShot);
  const selectedStale = !!project && !!selectedShot && isDirectorVersionStale(selectedShot, project.settings, serverSignatures.current.get(selectedShot.id));
  const shotJob = [...jobs].reverse().find((job) => job.shotId === selectedShot?.id && job.operation === 'render');
  const timeline = directorTimeline(project?.shots || []);
  const totalDuration = timeline.at(-1)?.end || 0;
  const readyShots = project?.shots.filter((shot) => usableDirectorVersion(shot, project.settings, serverSignatures.current.get(shot.id))).length || 0;
  const exportReady = !!project?.shots.length && readyShots === project.shots.length && !hasActiveJobs && capabilities.canExport !== false;
  const anyDraftRenderChanges = !!project?.shots.some((shot) => serverSignatures.current.has(shot.id) && directorRenderSignature(shot, project.settings) !== serverSignatures.current.get(shot.id));
  const exportStale = !!project?.export && (project.export.stale || dirty || anyDraftRenderChanges);
  const previewPlayable = previewMode === 'video' && !!selectedVersion && !selectedVersion.missing;
  const needsFirstFrame = capabilities.promptOnly === false && !!selectedShot && !selectedShot.firstFrame;
  const videoServiceNotice = capabilities.supported === false
    ? capabilities.message || '当前视频服务暂不支持导演台单镜生成。'
    : capabilities.provider === 'aliyun'
      ? `${capabilities.videoConfigured === false ? '请先配置视频服务密钥。' : ''}万相 Flash · 需一张首帧，生成无声视频；画幅跟随首帧。合并导出沿用项目画幅 ${project?.settings.aspectRatio || '16:9'}。`
      : capabilities.videoConfigured === false ? capabilities.message || '配置视频服务后即可生成，当前仍可编辑与保存分镜。' : '';

  useEffect(() => {
    setPlaying(false); setPlaybackTime(0); setPlaybackDuration(0);
  }, [sessionId, selectedVersion?.id, previewMode]);

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video || !previewPlayable) return;
    try {
      if (video.paused) { if (video.ended) video.currentTime = 0; await video.play(); }
      else video.pause();
    } catch { setError({message: '视频暂时无法播放，请检查文件或重新生成此镜头。'}); }
  };
  const assistantCommand = <form className="capsule-command director-dock-command" onSubmit={(event) => {
    event.preventDefault();
    const prompt = assistantPrompt.trim();
    if (!prompt) return;
    setAssistantPrompt('');
    onAskAssistant(prompt);
  }}>
    <button type="button" className="dock-executor-button" title="更换创作助手" aria-label="更换创作助手" onClick={onSelectAssistant}><Sparkles size={16}/><span>{assistantName}</span><ChevronDown size={13}/></button>
    <input aria-label="发送给创作助手的指令" value={assistantPrompt} onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder="让助手帮你写剧本、拆分镜头…" />
    <button type="submit" className="capsule-icon-button primary" aria-label="发送创作指令" title="发送创作指令" disabled={!assistantPrompt.trim()}><Send size={17} /></button>
  </form>;

  if (!session) return <div className="director-view"><header className="director-header"><div><span className="director-eyebrow">FRAMEFLOW · 导演台</span><h1>导演台</h1></div></header><div className="director-welcome"><div className="director-welcome-icon"><Clapperboard size={38} /></div><h2>从一个镜头开始，拍出完整故事</h2><p>把故事拆成镜头，逐镜生成，再合成为影片。</p><button className="director-button primary" onClick={onCreateProject}><Plus size={17} />新建项目</button><button className="director-text-button" onClick={onOpenAssistant}>打开创作助手<ArrowRight size={15} /></button></div><CapsuleDock><div className="capsule-playback director-dock-empty"><Clapperboard size={20} /><span>准备创作</span></div>{assistantCommand}<div className="capsule-actions"><button className="capsule-button primary" onClick={onCreateProject}><Plus size={17} />新建项目</button></div></CapsuleDock></div>;

  return <div className="director-view"><div className="director-content" ref={contentRef}>
    <header className="director-header">
      <div><span className="director-eyebrow">FRAMEFLOW · 导演台</span><h1>导演台 <span>{session.projectName || '未命名项目'}</span></h1></div>
      <div className="director-header-actions"><span className={`director-save-state ${dirty ? 'dirty' : ''}`}>{loading ? '正在载入' : dirty ? '有未保存编辑' : '已保存'}</span><button className="director-button video-editor-entry" onClick={onOpenEditor}><Scissors size={15} />剪辑已有视频</button></div>
    </header>

    {error && <div className="director-notice error" role="alert"><span>{error.message}</span>{error.code === 'revision_conflict' && <button className="director-text-button" onClick={() => void load()}>重新核对项目<RefreshCw size={14} /></button>}{error.action === 'open_settings' && <button className="director-text-button" onClick={onOpenSettings}>前往设置<ArrowRight size={14} /></button>}<button className="director-icon-button" aria-label="关闭错误提示" onClick={() => setError(undefined)}><X size={15} /></button></div>}
    {notice && <div className="director-notice" role="status">{notice}</div>}
    {recovery && <div className="director-notice warning"><span>找到未保存的本地草稿；项目已更新，请选择保留哪一份。</span><button className="director-text-button" onClick={() => { const server = draftRef.current; if (!server) return; clearUndo(); editSeq.current += 1; putDraft(mergeDirectorMetadata({...recovery, revision: server.revision, planRevision: server.planRevision}, server), true); setSelectedId(recovery.shots[0]?.id || ''); setRecovery(undefined); setNotice('已恢复本地草稿，保存后将更新项目。'); }}>恢复草稿</button><button className="director-text-button" onClick={() => { clearDirectorDraft(sessionId); setRecovery(undefined); }}>使用已保存项目</button></div>}

    {loading ? <div className="director-loading"><Loader2 className="director-spin" size={26} /><p>正在载入分镜…</p></div> : !project ? <div className="director-welcome"><Film size={36} /><h2>暂时无法载入导演台</h2><p>你的素材和草稿仍会保留。</p><button className="director-button" onClick={() => void load()}><RefreshCw size={16} />重新载入</button></div> : <>
      <section className="director-project-settings" aria-label="影片公共设置">
        <div className="director-settings-label"><Settings2 size={16} /><span>影片设置</span></div>
        <label className="director-style-field">统一风格<input value={project.settings.style} placeholder="如：电影感、暖色自然光、写实摄影" onChange={(event) => edit((draft) => ({...draft, settings: {...draft.settings, style: event.target.value}}))} /></label>
        <label>{capabilities.aspectRatioFromImage ? '导出画幅' : '画幅'}<select title={capabilities.aspectRatioFromImage ? '生成视频的画幅跟随首帧图片；这里设置合并导出的画幅。' : undefined} value={project.settings.aspectRatio} onChange={(event) => edit((draft) => ({...draft, settings: {...draft.settings, aspectRatio: event.target.value}}))}>{[...new Set([project.settings.aspectRatio, ...(capabilities.aspectRatios?.length ? capabilities.aspectRatios : ['16:9', '9:16', '1:1'])])].filter(Boolean).map((value) => <option key={value} value={value}>{value === '16:9' ? '16:9 横屏' : value === '9:16' ? '9:16 竖屏' : value === '1:1' ? '1:1 方形' : value}</option>)}</select></label>
        <label>分辨率<select value={project.settings.resolution} onChange={(event) => edit((draft) => ({...draft, settings: {...draft.settings, resolution: event.target.value}}))}>{[...new Set([project.settings.resolution, ...(capabilities.resolutions?.length ? capabilities.resolutions : ['720p', '1080p'])])].filter(Boolean).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </section>
      {videoServiceNotice && <div className="director-service-note"><span>{videoServiceNotice}</span><button className="director-text-button" onClick={onOpenSettings}>视频服务设置<ArrowRight size={14} /></button></div>}

      <div className="director-workspace">
        <main className="director-stage-column">
          <div className="director-stage-head"><div><span className="director-eyebrow">镜头预览</span><strong>{selectedShot?.title || '准备你的第一个镜头'}</strong></div><div className="director-preview-tabs" role="group" aria-label="预览内容"><button className={previewMode === 'video' ? 'active' : ''} onClick={() => setPreviewMode('video')}>视频</button><button className={previewMode === 'first' ? 'active' : ''} onClick={() => setPreviewMode('first')}>首帧</button><button className={previewMode === 'last' ? 'active' : ''} onClick={() => setPreviewMode('last')}>尾帧</button></div></div>
          <div className="director-preview" style={{aspectRatio: project.settings.aspectRatio.replace(':', '/')}}>
            {previewMode === 'video' && selectedVersion && !selectedVersion.missing ? <video key={selectedVersion.id} ref={videoRef} src={selectedVersion.url || mediaUrl(selectedVersion.path)} aria-label={`${selectedShot?.title || '当前镜头'}视频预览`} playsInline preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => { const duration = event.currentTarget.duration; setPlaybackDuration(Number.isFinite(duration) ? duration : 0); }} onError={() => { setPlaying(false); setError({message: '当前镜头的视频暂时无法读取，请检查文件或重新生成。'}); }} /> : selectedShot && (previewMode === 'last' ? selectedShot.lastFrame : selectedShot.firstFrame) ? <img src={mediaUrl(previewMode === 'last' ? selectedShot.lastFrame : selectedShot.firstFrame)} alt={`${selectedShot.title} · ${previewMode === 'last' ? '尾帧' : '首帧'}`} /> : <div className="director-preview-empty"><div>{previewMode === 'video' ? <Film size={32} /> : <ImageIcon size={32} />}</div><strong>{!selectedShot ? '先把故事拆成镜头' : previewMode === 'video' ? '这个镜头还没有选定视频' : previewMode === 'first' ? '为镜头绑定一张首帧' : '为镜头绑定一张尾帧'}</strong><p>{!selectedShot ? '新增镜头，或导入创作助手生成的分镜。' : previewMode === 'video' ? capabilities.promptOnly === false ? '填写画面描述，添加一张首帧后生成无声镜头。' : '填写画面描述，按需绑定首尾帧后生成镜头。' : '在右侧选择现有图片或上传素材。'}</p>{!selectedShot && <div className="director-empty-actions"><button className="director-button primary" onClick={addShot}><Plus size={16} />新增镜头</button><button className="director-button" onClick={onOpenAssistant}>去创作助手<ArrowRight size={14} /></button></div>}</div>}
            {selectedVersion && previewMode === 'video' && <span className={`director-preview-badge ${selectedStale || selectedVersion.missing ? 'warning' : ''}`}>{selectedVersion.missing ? '视频文件已丢失 · 请重新生成' : selectedStale ? '参数已变更 · 旧版本预览' : '当前选用版本'}</span>}
          </div>

          <section className="director-timeline-section" aria-label="镜头时间轴">
            <div className="director-section-head"><div><strong>镜头时间轴</strong><span>{project.shots.length} 个镜头 · {timeLabel(totalDuration)}</span></div><div><button className="director-text-button" disabled={!!operation || hasActiveJobs} onClick={importShots}><Download size={14} />导入助手分镜</button><button className="director-button compact" onClick={addShot}><Plus size={14} />新增镜头</button></div></div>
            {project.shots.length ? <div className="director-timeline"><div className="director-time-ruler"><span>00:00</span><span>{timeLabel(totalDuration)}</span></div><div className="director-shot-track">{project.shots.map((shot, index) => {
              const version = selectedDirectorVersion(shot);
              const active = jobs.some((job) => job.shotId === shot.id && isDirectorJobActive(job));
              const stale = isDirectorVersionStale(shot, project.settings, serverSignatures.current.get(shot.id));
              return <button key={shot.id} className={`director-shot-cell ${shot.id === selectedShot?.id ? 'selected' : ''}`} style={{flexGrow: Math.max(1, shot.duration)}} aria-pressed={shot.id === selectedShot?.id} onClick={() => { setSelectedId(shot.id); setPreviewMode('video'); }}><div className="director-shot-cell-top"><span>{String(index + 1).padStart(2, '0')}</span>{active ? <Loader2 className="director-spin" size={13} /> : version ? <span className={`director-shot-dot ${stale || version.missing ? 'stale' : 'ready'}`} title={version.missing ? '视频文件已丢失' : stale ? '视频版本已过期' : '已有可用视频'} /> : <span className="director-shot-dot" />}</div>{shot.firstFrame ? <img src={mediaUrl(shot.firstFrame)} alt="" /> : <div className="director-shot-cell-placeholder"><Clapperboard size={19} /></div>}<strong>{shot.title || `镜头 ${index + 1}`}</strong><span>{timeLabel(shot.duration)}</span></button>;
            })}</div></div> : <div className="director-timeline-empty"><span>空白时间轴，等待你的第一个镜头。</span><button className="director-text-button" onClick={addShot}>添加镜头<Plus size={14} /></button></div>}
          </section>
        </main>

        <aside className="director-inspector">
          <div className="director-inspector-head"><div><span className="director-eyebrow">镜头属性</span><strong>{selectedShot ? `镜头 ${selectedIndex + 1}` : '镜头详情'}</strong></div>{selectedShot && <div className="director-shot-tools"><button className="director-icon-button" aria-label="镜头上移" disabled={selectedIndex === 0} onClick={() => edit((draft) => ({...draft, shots: moveDirectorShot(draft.shots, selectedShot.id, -1)}))}><ArrowUp size={15} /></button><button className="director-icon-button" aria-label="镜头下移" disabled={selectedIndex === project.shots.length - 1} onClick={() => edit((draft) => ({...draft, shots: moveDirectorShot(draft.shots, selectedShot.id, 1)}))}><ArrowDown size={15} /></button><button className="director-icon-button" aria-label="复制镜头" onClick={() => { const copy = duplicateDirectorShot(selectedShot); edit((draft) => ({...draft, shots: [...draft.shots.slice(0, selectedIndex + 1), copy, ...draft.shots.slice(selectedIndex + 1)]})); setSelectedId(copy.id); }}><Copy size={15} /></button><button className="director-icon-button danger" aria-label="删除镜头" disabled={jobs.some((job) => job.shotId === selectedShot.id && isDirectorJobActive(job))} onClick={() => { if (!window.confirm(`删除“${selectedShot.title || '当前镜头'}”？视频素材仍会保留在素材库。`)) return; edit((draft) => ({...draft, shots: draft.shots.filter((shot) => shot.id !== selectedShot.id)})); setSelectedId(project.shots[selectedIndex + 1]?.id || project.shots[selectedIndex - 1]?.id || ''); }}><Trash2 size={15} /></button></div>}</div>
          {!selectedShot ? <div className="director-inspector-empty"><Clapperboard size={28} /><p>新增镜头后，在这里编写画面描述、设置时长和首尾帧。</p><button className="director-button" onClick={addShot}><Plus size={15} />新增镜头</button></div> : <div className="director-inspector-body">
            <label className="director-field">镜头名称<input value={selectedShot.title} placeholder="为镜头取一个容易辨认的名字" onChange={(event) => updateShot(selectedShot.id, {title: event.target.value})} /></label>
            <label className="director-field">画面描述<textarea rows={5} value={selectedShot.prompt} placeholder="描述人物、动作、环境与运镜。例如：镜头缓慢推进，女孩转身望向远处的海面。" onChange={(event) => updateShot(selectedShot.id, {prompt: event.target.value})} /></label>
            <label className="director-field director-duration">镜头时长<div>{capabilities.durations?.length ? <select value={selectedShot.duration} onChange={(event) => updateShot(selectedShot.id, {duration: Number(event.target.value)})}>{[...new Set([selectedShot.duration, ...capabilities.durations])].sort((a, b) => a - b).map((value) => <option value={value} key={value}>{value} 秒{!capabilities.durations?.includes(value) ? '（当前服务不支持）' : ''}</option>)}</select> : <><input type="number" min={capabilities.minDuration || 1} max={capabilities.maxDuration || 120} step="0.5" value={selectedShot.duration} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) updateShot(selectedShot.id, {duration: value}); }} /><span>秒</span></>}</div></label>

            <div className="director-frame-grid">{(['firstFrame', 'lastFrame'] as const).map((slot) => {
              const label = slot === 'firstFrame' ? '首帧' : '尾帧';
              const path = selectedShot[slot];
              const unsupported = slot === 'firstFrame' ? capabilities.supportsFirstFrame === false : capabilities.supportsLastFrame === false;
              return <section className="director-frame-slot" key={`${selectedShot.id}-${slot}`}><div className="director-frame-label"><strong>{label}{slot === 'firstFrame' && capabilities.promptOnly === false ? ' · 必需' : ''}</strong>{path && <button className="director-icon-button" aria-label={`移除${label}`} onClick={() => updateShot(selectedShot.id, {[slot]: ''})}><X size={13} /></button>}</div><div className="director-frame-image">{path ? <img src={mediaUrl(path)} alt={`${selectedShot.title} ${label}`} /> : <ImageIcon size={23} />}</div><select aria-label={`选择${label}素材`} disabled={unsupported} value={path} onChange={(event) => updateShot(selectedShot.id, {[slot]: event.target.value})}><option value="">选择现有素材</option>{path && !imageAssets.some((asset) => asset.path === path) && <option value={path}>已绑定图片</option>}{imageAssets.map((asset) => <option key={asset.path} value={asset.path}>{asset.name}</option>)}</select><label className={`director-upload-button ${operation || unsupported ? 'disabled' : ''}`}><Upload size={13} />上传图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={!!operation || unsupported} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadFrame(selectedShot.id, slot, file); }} /></label>{unsupported && <small>当前视频服务不支持{label}</small>}</section>;
            })}</div>

            <section className="director-versions"><div className="director-section-head"><strong>视频版本</strong><span>{selectedShot.versions.length} 个</span></div>{selectedShot.versions.length ? <div className="director-version-list">{[...selectedShot.versions].reverse().map((version, index) => {
              const stale = isDirectorVersionStale(selectedShot, project.settings, serverSignatures.current.get(selectedShot.id), version);
              const selected = selectedShot.selectedVersionId === version.id;
              return <button key={version.id} className={`director-version ${selected ? 'selected' : ''}`} disabled={version.missing} onClick={() => { updateShot(selectedShot.id, {selectedVersionId: version.id}); setPreviewMode('video'); }}><span className="director-version-icon"><Film size={15} /></span><span><strong>{`版本 ${selectedShot.versions.length - index}`}</strong><small>{new Date(version.createdAt).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})}{version.missing ? ' · 文件已丢失' : stale ? ' · 参数已变更' : ''}</small></span>{selected ? <Check size={15} /> : <span className="director-version-choose">选用</span>}</button>;
            })}</div> : <p>生成后可在这里预览、选用不同版本。</p>}{selectedVersion?.missing && <div className="director-stale-note">选定的视频文件已丢失。请选用其他版本或重新生成。</div>}{selectedStale && <div className="director-stale-note">画面描述、时长、素材或影片设置已改变。请重新生成后再合并成片。</div>}</section>

            <div className="director-generate-section">{shotJob && <div className={`director-shot-job ${shotJob.status === 'failed' ? 'failed' : ''}`} role="status"><span>{jobLabel[shotJob.status]}{shotJob.progress !== undefined && isDirectorJobActive(shotJob) ? ` · ${Math.round(shotJob.progress <= 1 ? shotJob.progress * 100 : shotJob.progress)}%` : ''}</span><p>{shotJob.error?.message || shotJob.message}</p>{shotJob.error?.action === 'open_settings' && <button className="director-text-button" onClick={onOpenSettings}>前往设置<ArrowRight size={14} /></button>}</div>}{shotJob && isDirectorJobActive(shotJob) ? <button className="director-button full" disabled={!!operation} title="停止本地等待；服务端任务可能继续" onClick={() => void cancel(shotJob)}><Square size={14} />停止等待</button> : <button className="director-button primary full" disabled={!!operation || hasActiveJobs || capabilities.supported === false || needsFirstFrame} onClick={() => void generate(selectedShot.id)}>{operation === 'render' ? <Loader2 className="director-spin" size={16} /> : <Clapperboard size={16} />}{selectedShot.versions.length ? '重新生成此镜头' : '生成此镜头'}</button>}<small>{shotJob && isDirectorJobActive(shotJob) ? '停止本地等待后，服务端任务可能继续并计费。' : needsFirstFrame ? '请先选择或上传首帧图片。' : '点击生成时调用视频服务。每次生成都会保留一个新版本。'}</small></div>
          </div>}
        </aside>
      </div>

      <div className="director-export-status" role="status"><span>{readyShots}/{project.shots.length} 个镜头已有可用版本{project.shots.length > 0 && readyShots < project.shots.length ? ' · 请先生成或更新缺失镜头' : ''}</span>{activeJobs.filter((job) => job.operation === 'export').map((job) => <span className="director-export-progress" key={job.id}><Loader2 className="director-spin" size={14} />{job.message || '正在合并成片'}<button className="director-text-button" disabled={!!operation} onClick={() => void cancel(job)}>取消</button></span>)}{[...jobs].reverse().find((job) => job.operation === 'export' && job.status === 'failed') && !activeJobs.some((job) => job.operation === 'export') && <span className="director-export-failed">上次合并失败，请重试</span>}</div>
    </>}
  </div><CapsuleDock>
    <div className="capsule-playback director-dock-playback"><button className="capsule-icon-button" aria-label={playing ? '暂停当前镜头' : '播放当前镜头'} title={playing ? '暂停当前镜头' : '播放当前镜头'} disabled={!previewPlayable} onClick={() => void togglePlayback()}>{playing ? <Pause size={19} /> : <Play size={19} />}</button><div className="director-playback-detail"><span>{playbackLabel(playbackTime)}<span> / {playbackLabel(playbackDuration)}</span></span><input type="range" aria-label="当前镜头播放进度" aria-valuetext={`${timeLabel(playbackTime)}，共 ${timeLabel(playbackDuration)}`} min="0" max={playbackDuration || 1} step="0.1" value={Math.min(playbackTime, playbackDuration || 0)} disabled={!previewPlayable || !playbackDuration} onChange={(event) => { const video = videoRef.current; if (video) { video.currentTime = Number(event.target.value); setPlaybackTime(video.currentTime); } }} /></div></div>
    {assistantCommand}
    <div className="capsule-actions"><button className="capsule-icon-button" aria-label="保存分镜" title="保存分镜" disabled={!project || !!operation || !dirty} onClick={save}>{operation === 'save' ? <Loader2 className="director-spin" size={18} /> : <Save size={18} />}</button><button className="capsule-icon-button" aria-label="撤销上一步编辑" title="撤销上一步编辑" disabled={!undoCount || !!operation || hasActiveJobs} onClick={undo}><Undo2 size={18} /></button>{project?.export?.url && !project.export.missing && <a className={`capsule-icon-button ${exportStale ? 'director-old-export' : ''}`} href={project.export.url} download aria-label={exportStale ? '下载上次成片' : '下载成片'} title={exportStale ? '下载上次成片' : '下载成片'}><Download size={18} /></a>}<button className="capsule-button primary" disabled={!exportReady || !!operation} onClick={() => void exportMovie()}>{operation === 'export' ? <Loader2 className="director-spin" size={17} /> : <Film size={17} />}合并导出</button></div>
  </CapsuleDock></div>;
}
