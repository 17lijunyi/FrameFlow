import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {RefObject} from 'react';
import {
  ArrowUp,
  Brain,
  Braces,
  CircleStop,
  Clock3,
  FilePenLine,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Files,
  Image as ImageIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Save,
  Scissors,
  Sparkles,
  ChevronDown,
  Search,
  Settings,
  ListChecks,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {createProject, deleteSession, getAgentConfig, getArtifacts, getHistory, getSessions, saveAgentConfig, sendMessage, startAgent, stopAgent, subscribeToEvents, uploadWorkspaceFile} from './api';
import {ArtifactsView, StoryboardPanel} from './ArtifactViews';
import LocalAgentsSettings from './LocalAgentsSettings';
import ExecutorSettings from './ExecutorSettings';
import {getExecutors, mergeConfigAfterSelection, roleForConfigurationError} from './executors';
import {createNovelRetrievalDraft, isNovelRetrievalError, mergeConfigAfterNovelRetrieval, novelRetrievalMode, novelRetrievalSavePayload, novelRetrievalStatus, validateNovelRetrievalDraft} from './novelRetrieval';
import type {NovelRetrievalDraft, NovelRetrievalMode} from './novelRetrieval';
import type {ExecutorRole} from './executors';
import DirectorView from './DirectorView';
import VideoEditorView from './VideoEditorView';
import CapsuleDock from './CapsuleDock';
import {clearDirectorDraft} from './director';
import {applyAgentEvent, appendLocalUser, composeAgentPrompt, createChatState, humanize, localizeRuntimeText, removePendingLocalUser, toAgentErrorEvent} from './events';
import {matchingSlashCommands, shouldShowSlashCommands, type SlashCommandMatch} from './slashCommands';
import {runWorkspaceUpload} from './uploadLifecycle';
import {applyMediaProvider, applyModelPreset, MODEL_PRESETS, requiresPlatformKey, type ModelPreset} from './model-presets';
import type {AgentConfig, AgentEvent, Artifact, ChatState, ConfigSection, Message, SessionSummary, WorkspaceUpload} from './types';

const CONTEXT_TARGET = 160_000;

type WorkspaceView = 'director' | 'workspace' | 'artifacts' | 'editor' | 'settings';

type NativeGlassRegion = {x: number; y: number; width: number; height: number; radius: number};
type NativeWindowMessage = {action: 'glass-regions'; regions: NativeGlassRegion[]; viewportWidth: number; viewportHeight: number};
function sendNativeWindowMessage(message: NativeWindowMessage) {
  const nativeWindow = window as Window & {webkit?: {messageHandlers?: {frameflowWindow?: {postMessage: (message: NativeWindowMessage) => void}}}};
  nativeWindow.webkit?.messageHandlers?.frameflowWindow?.postMessage(message);
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [chat, setChat] = useState<ChatState>(() => createChatState());
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('workspace');
  const [settingsFocus, setSettingsFocus] = useState<{role?: ExecutorRole; novelRetrieval?: boolean; request: number}>({request: 0});
  const [agentReady, setAgentReady] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [assistantName, setAssistantName] = useState('创作助手');
  const [storyboardPanelOpen, setStoryboardPanelOpen] = useState(false);
  const [storyboardCount, setStoryboardCount] = useState(0);
  const nativeWindow = document.documentElement.dataset.native === 'macos';
  const [draft, setDraft] = useState('');
  const [composingDraft, setComposingDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [workspaceUploads, setWorkspaceUploads] = useState<WorkspaceUpload[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectError, setNewProjectError] = useState('');
  const [newProjectNeedsSettings, setNewProjectNeedsSettings] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary>();
  const [deleting, setDeleting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submissionRef = useRef<{id: string; accepted: boolean} | null>(null);
  const sessionIntentRef = useRef(0);
  const requestedSessionRef = useRef<string | null>(null);
  const sessionOpeningRef = useRef(true);
  const uploadOperationRef = useRef(0);

  useEffect(() => {
    if (!nativeWindow) return;
    let scheduled = 0;
    let lastRegions = '';
    const updateRegions = () => {
      scheduled = 0;
      const main = document.querySelector<HTMLElement>('.glass-workspace');
      const content = document.querySelector<HTMLElement>('.glass-content');
      if (!main || !content) return;
      const mainRect = main.getBoundingClientRect();
      const regions: NativeGlassRegion[] = [{x: mainRect.x, y: 0, width: mainRect.width, height: content.getBoundingClientRect().bottom, radius: 26}];
      for (const selector of ['.capsule-rail', '.capsule-dock']) {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        regions.push({x: rect.x, y: rect.y, width: rect.width, height: rect.height, radius: parseFloat(getComputedStyle(element).borderTopLeftRadius) || 28});
      }
      const message: NativeWindowMessage = {action: 'glass-regions', regions, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight};
      const serialized = JSON.stringify(message);
      if (serialized !== lastRegions) {
        lastRegions = serialized;
        sendNativeWindowMessage(message);
      }
    };
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(updateRegions); };
    const refreshNativeGeometry = () => { lastRegions = ''; schedule(); };
    const resize = new ResizeObserver(schedule);
    const observeSurfaces = () => {
      resize.disconnect();
      document.querySelectorAll('.glass-workspace, .glass-content, .capsule-rail, .capsule-dock').forEach((element) => resize.observe(element));
      schedule();
    };
    const mutation = new MutationObserver(observeSurfaces);
    mutation.observe(document.querySelector('.glass-app') || document.body, {childList: true, subtree: true});
    observeSurfaces();
    window.addEventListener('resize', schedule);
    window.addEventListener('frameflow:geometry', refreshNativeGeometry);
    return () => { resize.disconnect(); mutation.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('frameflow:geometry', refreshNativeGeometry); if (scheduled) cancelAnimationFrame(scheduled); };
  }, [nativeWindow]);

  function openSettings(code?: string, role?: ExecutorRole) {
    sessionIntentRef.current += 1;
    setSettingsFocus((current) => ({role: role || roleForConfigurationError(code), novelRetrieval: isNovelRetrievalError(code), request: current.request + 1}));
    setWorkspaceView('settings');
    setMobileSidebarOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void getExecutors().then((snapshot) => {
      const option = snapshot.options.find((item) => item.id === snapshot.roles.assistant);
      if (!cancelled) setAssistantName(option?.kind === 'api' ? '模型 API' : option?.name || '创作助手');
    }).catch(() => {}); };
    refresh();
    window.addEventListener('frameflow:model-config-saved', refresh);
    return () => { cancelled = true; window.removeEventListener('frameflow:model-config-saved', refresh); };
  }, [workspaceView]);

  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const slashMatches = useMemo(() => matchingSlashCommands(draft), [draft]);
  const composerBusy = chat.busy || sending;
  const showSlashCommands = shouldShowSlashCommands(draft, composerBusy);
  const runningRender = useMemo(
    () => [...chat.messages].reverse().find((message) => message.role === 'activity'
      && message.status === 'running'
      && (message.tool || '').toLowerCase().includes('render_video')),
    [chat.messages],
  );

  const refreshSessions = useCallback(async () => {
    const state = await getSessions();
    setSessions(state.sessions);
    return state;
  }, []);

  const refreshArtifacts = useCallback(async (sessionId: string) => {
    if (!sessionId) {
      setArtifacts([]);
      return;
    }
    const payload = await getArtifacts(sessionId);
    if (!requestedSessionRef.current || requestedSessionRef.current === sessionId) setArtifacts(payload.artifacts);
  }, []);

  useEffect(() => subscribeToEvents((event) => {
    if (event.type === 'director_changed') {
      if (selectedSessionId) void refreshArtifacts(selectedSessionId);
      return;
    }
    if (event.type === 'sessions_changed') {
      setSessions(event.sessions || []);
      if (event.activeSessionId && (!requestedSessionRef.current || requestedSessionRef.current === event.activeSessionId)) setSelectedSessionId(event.activeSessionId);
      return;
    }
    if (event.type === 'bridge_status') {
      setAgentReady(event.status === 'ready' && !sessionOpeningRef.current);
      if (event.status === 'stopped' && ['配置已更新', 'Configuration updated'].includes(event.message || '')) sessionIntentRef.current += 1;
    }
    if (event.type === 'error' && event.phase === 'startup') setAgentReady(false);
    if (event.type === 'turn' && submissionRef.current) submissionRef.current.accepted = true;
    if (event.type === 'session') {
      const sessionId = event.session?.active_session_id || event.session?.session?.session_id || '';
      if (sessionId && (!requestedSessionRef.current || requestedSessionRef.current === sessionId)) {
        setSelectedSessionId(sessionId);
        void refreshSessions();
        void refreshArtifacts(sessionId);
      }
    }
    setChat((current) => applyAgentEvent(current, event));
  }, (connected) => { if (!connected) setAgentReady(false); }), [refreshArtifacts, refreshSessions, selectedSessionId]);

  useEffect(() => {
    let cancelled = false;
    const intent = ++sessionIntentRef.current;
    const current = () => !cancelled && sessionIntentRef.current === intent;
    void (async () => {
      try {
        const state = await refreshSessions();
        if (!current() || !state.activeSessionId) return;
        requestedSessionRef.current = state.activeSessionId;
        sessionOpeningRef.current = true;
        setSelectedSessionId(state.activeSessionId);
        const [history] = await Promise.all([
          getHistory(state.activeSessionId),
          refreshArtifacts(state.activeSessionId),
        ]);
        if (!current()) return;
        setChat(createChatState(history.messages));
        setAgentReady(false);
        sessionOpeningRef.current = false;
      } catch (error) {
        if (current()) recordLoadError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshArtifacts, refreshSessions]);

  useEffect(() => {
    if (!runningRender || !selectedSessionId) return;
    void refreshArtifacts(selectedSessionId);
    const interval = window.setInterval(() => void refreshArtifacts(selectedSessionId), 2_000);
    return () => {
      window.clearInterval(interval);
      void refreshArtifacts(selectedSessionId);
    };
  }, [refreshArtifacts, runningRender, selectedSessionId]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({top: element.scrollHeight, behavior: chat.busy ? 'smooth' : 'auto'});
  }, [chat.messages, chat.busy]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(80, Math.max(24, textarea.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    uploadOperationRef.current += 1;
    setUploadingFiles(false);
    setWorkspaceUploads([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [selectedSessionId]);

  async function openSession(sessionId: string) {
    if (!sessionId || sessionId === selectedSessionId) {
      setMobileSidebarOpen(false);
      return;
    }
    invalidateWorkspaceUpload();
    const intent = ++sessionIntentRef.current;
    requestedSessionRef.current = sessionId;
    sessionOpeningRef.current = true;
    setNewProjectOpen(false);
    setCreatingProject(false);
    setLoadError('');
    setSelectedSessionId(sessionId);
    setMobileSidebarOpen(false);
    setChat(createChatState());
    setAgentReady(false);
    try {
      const [history] = await Promise.all([
        getHistory(sessionId),
        refreshArtifacts(sessionId),
      ]);
      if (sessionIntentRef.current !== intent) return;
      setChat(createChatState(history.messages));
      await stopAgent();
      if (sessionIntentRef.current !== intent) return;
      sessionOpeningRef.current = false;
      setAgentReady(false);
    } catch (error) {
      if (sessionIntentRef.current === intent) recordLoadError(error);
    }
  }

  function openNewProjectDialog() {
    setNewProjectName('');
    setNewProjectError('');
    setNewProjectNeedsSettings(false);
    setNewProjectOpen(true);
  }

  async function newProject() {
    const projectName = newProjectName.trim();
    if (!projectName || creatingProject) return;
    invalidateWorkspaceUpload();
    const intent = ++sessionIntentRef.current;
    requestedSessionRef.current = null;
    sessionOpeningRef.current = true;
    setCreatingProject(true);
    setNewProjectError('');
    setLoadError('');
    setMobileSidebarOpen(false);
    try {
      setAgentReady(false);
      await stopAgent();
      if (sessionIntentRef.current !== intent) return;
      const state = await createProject(projectName);
      if (sessionIntentRef.current !== intent) return;
      setSessions(state.sessions);
      requestedSessionRef.current = state.activeSessionId;
      sessionOpeningRef.current = false;
      setSelectedSessionId(state.activeSessionId);
      setChat(createChatState());
      setArtifacts([]);
      setWorkspaceView('workspace');
      setNewProjectOpen(false);
      setNewProjectName('');
    } catch (error) {
      if (sessionIntentRef.current !== intent) return;
      sessionOpeningRef.current = false;
      setAgentReady(false);
      const event = toAgentErrorEvent(error);
      setNewProjectError(event.message || '无法创建项目');
      setNewProjectNeedsSettings(event.action === 'open_settings');
    } finally {
      if (sessionIntentRef.current === intent) setCreatingProject(false);
    }
  }

  function askAssistant(prompt: string) {
    setDraft(prompt);
    setWorkspaceView('workspace');
    void submit(prompt);
  }

  async function submit(override?: string) {
    const input = override ?? draft;
    const text = input.trim();
    if (!text || composerBusy || uploadingFiles || submissionRef.current) return;
    const intent = ++sessionIntentRef.current;
    requestedSessionRef.current = selectedSessionId || null;
    const submission = {id: `local-user-${Date.now()}`, accepted: false};
    const attachments = workspaceUploads;
    const creatingFromPrompt = !selectedSessionId;
    const existingSessionIds = new Set(sessions.map((session) => session.sessionId));
    submissionRef.current = submission;
    setSending(true);
    setLoadError('');
    setChat((current) => appendLocalUser(current, text, submission.id));
    try {
      if (!agentReady) {
        sessionOpeningRef.current = true;
        await startAgent(selectedSessionId ? {sessionId: selectedSessionId} : {newSession: true});
        if (sessionIntentRef.current !== intent || submissionRef.current !== submission) return;
        sessionOpeningRef.current = false;
        setAgentReady(true);
      }
      if (submissionRef.current !== submission || sessionIntentRef.current !== intent) return;
      const outbound = composeAgentPrompt(text, attachments.map((file) => file.path));
      await sendMessage(outbound);
      submission.accepted = true;
      if (submissionRef.current !== submission || sessionIntentRef.current !== intent) return;
      setDraft((current) => current === input ? '' : current);
      setWorkspaceUploads((current) => current.filter((file) => !attachments.some((sent) => sent.path === file.path)));
    } catch (error) {
      if (submissionRef.current !== submission || sessionIntentRef.current !== intent) return;
      sessionOpeningRef.current = false;
      const event = toAgentErrorEvent(error);
      if (event.phase === 'startup') setAgentReady(false);
      if (submission.accepted && event.phase !== 'startup') event.message = `${event.message}。原输入已保留，请先确认会话结果再重试。`;
      setChat((current) => applyAgentEvent(submission.accepted ? current : removePendingLocalUser(current, submission.id), event));
      if (creatingFromPrompt) await recoverStartupProject(event, existingSessionIds, intent);
    } finally {
      if (submissionRef.current === submission) {
        submissionRef.current = null;
        setSending(false);
        if (!submission.accepted && sessionIntentRef.current !== intent) setChat((current) => ({...removePendingLocalUser(current, submission.id), busy: false}));
      }
    }
  }

  async function recoverStartupProject(event: AgentEvent, existingSessionIds: Set<string>, intent: number, projectName?: string): Promise<boolean> {
    if (event.phase !== 'startup' || !['missing_llm_api_key', 'invalid_config', 'runtime_startup_failed'].includes(event.code || '')) return false;
    try {
      const state = await refreshSessions();
      if (sessionIntentRef.current !== intent) return false;
      const created = state.sessions.find((session) => session.sessionId === state.activeSessionId
        && !existingSessionIds.has(session.sessionId) && (projectName === undefined || session.projectName === projectName));
      if (!created) return false;
      const history = await getHistory(created.sessionId);
      if (sessionIntentRef.current !== intent) return false;
      requestedSessionRef.current = created.sessionId;
      sessionOpeningRef.current = false;
      setSelectedSessionId(created.sessionId);
      setChat((current) => {
        const previousError = [...current.messages].reverse().find((message) => message.role === 'error'
          && message.phase === 'startup' && message.code === event.code);
        return applyAgentEvent(createChatState(history.messages), {...event, diagnostics: event.diagnostics || previousError?.diagnostics});
      });
      setArtifacts([]);
      void refreshArtifacts(created.sessionId);
      setWorkspaceView('workspace');
      return true;
    } catch {
      // Keep the original actionable error when the workspace cannot yet be read.
      return false;
    }
  }

  function recordLoadError(error: unknown) {
    sessionOpeningRef.current = false;
    const event = toAgentErrorEvent(error);
    setAgentReady(false);
    if (event.phase === 'startup' || event.action === 'open_settings') {
      setLoadError('');
      setChat((current) => applyAgentEvent(current, event));
    } else setLoadError(event.message || '无法打开项目');
  }

  function invalidateWorkspaceUpload() {
    uploadOperationRef.current += 1;
    setUploadingFiles(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function uploadFiles(files: FileList | null) {
    const sessionId = selectedSessionId;
    if (!files?.length) return;
    if (!sessionId) {
      setLoadError('请先创建或选择项目，再上传文件');
      return;
    }
    const operation = ++uploadOperationRef.current;
    const isCurrent = () => uploadOperationRef.current === operation && requestedSessionRef.current === sessionId;
    setUploadingFiles(true);
    setLoadError('');
    await runWorkspaceUpload(Array.from(files), {
      isCurrent,
      upload: (file) => uploadWorkspaceFile(sessionId, file),
      onUploaded: (result) => {
        setWorkspaceUploads((current) => [
          ...current.filter((item) => item.path !== result.file.path),
          result.file,
        ]);
      },
      refresh: () => refreshArtifacts(sessionId),
      onError: (error) => setLoadError(localizeRuntimeText(error instanceof Error ? error.message : String(error))),
      onComplete: () => {
        if (fileInputRef.current) fileInputRef.current.value = '';
        setUploadingFiles(false);
        textareaRef.current?.focus();
      },
    });
  }

  async function stop() {
    const submission = submissionRef.current;
    submissionRef.current = null;
    setSending(false);
    if (submission && !submission.accepted) setChat((current) => removePendingLocalUser(current, submission.id));
    try { await stopAgent(); } catch (error) { recordLoadError(error); }
    setAgentReady(false);
    setChat((current) => ({...current, busy: false}));
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    const sessionId = pendingDelete.sessionId;
    const deletingSelected = sessionId === selectedSessionId;
    if (deletingSelected) invalidateWorkspaceUpload();
    setDeleting(true);
    setLoadError('');
    try {
      const state = await deleteSession(sessionId);
      clearDirectorDraft(sessionId);
      setSessions(state.sessions);
      setPendingDelete(undefined);
      if (deletingSelected) {
        setSelectedSessionId('');
        setChat(createChatState());
        setArtifacts([]);
        setAgentReady(false);
        if (state.activeSessionId) await openSession(state.activeSessionId);
      }
    } catch (error) {
      setLoadError(localizeRuntimeText(error instanceof Error ? error.message : String(error)));
    } finally {
      setDeleting(false);
    }
  }

  const contextPercent = Math.min(100, Math.round((chat.promptTokens / CONTEXT_TARGET) * 100));
  const hasConversation = chat.messages.length > 0;

  return (
    <div className="app-shell glass-app" data-view={workspaceView}>
      <aside className="capsule-rail" data-capsule="navigation" aria-label="FrameFlow 导航">
        <nav className="primary-nav capsule-nav" aria-label="主导航">
          {([{view: 'workspace', title: '创作助手', Icon: Sparkles}, {view: 'director', title: '导演台', Icon: Film}, {view: 'artifacts', title: '素材', Icon: Files}, {view: 'editor', title: '剪辑', Icon: Scissors}, {view: 'settings', title: '设置', Icon: Settings}] as const).map(({view, title, Icon}) => (
            <button key={view} className={workspaceView === view ? 'is-active' : ''} onClick={() => setWorkspaceView(view)} aria-current={workspaceView === view ? 'page' : undefined}><Icon size={21}/><span>{title}</span></button>
          ))}
          <button className="capsule-new-project" onClick={openNewProjectDialog}><Plus size={21}/><span>新建项目</span></button>
        </nav>
      </aside>
      <main className="workspace-main glass-workspace">
        <header className="workspace-header glass-header">
          <div className="project-switcher">
            <button className="project-switcher-button" aria-expanded={mobileSidebarOpen} aria-controls="frameflow-project-menu" onClick={() => setMobileSidebarOpen((value) => !value)}><Folder size={16}/><span>{selectedSession ? sessionTitle(selectedSession) : '选择项目'}</span><ChevronDown size={14}/></button>
            {mobileSidebarOpen && <>
              <button className="project-menu-scrim" onClick={() => setMobileSidebarOpen(false)} aria-label="关闭项目菜单" />
              <section id="frameflow-project-menu" className="project-menu" aria-label="项目列表" onKeyDown={(event) => { if (event.key === 'Escape') setMobileSidebarOpen(false); }}>
                <header><strong>我的项目</strong><button className="icon-button" onClick={() => setMobileSidebarOpen(false)} aria-label="关闭项目菜单"><X size={16}/></button></header>
                <div className="session-list">{sessions.map((session) => <div key={session.sessionId} className={`session-item ${session.sessionId === selectedSessionId ? 'is-selected' : ''}`}><button className="session-open" onClick={() => void openSession(session.sessionId)}><span className="session-copy"><strong>{sessionTitle(session)}</strong><small>{relativeTime(session.updatedAt)} · {stageLabel(session.stage)}</small></span></button><button className="session-delete" onClick={() => { setPendingDelete(session); setMobileSidebarOpen(false); }} aria-label={`删除 ${sessionTitle(session)}`}><Trash2 size={14}/></button></div>)}{sessions.length === 0 && <p className="empty-list">还没有项目</p>}</div>
                <button className="project-menu-new" onClick={() => { setMobileSidebarOpen(false); openNewProjectDialog(); }}><FolderPlus size={16}/>新建项目</button>
              </section>
            </>}
          </div>
          <span className="glass-page-label">{workspaceView === 'director' ? '导演台' : workspaceView === 'editor' ? '视频剪辑' : workspaceView === 'artifacts' ? '作品与素材' : workspaceView === 'settings' ? '设置' : '创作助手'}</span>
          <div className="glass-header-actions">
            {workspaceView === 'workspace' && <button className="icon-button artifact-toggle" onClick={() => setStoryboardPanelOpen((value) => !value)} aria-label="切换分镜预览"><PanelRight size={18}/>{storyboardCount > 0 && <span className="count-badge">{storyboardCount}</span>}</button>}
          </div>
        </header>
        <div className="glass-content">
        {workspaceView === 'workspace' ? (
          <div className="conversation" ref={scrollRef}>
            {!hasConversation ? (
              <EmptyState />
            ) : (
              <div className="message-stream">
                {chat.messages.map((message) => <MessageRow key={message.id} message={message} onOpenSettings={openSettings} />)}
                {chat.busy && <ThinkingRow messages={chat.messages} starting={sending && !agentReady} sending={sending} />}
              </div>
            )}
          </div>
        ) : workspaceView === 'director' ? (
          <DirectorView
            key={selectedSessionId || 'empty'}
            session={selectedSession}
            artifacts={artifacts}
            onCreateProject={openNewProjectDialog}
            onOpenAssistant={() => setWorkspaceView('workspace')}
            onOpenEditor={() => setWorkspaceView('editor')}
            onAskAssistant={askAssistant}
            assistantName={assistantName}
            onSelectAssistant={() => openSettings(undefined, 'assistant')}
            onOpenSettings={() => openSettings(undefined, 'video')}
            onArtifactsChanged={() => { if (selectedSessionId) void refreshArtifacts(selectedSessionId); }}
          />
        ) : workspaceView === 'editor' ? (
          selectedSession ? <VideoEditorView key={selectedSessionId} session={selectedSession} onBack={() => setWorkspaceView('director')} onArtifactsChanged={() => void refreshArtifacts(selectedSessionId)} /> : <div className="editor-project-empty"><Scissors size={38}/><h1>剪辑已有视频</h1><p>选择或新建项目，导入视频后让 Agent 制定剪辑方案。</p><button className="director-button primary" onClick={openNewProjectDialog}><Plus size={16}/>新建项目</button><CapsuleDock><div className="capsule-command"><span>先选择一个项目，开始剪辑</span></div><div className="capsule-actions"><button className="director-button" onClick={() => setMobileSidebarOpen(true)}><Folder size={16}/>选择项目</button></div></CapsuleDock></div>
        ) : workspaceView === 'artifacts' ? (
          <ArtifactsView session={selectedSession} artifacts={artifacts} />
        ) : (
          <SettingsView focusRole={settingsFocus.role} focusNovelRetrieval={settingsFocus.novelRetrieval} focusRequest={settingsFocus.request} />
        )}

        </div>
        <div id="frameflow-action-dock" className="capsule-dock-slot" />
        {workspaceView !== 'director' && workspaceView !== 'editor' && <CapsuleDock className="assistant-dock">
          <div className="capsule-feedback-stack">{loadError && <div className="inline-error" role="alert"><span>{loadError}</span><button onClick={() => setLoadError('')} aria-label="关闭错误提示"><X size={15}/></button></div>}{(workspaceUploads.length > 0 || uploadingFiles) && <div className="composer-attachments" aria-live="polite">{workspaceUploads.map((file) => <span className="composer-attachment" key={file.path} title={file.path}><FileText size={13}/><span>{file.name}</span><button type="button" onClick={() => setWorkspaceUploads((current) => current.filter((item) => item.path !== file.path))} aria-label={`从这条消息中移除 ${file.name}`}><X size={12}/></button></span>)}{uploadingFiles && <span className="composer-uploading">正在上传…</span>}</div>}</div>
          {showSlashCommands && <SlashCommandMenu matches={slashMatches} contextPercent={contextPercent} onSelect={(command) => { setDraft(command); textareaRef.current?.focus(); }} />}
          <div className="capsule-actions capsule-import-actions">
            <input ref={fileInputRef} className="composer-file-input" type="file" multiple onChange={(event) => void uploadFiles(event.currentTarget.files)} tabIndex={-1}/>
            <button type="button" className="dock-icon-button" onClick={() => fileInputRef.current?.click()} disabled={!selectedSessionId || uploadingFiles || composerBusy} aria-label="上传文件到工作区" aria-busy={uploadingFiles} title={selectedSessionId ? '导入素材或附件' : '请先创建或选择项目'}><Plus size={20}/></button>
          </div>
          <div className="capsule-command">
            <button className="dock-executor-button" onClick={() => openSettings(undefined, 'assistant')} title="更换创作助手" disabled={composerBusy}><Sparkles size={15}/><span>{assistantName}</span><ChevronDown size={13}/></button>
            <div className="assistant-draft-field">
            <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => setComposingDraft(true)} onCompositionEnd={() => setComposingDraft(false)} onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return; }
              if (event.key === 'Tab' && slashMatches[0]) { event.preventDefault(); setDraft(slashMatches[0].name); return; }
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setWorkspaceView('workspace'); void submit(); }
            }} placeholder={workspaceView === 'artifacts' ? '告诉 Agent 如何使用这些素材…' : workspaceView === 'settings' ? '给创作助手一个任务…' : '描述你的创作想法…'} aria-label="向 FrameFlow 发送消息" disabled={composerBusy} rows={1}/>
            {workspaceView === 'workspace' && <AssistantPromptHints active={!draft.trim() && !composingDraft && !composerBusy && !uploadingFiles} onSelect={(prompt) => { setDraft(prompt); requestAnimationFrame(() => { const input = textareaRef.current; input?.focus(); input?.setSelectionRange(prompt.length, prompt.length); }); }} />}
            </div>
            {composerBusy ? <button className="dock-send-button stop" onClick={() => void stop()} aria-label="停止生成"><CircleStop size={19}/></button> : <button className="dock-send-button" onClick={() => { setWorkspaceView('workspace'); void submit(); }} disabled={!draft.trim() || uploadingFiles} aria-label="发送消息"><ArrowUp size={19}/></button>}
          </div>
          <div className="capsule-actions dock-status"><span className={`dock-status-dot ${composerBusy ? 'is-busy' : ''}`}/><span>{composerBusy ? '正在创作' : '创作助手'}</span></div>

        </CapsuleDock>}
      </main>

      <StoryboardPanel
        open={storyboardPanelOpen && workspaceView === 'workspace'}
        artifacts={artifacts}
        activeRenderStage={runningRender?.stage}
        onClose={() => setStoryboardPanelOpen(false)}
        onCountChange={setStoryboardCount}
      />
      <DeleteProjectDialog
        session={pendingDelete}
        deleting={deleting}
        onCancel={() => !deleting && setPendingDelete(undefined)}
        onConfirm={() => void confirmDelete()}
      />
      <NewProjectDialog
        open={newProjectOpen}
        name={newProjectName}
        error={newProjectError}
        creating={creatingProject}
        onOpenSettings={newProjectNeedsSettings ? () => {
          setNewProjectOpen(false);
          openSettings(undefined, 'assistant');
        } : undefined}
        onNameChange={(value) => {
          setNewProjectName(value);
          setNewProjectError('');
        }}
        onCancel={() => {
          if (creatingProject) return;
          setNewProjectOpen(false);
          setNewProjectError('');
        }}
        onConfirm={() => void newProject()}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <div className="assistant-welcome-icon" aria-hidden="true"><Sparkles size={30}/></div>
      <h1>今天想创作什么？</h1>
      <p className="assistant-welcome-description">从一个想法开始，一起写剧本、拆分镜头。</p>
    </section>
  );
}

const ASSISTANT_PROMPT_HINTS = [
  '帮我把一个想法写成短片剧本',
  '把这段故事拆成镜头，补充画面描述',
  '为分镜整理角色、场景和画面风格',
  '我已有视频，先帮我梳理剪辑思路',
];

function AssistantPromptHints({active, onSelect}: {active: boolean; onSelect: (prompt: string) => void}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!active) { setPaused(false); return; }
    if (paused) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    const restart = () => {
      window.clearInterval(timer);
      if (!motion.matches && !document.hidden) timer = window.setInterval(() => setIndex((value) => (value + 1) % ASSISTANT_PROMPT_HINTS.length), 5000);
    };
    restart();
    motion.addEventListener('change', restart);
    document.addEventListener('visibilitychange', restart);
    return () => { window.clearInterval(timer); motion.removeEventListener('change', restart); document.removeEventListener('visibilitychange', restart); };
  }, [active, paused]);
  return <div className="assistant-prompt-hints">
    {active ? <button type="button" className="assistant-prompt-example" onClick={() => onSelect(ASSISTANT_PROMPT_HINTS[index])} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} aria-label={`填入创作示例：${ASSISTANT_PROMPT_HINTS[index]}`} title={`填入示例：${ASSISTANT_PROMPT_HINTS[index]}`}><span className="assistant-prompt-prefix">试试</span><span className="assistant-prompt-text" key={index}>{ASSISTANT_PROMPT_HINTS[index]}</span><ArrowUp size={11}/></button> : <span>Enter 发送 · Shift + Enter 换行</span>}
  </div>;
}

function MessageRow({message, onOpenSettings}: {message: Message; onOpenSettings: (code?: string) => void}) {
  if (message.role === 'activity') return <ActivityRow message={message} onOpenSettings={onOpenSettings} />;
  return (
    <article className={`message-row role-${message.role}`}>
      <div className="message-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a: (props) => <a {...props} target="_blank" rel="noreferrer" />}}>
          {message.text}
        </ReactMarkdown>
        {message.action === 'open_settings' && <button type="button" className="message-error-action" onClick={() => onOpenSettings(message.code)}>{isNovelRetrievalError(message.code) ? '配置小说检索' : '前往设置'}</button>}
        {message.diagnostics && <MessageDiagnostics text={message.diagnostics} />}
      </div>
    </article>
  );
}

function ActivityRow({message, onOpenSettings}: {message: Message; onOpenSettings: (code?: string) => void}) {
  const stage = message.stage ? humanize(message.stage) : '';
  const detail = stage.toLowerCase() === message.text.toLowerCase() ? message.text : [stage, message.text].filter(Boolean).join(' · ');
  const toolKind = activityToolKind(message.tool);
  return (
    <div className={`activity-row status-${message.status || 'done'}`}>
      <span className={`activity-indicator tool-${toolKind}`}><ActivityToolIcon tool={message.tool} /></span>
      <div>
        <strong>{humanize(message.tool || '工作流程')}</strong>
        <span>{detail}</span>
        {message.action === 'open_settings' && <button type="button" className="message-error-action" onClick={() => onOpenSettings(message.code)}>{isNovelRetrievalError(message.code) ? '配置小说检索' : '前往设置'}</button>}
        {message.diagnostics && <MessageDiagnostics text={message.diagnostics} />}
      </div>
    </div>
  );
}

function MessageDiagnostics({text}: {text: string}) {
  return <details className="message-diagnostics"><summary>查看诊断信息</summary><pre>{text}</pre></details>;
}

function ActivityToolIcon({tool}: {tool?: string}) {
  const name = (tool || '').toLowerCase();
  const props = {size: 13, strokeWidth: 1.8};
  if (name.includes('narrative_planning') || name.includes('novel_planning')) return <FilePenLine {...props} />;
  if (name.includes('render_video')) return <Film {...props} />;
  if (name === 'view_image' || name.includes('image')) return <ImageIcon {...props} />;
  if (name === 'read_json' || name === 'write_json') return <Braces {...props} />;
  if (name === 'read_file' || name === 'write_file') return <FileText {...props} />;
  if (name === 'list_files' || name === 'glob_files') return <Folder {...props} />;
  if (name === 'search_text') return <Search {...props} />;
  if (name.startsWith('memory_')) return <Brain {...props} />;
  if (name.startsWith('todo_')) return <ListChecks {...props} />;
  if (name === 'run_shell') return <Terminal {...props} />;
  if (name === 'sleep') return <Clock3 {...props} />;
  return <Wrench {...props} />;
}

function activityToolKind(tool?: string) {
  const name = (tool || '').toLowerCase();
  if (name.includes('narrative_planning') || name.includes('novel_planning')) return 'planning';
  if (name.includes('render_video')) return 'render';
  if (name === 'view_image' || name.includes('image')) return 'image';
  if (name.startsWith('memory_')) return 'memory';
  if (name.startsWith('todo_')) return 'todo';
  if (name === 'run_shell') return 'shell';
  if (name === 'sleep') return 'time';
  return 'file';
}

function ThinkingRow({messages, starting, sending}: {messages: Message[]; starting: boolean; sending: boolean}) {
  const running = [...messages].reverse().find((message) => message.role === 'activity' && message.status === 'running');
  return (
    <div className="thinking-row">
      <span className="thinking-mark"><i /><i /><i /></span>
      <span>{starting ? '正在启动创作助手…' : sending ? '正在发送消息…' : running ? `${humanize(running.tool || 'FrameFlow')} · ${running.text}` : 'FrameFlow 正在思考'}</span>
    </div>
  );
}

function SlashCommandMenu({matches, contextPercent, onSelect}: {matches: SlashCommandMatch[]; contextPercent: number; onSelect: (command: string) => void}) {
  return (
    <div className="slash-command-menu" role="listbox" aria-label="快捷命令">
      {matches.length > 0 ? matches.map((command) => (
        <button key={command.name} role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(command.name)}>
          <code><span><b>{command.matchedPrefix}</b><span>{command.unmatchedSuffix}</span></span>{command.name === '/compact' && <em>{contextPercent}%</em>}</code>
          <small>{command.description}</small>
        </button>
      )) : <span className="slash-command-empty">没有匹配的命令</span>}
    </div>
  );
}

const CONFIG_SECTIONS: Array<{key: keyof AgentConfig['sections']; title: string; description: string}> = [
  {key: 'llm', title: '创作助手', description: '用于规划故事、选择工具和对话'},
  {key: 'image', title: '图像生成', description: '用于角色、关键帧和分镜画面'},
  {key: 'video', title: '视频生成', description: '用于生成镜头片段和最终视频'},
  {key: 'embedding', title: '文本向量模型', description: '使用检索 API 时，从小说中查找相关原文'},
  {key: 'reranker', title: '检索排序模型', description: '使用检索 API 时，筛选更相关的原文片段'},
];

function SettingsView({focusRole, focusNovelRetrieval, focusRequest}: {focusRole?: ExecutorRole; focusNovelRetrieval?: boolean; focusRequest?: number}) {
  const [config, setConfig] = useState<AgentConfig>();
  const [savedConfig, setSavedConfig] = useState<AgentConfig>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retrievalSaving, setRetrievalSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [presetKey, setPresetKey] = useState('');
  const [appliedPreset, setAppliedPreset] = useState('');
  const configLoadRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const request = ++configLoadRequest.current;
    void getAgentConfig()
      .then((payload) => {
        if (cancelled || request !== configLoadRequest.current) return;
        setConfig(payload);
        setSavedConfig(payload);
      })
      .catch((error) => !cancelled && request === configLoadRequest.current && setStatus(localizeRuntimeText(error instanceof Error ? error.message : String(error))))
      .finally(() => !cancelled && request === configLoadRequest.current && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  function applyPreset(preset: ModelPreset) {
    setConfig((current) => current ? applyModelPreset(current, preset, presetKey) : current);
    setStatus('');
    setAppliedPreset(preset.title);
  }

  async function save() {
    if (!config || saving || retrievalSaving) return;
    setSaving(true);
    setStatus('');
    try {
      const saved = await saveAgentConfig(config);
      window.dispatchEvent(new Event('frameflow:model-config-saved'));
      setConfig(saved);
      setSavedConfig(saved);
      setPresetKey('');
      setAppliedPreset('');
      setStatus('已保存');
    } catch (error) {
      setStatus(localizeRuntimeText(error instanceof Error ? error.message : String(error)));
    } finally {
      setSaving(false);
    }
  }

  function renderInterfaceSave(note: string) {
    return <><div className="executor-interface-save"><span>{note}</span><button type="button" className="executor-button primary" disabled={!config || saving || retrievalSaving} onClick={() => void save()}><Save size={13} />{saving ? '正在保存…' : '保存接口配置'}</button></div>{status && <p className={`executor-interface-status ${status === '已保存' ? '' : 'is-error'}`} role={status === '已保存' ? 'status' : 'alert'}>{status === '已保存' ? '接口配置已保存' : status}</p>}</>;
  }

  return (
    <section className="settings-view">
      <header>
        <div><span>本地配置</span><h1>设置</h1></div>
      </header>
      <ExecutorSettings
        config={savedConfig}
        configLoading={loading}
        managementSaving={saving || retrievalSaving}
        configError={!savedConfig ? status : undefined}
        focusRole={focusRole}
        focusRequest={focusRequest}
        assistantExtra={<NovelRetrievalSettings
          config={savedConfig}
          loading={loading}
          loadError={!savedConfig ? status : undefined}
          disabled={saving}
          focusRequest={focusNovelRetrieval ? focusRequest : undefined}
          onSavingChange={setRetrievalSaving}
          onSaved={(saved) => {
            configLoadRequest.current += 1;
            setConfig((current) => mergeConfigAfterNovelRetrieval(current, savedConfig, saved));
            setSavedConfig(saved); setLoading(false); setStatus('');
          }}
        />}
        onSelectionSaved={(saved, touchedSection) => {
          configLoadRequest.current += 1;
          setConfig((current) => mergeConfigAfterSelection(current, savedConfig, saved, touchedSection));
          setSavedConfig(saved);
          setLoading(false);
          setStatus('');
        }}
        renderApiEditor={(section, draft, onChange, disabled) => <ConfigSectionEditor
          definition={CONFIG_SECTIONS.find((definition) => definition.key === section)!}
          value={draft}
          needsNewKey={requiresPlatformKey(draft, savedConfig?.sections[section].base_url ?? draft.base_url)}
          disabled={disabled}
          compact
          onChange={(field, value) => {
            if (field === 'api_provider' && (section === 'image' || section === 'video') && (value === 'openrouter' || value === 'yunwu' || (section === 'video' && value === 'aliyun'))) {
              const next = applyMediaProvider(draft, value);
              onChange('api_provider', value); onChange('base_url', next.base_url);
              if (next.model !== draft.model) onChange('model', next.model);
              if (next.api_key !== draft.api_key) onChange('api_key', next.api_key);
            } else onChange(field, value);
          }}
        />}
      />
      <details id="local-agent-detection-details" className="settings-disclosure"><summary>查看全部检测结果</summary><LocalAgentsSettings /></details>
      {loading ? <div className="settings-loading">正在加载模型配置…</div> : !config ? <div className="settings-loading is-error">{status || '无法读取模型配置'}</div> : <>
      <details className="settings-disclosure"><summary>管理接口 · 推荐配置</summary><section className="model-presets" aria-labelledby="model-presets-title">
        <header>
          <h2 id="model-presets-title">推荐模型组合</h2>
          <p>当前已核对 OpenRouter 模型目录；一把 OpenRouter 密钥可用于这三项。组合仅修改接口配置草稿，不改变当前执行者选择。</p>
        </header>
        <label className="model-preset-key">
          <span>OpenRouter 共用密钥 <small>也可展开各环节的接口配置分别填写</small></span>
          <input type="password" value={presetKey} onChange={(event) => setPresetKey(event.target.value)} placeholder="填写后，选择组合时一并填入" autoComplete="off" disabled={saving || retrievalSaving} />
        </label>
        <div className="model-preset-grid">
          {MODEL_PRESETS.map((preset) => (
            <article key={preset.id} className={`model-preset ${preset.recommended ? 'is-recommended' : ''}`}>
              <header><h3>{preset.title}</h3>{preset.recommended && <span>默认推荐</span>}</header>
              <p>{preset.description}</p>
              <dl>
                <div><dt>创作助手</dt><dd>{preset.models.llm}</dd></div>
                <div><dt>图像生成</dt><dd>{preset.models.image}</dd></div>
                <div><dt>视频生成</dt><dd>{preset.models.video}</dd></div>
              </dl>
              <button type="button" onClick={() => applyPreset(preset)} disabled={saving || retrievalSaving} aria-label={`使用${preset.title}组合`}>使用此组合</button>
            </article>
          ))}
        </div>
        {appliedPreset && <p className="model-preset-status" role="status">已填入“{appliedPreset}”接口草稿，请保存接口配置。</p>}
        <p className="model-preset-note">模型接口已核对，实际效果需试用；OpenRouter 按用量计费。<a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">模型目录</a><a href="https://openrouter.ai/docs/guides/overview/multimodal/video-generation" target="_blank" rel="noreferrer">视频服务说明</a></p>
        {renderInterfaceSave('仅管理接口配置，不改变创作环节的执行者选择。')}
      </section></details>
      </>}
    </section>
  );
}

function NovelRetrievalSettings({config, loading, loadError, disabled, focusRequest, onSavingChange, onSaved}: {
  config?: AgentConfig; loading: boolean; loadError?: string; disabled: boolean; focusRequest?: number;
  onSavingChange: (saving: boolean) => void; onSaved: (saved: AgentConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NovelRetrievalDraft>();
  const [mode, setMode] = useState<NovelRetrievalMode>('assistant');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const mounted = useRef(false);
  const operation = useRef(false);
  const handledFocus = useRef<number>();
  const blocked = disabled || saving;
  const state = novelRetrievalStatus(config);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open && config && !draft) { setDraft(createNovelRetrievalDraft(config)); setMode(novelRetrievalMode(config)); } }, [config, draft, open]);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest || blocked) return;
    handledFocus.current = focusRequest; setOpen(true); setFeedback('');
    const frame = window.requestAnimationFrame(() => {
      detailsRef.current?.scrollIntoView({behavior: 'auto', block: 'center'});
      detailsRef.current?.querySelector<HTMLElement>('summary')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, blocked]);

  function change(section: keyof NovelRetrievalDraft, field: keyof ConfigSection, value: string) {
    setDraft((current) => current ? {...current, [section]: {...current[section], [field]: value}} : current);
    setError(''); setFeedback('');
  }
  function cancel() { if (!operation.current) { setOpen(false); setDraft(undefined); setError(''); setFeedback(''); } }
  async function save() {
    if (!draft || loading || disabled || operation.current) return;
    const validation = validateNovelRetrievalDraft(draft, mode);
    if (validation) { setError(validation); return; }
    operation.current = true; setSaving(true); onSavingChange(true); setError(''); setFeedback('');
    try {
      const saved = await saveAgentConfig(novelRetrievalSavePayload(draft, mode));
      window.dispatchEvent(new Event('frameflow:model-config-saved'));
      if (!mounted.current) return;
      onSaved(saved); setOpen(false); setDraft(undefined); setFeedback('小说检索已保存');
    } catch (reason) {
      if (mounted.current) {
        const message = localizeRuntimeText(reason instanceof Error ? reason.message : String(reason));
        const names: Record<string, string> = {embedding: '文本向量模型', reranker: '检索排序模型', base_url: '服务地址', api_key: '密钥', model_provider: '模型提供方', model: '模型名称'};
        setError(message.replace(/\b(embedding|reranker)\.(base_url|api_key|model_provider|model)\b/g, (_, section: string, field: string) => `${names[section]}${names[field]}`));
      }
    } finally { operation.current = false; if (mounted.current) { setSaving(false); onSavingChange(false); } }
  }

  return <details id="novel-retrieval-settings" ref={detailsRef} className="novel-retrieval" open={open} onToggle={(event) => {
    const nextOpen = event.currentTarget.open;
    setOpen(nextOpen);
    if (!nextOpen && !operation.current) { setDraft(undefined); setError(''); }
    if (nextOpen) setFeedback('');
  }}>
    <summary aria-disabled={blocked} onClick={(event) => { if (blocked) event.preventDefault(); }}><span>小说检索</span><span className={`novel-retrieval-status ${state.ready ? 'is-ready' : ''}`}>{loading ? '正在读取…' : state.label}</span></summary>
    <div className="novel-retrieval-body"><p>查找小说原文，为改编提供依据。</p>
      {loading ? <p role="status">正在读取小说检索配置…</p> : !draft ? <p role="alert">{loadError || '无法读取配置，请重新打开设置。'}</p> : <>
        <fieldset className="novel-retrieval-modes" disabled={blocked}><legend>检索方式</legend>
          <label className={mode === 'assistant' ? 'is-selected' : ''}><input type="radio" name="novel-retrieval-mode" value="assistant" checked={mode === 'assistant'} onChange={() => { setMode('assistant'); setError(''); setFeedback(''); }} /><span><strong>沿用创作助手 <small>默认</small></strong><span>在本地搜索原文，由当前助手筛选，无需额外配置检索接口。</span></span></label>
          <label className={mode === 'api' ? 'is-selected' : ''}><input type="radio" name="novel-retrieval-mode" value="api" checked={mode === 'api'} onChange={() => { setMode('api'); setError(''); setFeedback(''); }} /><span><strong>使用检索 API <small>高级</small></strong><span>使用专用的向量和排序服务。</span></span></label>
        </fieldset>
        {mode === 'api' && <div className="novel-retrieval-fields">{(['embedding', 'reranker'] as const).map((section) => {
          const definition = CONFIG_SECTIONS.find((item) => item.key === section)!;
          return <section className="novel-retrieval-service" key={section}><header><h4>{definition.title}</h4><p>{section === 'embedding' ? '查找相关原文' : '筛选更相关的片段'}</p></header><ConfigSectionEditor
            definition={definition} value={draft[section]} compact
            needsNewKey={requiresPlatformKey(draft[section], config?.sections[section].base_url ?? draft[section].base_url)}
            disabled={blocked} onChange={(field, value) => change(section, field, value)}
          /></section>;
        })}</div>}
        {error && <p className="novel-retrieval-error" role="alert">{error}</p>}
        <footer><button type="button" className="executor-button" disabled={blocked} onClick={cancel}>取消</button><button type="button" className="executor-button primary" disabled={blocked} onClick={() => void save()}><Save size={13}/>{saving ? '正在保存…' : '保存并使用'}</button></footer>
      </>}
    </div>{feedback && <span className="novel-retrieval-feedback" role="status">{feedback}</span>}
  </details>;
}

function ConfigSectionEditor({definition, value, needsNewKey, disabled, compact, onChange}: {
  definition: {key: keyof AgentConfig['sections']; title: string; description: string};
  value: ConfigSection;
  needsNewKey: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChange: (field: keyof ConfigSection, value: string) => void;
}) {
  const platformFields = <>
    {(definition.key === 'image' || definition.key === 'video') && <label className="config-field-wide"><span>接口平台</span><select className="executor-platform-select" value={value.api_provider || ''} disabled={disabled} onChange={(event) => onChange('api_provider', event.target.value)}><option value="" disabled>请选择接口协议</option><option value="openrouter">OpenRouter</option><option value="yunwu">云雾</option>{definition.key === 'video' && <option value="aliyun">阿里云百炼 · 万相</option>}</select><small className="executor-platform-note">{definition.key === 'video' && value.api_provider === 'aliyun' ? '使用北京地域的 API Key。默认服务地址已填入。' : '兼容服务可手填地址，仍按所选平台协议调用。'}</small></label>}
    {value.model_provider !== undefined && <label><span>模型提供方</span><input value={value.model_provider} disabled={disabled} onChange={(event) => onChange('model_provider', event.target.value)} /></label>}
    <label className="config-field-wide"><span>服务地址</span><input id={`config-base-url-${definition.key}`} value={value.base_url} disabled={disabled} placeholder="请输入服务的接口地址" onChange={(event) => onChange('base_url', event.target.value)} inputMode="url" /></label>
  </>;
  return (
    <section id={`config-section-${definition.key}`} className={`config-section ${compact ? 'is-compact' : ''}`}>
      {!compact && <header><h2>{definition.title}</h2><p>{definition.description}</p></header>}
      <div className="config-fields">
        {!compact && platformFields}
        <label className={compact ? 'config-field-wide' : undefined}><span>模型名称</span><input value={value.model} disabled={disabled} placeholder={definition.key === 'embedding' ? '留空使用默认向量模型' : definition.key === 'reranker' ? '留空使用默认排序模型' : '请输入服务支持的模型名称'} onChange={(event) => onChange('model', event.target.value)} /></label>
        {definition.key === 'video' && value.api_provider === 'aliyun' && <p className="config-field-wide executor-platform-note">万相 Flash · 图生视频：需在导演台添加一张首帧图片，默认生成无声视频。新镜头默认 5 秒。</p>}
        <label className="config-field-wide">
          <span>接口密钥 <i className={needsNewKey ? 'needs-key' : value.has_api_key ? 'is-configured' : ''}>{needsNewKey ? '需要新密钥' : value.has_api_key ? '已配置' : '未配置'}</i></span>
          <input type="password" value={value.api_key} disabled={disabled} onChange={(event) => onChange('api_key', event.target.value)} placeholder={needsNewKey ? '请输入对应平台的接口密钥' : value.has_api_key ? '留空以保留当前密钥' : '请输入接口密钥'} aria-describedby={needsNewKey ? `platform-key-warning-${definition.key}` : undefined} autoComplete="off" />
          {needsNewKey && <small id={`platform-key-warning-${definition.key}`} className="platform-key-warning">更换服务后，请填写对应平台密钥</small>}
        </label>
        {compact && <details className="config-field-wide executor-api-advanced" open={needsNewKey || ((definition.key === 'image' || definition.key === 'video') && !value.api_provider) || ((definition.key === 'embedding' || definition.key === 'reranker') && !value.base_url)}><summary>服务地址与平台选项</summary><div className="config-fields">{platformFields}</div></details>}
      </div>
    </section>
  );
}

function useProjectDialogFocus(open: boolean, panelRef: RefObject<HTMLElement>, blocked: boolean, onCancel: () => void) {
  const state = useRef({blocked, onCancel});
  state.current = {blocked, onCancel};
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    const activeElement = document.activeElement;
    const previousFocus = activeElement instanceof HTMLElement && activeElement !== document.body
      ? activeElement
      : document.querySelector<HTMLButtonElement>('.project-switcher-button') || undefined;
    const controls = () => Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const focusFirst = () => (controls()[0] || panel).focus();
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!state.current.blocked) state.current.onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); panel.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('keydown', onKey, true);
    focusFirst();
    return () => {
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('keydown', onKey, true);
      if (previousFocus?.isConnected && (panel.contains(document.activeElement) || document.activeElement === document.body)) previousFocus.focus();
    };
  }, [open, panelRef]);
}

function DeleteProjectDialog({session, deleting, onCancel, onConfirm}: {
  session?: SessionSummary;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useProjectDialogFocus(!!session, panelRef, deleting, onCancel);

  if (!session) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section className="delete-dialog" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
        <span className="dialog-icon"><Trash2 size={18} /></span>
        <div className="dialog-copy">
          <h2 id="delete-project-title">删除项目？</h2>
          <p><strong>{sessionTitle(session)}</strong>及其生成的文件将被永久删除。</p>
        </div>
        <div className="dialog-actions">
          <button onClick={onCancel} disabled={deleting}>取消</button>
          <button className="danger" onClick={onConfirm} disabled={deleting}>{deleting ? '正在删除…' : '删除'}</button>
        </div>
      </section>
    </div>
  );
}

function NewProjectDialog({open, name, error, creating, onNameChange, onCancel, onConfirm, onOpenSettings}: {
  open: boolean;
  name: string;
  error: string;
  creating: boolean;
  onNameChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenSettings?: () => void;
}) {
  const panelRef = useRef<HTMLFormElement>(null);
  useProjectDialogFocus(open, panelRef, creating, onCancel);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <form className="project-dialog" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="new-project-title" onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}>
        <span className="dialog-icon is-create"><FolderPlus size={18} /></span>
        <div className="dialog-copy">
          <h2 id="new-project-title">新建项目</h2>
          <p>给你的创作项目起个名字。</p>
        </div>
        <label className="project-name-field">
          <span>项目名称</span>
          <input
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="未命名视频"
            maxLength={64}
            disabled={creating}
          />
          {error && <small role="alert">{error}</small>}
          {error && onOpenSettings && <button type="button" className="message-error-action" onClick={onOpenSettings} disabled={creating}>前往设置</button>}
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={creating}>取消</button>
          <button type="submit" className="primary" disabled={creating || !name.trim()}>{creating ? '正在创建…' : '创建'}</button>
        </div>
      </form>
    </div>
  );
}

function sessionTitle(session?: SessionSummary) {
  if (!session) return '新视频';
  if (session.projectName) return session.projectName;
  const source = session.idea || session.summary;
  if (source) return source.length > 38 ? `${source.slice(0, 38).trim()}…` : source;
  return session.sessionId.replace(/^\d{8}-\d{6}-?/, '') || '未命名视频';
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    created: '已创建',
    narrative_planning: '正在规划',
    narrative_planned: '故事方案已就绪',
    novel_planning: '正在规划小说',
    novel_planned: '小说方案已就绪',
    rendering: '正在生成视频',
    rendered: '视频已生成',
    error: '需要处理',
  };
  return labels[stage] || humanize(stage || 'created');
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '最近';
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}
