import type {Artifact, JsonValue} from './types';

export type StoryboardPreview = {
  id: string;
  description: string;
};

export type ReadinessStatus = 'ready' | 'partial' | 'missing' | 'inactive';

export type StoryboardReadiness = {
  overall: ReadinessStatus;
  readyToRender: boolean;
  storyboards: {status: ReadinessStatus; count: number};
  shotDescriptions: {status: ReadinessStatus; count: number; expected: number};
  cameraPlans: {status: ReadinessStatus; count: number; expected: number};
  render: {
    started: boolean;
    frames: {status: ReadinessStatus; count: number; expected: number};
    clips: {status: ReadinessStatus; count: number; expected: number};
    finalVideo: {status: ReadinessStatus; count: number; expected: number};
  };
};

export type RenderCheckpoint = 'frames' | 'clips' | 'finalVideo';

const FIELD_LABELS: Record<string, string> = {
  idx: '序号',
  index: '序号',
  name: '名称',
  title: '标题',
  character_name: '角色名称',
  scene_title: '场景标题',
  is_last: '是否为最后一幕',
  cam_idx: '机位',
  visual_desc: '画面描述',
  visual_description: '画面描述',
  audio_desc: '声音描述',
  description: '描述',
  ff_desc: '首帧',
  lf_desc: '尾帧',
  motion_desc: '动作描述',
  variation_type: '画面变化幅度',
  variation_reason: '变化说明',
  ff_vis_char_idxs: '首帧中的角色',
  lf_vis_char_idxs: '尾帧中的角色',
  character_idx: '角色',
  character_id: '角色',
  shot_idx: '镜头',
  scene_idx: '场景',
  camera_idx: '机位',
  environment: '环境',
  slugline: '场景标记',
  process_chain: '事件过程',
  characters: '角色',
  character: '角色',
  scenes: '场景',
  shots: '镜头',
  storyboards: '分镜',
  storyboard: '分镜',
  script: '剧本',
  story: '故事',
  identifier_in_scene: '场景中的角色名称',
  identifier_in_event: '事件中的角色名称',
  identifier_in_novel: '小说中的角色名称',
  is_visible: '是否出镜',
  static_features: '外貌特征',
  dynamic_features: '服饰与配件',
  active_scenes: '出现的场景',
  active_events: '出现的事件',
  active_shot_idxs: '适用镜头',
  parent_cam_idx: '参考机位',
  parent_shot_idx: '参考镜头',
  reason: '说明',
  is_parent_fully_covers_child: '参考机位是否完整覆盖',
  missing_info: '缺失信息',
  frame_type: '画面类型',
  vis_char_idxs: '出镜角色',
  location: '地点',
  time: '时间',
  weather: '天气',
  lighting: '灯光',
  atmosphere: '氛围',
  style: '风格',
  duration: '时长',
  summary: '摘要',
  events: '事件',
  items: '条目',
  content: '内容',
  prompt: '生成描述',
  image_prompt: '图像生成描述',
  video_prompt: '视频生成描述',
  status: '状态',
  width: '宽度',
  height: '高度',
  resolution: '分辨率',
  aspect_ratio: '画幅比例',
};

const FILE_TITLES: Record<string, string> = {
  camera_tree: '机位方案',
  characters: '角色',
  script: '剧本',
  story: '故事',
  shot_description: '镜头描述',
  storyboard: '分镜',
  character_portraits_registry: '角色形象',
  global_information: '整体设定',
  events: '事件',
  first_frame: '首帧',
  last_frame: '尾帧',
  video: '镜头片段',
  final_video: '最终视频',
  transition_video: '转场片段',
  new_camera_image: '新机位画面',
  front: '正面',
  side: '侧面',
  back: '背面',
};

export function isJsonArtifact(artifact: Artifact): boolean {
  const name = artifact.name.toLowerCase();
  return name.endsWith('.json') && name !== 'render_status.json';
}

export function isStoryboardArtifact(artifact: Artifact): boolean {
  return artifact.name.toLowerCase() === 'storyboard.json';
}

export function relatedVisualArtifacts(documentArtifact: Artifact, artifacts: Artifact[]): Artifact[] {
  const media = artifacts.filter((artifact) => artifact.kind === 'image' || artifact.kind === 'video');
  const documentPath = normalizeArtifactPath(documentArtifact.path);
  const documentDirectory = parentArtifactPath(documentPath);
  const shotDirectory = documentPath.match(/^(.*\/shots\/\d+)(?:\/|$)/i)?.[1];
  const sceneDirectory = documentPath.match(/^(.*\/scene_\d+)(?:\/|$)/i)?.[1];
  const workflowRoot = documentPath.split('/')[0] || '';
  const name = documentArtifact.name.toLowerCase();

  const related = media.filter((artifact) => {
    const mediaPath = normalizeArtifactPath(artifact.path);
    if (shotDirectory) return parentArtifactPath(mediaPath) === shotDirectory;
    if (sceneDirectory) return mediaPath.startsWith(`${sceneDirectory}/`);
    if (name === 'characters.json' || name === 'character_portraits_registry.json') {
      return mediaPath.startsWith(`${workflowRoot}/character_portraits/`);
    }
    if (name === 'script.json') {
      return mediaPath.startsWith(`${workflowRoot}/scene_`) || mediaPath === `${workflowRoot}/final_video.mp4`;
    }
    return parentArtifactPath(mediaPath) === documentDirectory;
  });

  return related.sort((left, right) => left.path.localeCompare(right.path, undefined, {numeric: true}));
}

export function friendlyFieldLabel(key: string): string {
  return FIELD_LABELS[key] || key;
}

export function isArtifactPathField(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return normalized.split('_').some((part) => part === 'path' || part === 'dir' || part === 'directory');
}

export function friendlyArtifactTitle(artifact: Artifact): string {
  const stem = artifact.name.replace(/\.[^.]+$/, '');
  const baseTitle = FILE_TITLES[stem.toLowerCase()] || stem;
  const sceneMatch = artifact.path.match(/(?:^|\/)scene_(\d+)(?:\/|$)/i);
  const shotMatch = artifact.path.match(/(?:^|\/)shots\/(\d+)(?:\/|$)/i);
  const context = [];
  if (sceneMatch) context.push(`场景 ${Number(sceneMatch[1]) + 1}`);
  if (shotMatch) context.push(`镜头 ${Number(shotMatch[1]) + 1}`);
  return context.length ? `${context.join(' · ')} · ${baseTitle}` : baseTitle;
}

export function structuredRecordTitle(value: JsonValue, index: number, artifact: Artifact): string {
  if (isJsonObject(value)) {
    for (const key of ['name', 'title', 'character_name', 'scene_title']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    const explicitIndex = value.idx;
    if (typeof explicitIndex === 'number') return `${recordNoun(artifact)} ${explicitIndex + 1}`;
  }
  return `${recordNoun(artifact)} ${index + 1}`;
}

export function formatStructuredValue(value: JsonValue, key = ''): string {
  if (value === null) return '未指定';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return isIndexKey(key) ? String(value + 1) : String(value);
  if (typeof value === 'string') {
    const labels = STRUCTURED_VALUE_LABELS[key];
    return labels?.[value] || value.trim() || '未指定';
  }
  if (Array.isArray(value) && value.every(isJsonPrimitive)) {
    if (value.length === 0) return '无';
    return value.map((item) => typeof item === 'number' && isIndexListKey(key) ? item + 1 : formatStructuredValue(item)).join('、');
  }
  return '';
}

export function extractStoryboardPreviews(document: JsonValue, sourcePath: string): StoryboardPreview[] {
  const previews: StoryboardPreview[] = [];

  function visit(value: JsonValue) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJsonObject(value)) return;
    const description = ['visual_desc', 'visual_description', 'description']
      .map((key) => value[key])
      .find((candidate) => typeof candidate === 'string' && candidate.trim());
    if (typeof description === 'string') {
      previews.push({id: `${sourcePath}:${previews.length}`, description: description.trim()});
      return;
    }
    for (const key of ['storyboards', 'storyboard', 'shots', 'scenes', 'items']) {
      const nested = value[key];
      if (nested !== undefined) visit(nested);
    }
  }

  visit(document);
  return previews;
}

export function deriveStoryboardReadiness(artifacts: Artifact[], storyboardCount: number): StoryboardReadiness {
  const storyboardFiles = artifacts.filter(isStoryboardArtifact).length;
  const shotDescriptions = artifacts.filter((artifact) => artifact.name.toLowerCase() === 'shot_description.json').length;
  const cameraPlans = artifacts.filter((artifact) => artifact.name.toLowerCase() === 'camera_tree.json').length;
  const frames = artifacts.filter((artifact) => artifact.name.toLowerCase() === 'first_frame.png').length;
  const clips = artifacts.filter((artifact) => artifact.name.toLowerCase() === 'video.mp4').length;
  const finalVideos = artifacts.filter((artifact) => artifact.name.toLowerCase() === 'final_video.mp4').length;
  const storyboards = checkpointStatus(storyboardCount, Math.max(storyboardFiles, 1));
  const shots = checkpointStatus(shotDescriptions, storyboardCount);
  const cameras = checkpointStatus(cameraPlans, storyboardFiles);
  const readyToRender = storyboardCount > 0
    && storyboards === 'ready'
    && shots === 'ready'
    && cameras === 'ready';
  const hasPlanningOutput = storyboardCount > 0 || shotDescriptions > 0 || cameraPlans > 0;

  return {
    overall: readyToRender ? 'ready' : hasPlanningOutput ? 'partial' : 'missing',
    readyToRender,
    storyboards: {status: storyboards, count: storyboardCount},
    shotDescriptions: {status: shots, count: shotDescriptions, expected: storyboardCount},
    cameraPlans: {status: cameras, count: cameraPlans, expected: storyboardFiles},
    render: {
      started: frames > 0 || clips > 0 || finalVideos > 0,
      frames: {status: renderCheckpointStatus(frames, storyboardCount), count: frames, expected: storyboardCount},
      clips: {status: renderCheckpointStatus(clips, storyboardCount), count: clips, expected: storyboardCount},
      finalVideo: {status: renderCheckpointStatus(finalVideos, 1), count: finalVideos, expected: 1},
    },
  };
}

export function activeRenderCheckpoint(stage: string): RenderCheckpoint {
  const normalized = stage.toLowerCase();
  if (normalized.includes('video_clip')) return 'clips';
  if (normalized.includes('concat') || normalized.includes('final_video') || normalized === 'render_done') return 'finalVideo';
  return 'frames';
}

export function isJsonObject(value: JsonValue): value is {[key: string]: JsonValue} {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonPrimitive(value: JsonValue): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function recordNoun(artifact: Artifact): string {
  const name = artifact.name.toLowerCase();
  if (name === 'storyboard.json' || name === 'shot_description.json') return '镜头';
  if (name === 'characters.json') return '角色';
  if (name === 'script.json') return '场景';
  if (name === 'camera_tree.json') return '机位';
  return '条目';
}

const STRUCTURED_VALUE_LABELS: Record<string, Record<string, string>> = {
  variation_type: {large: '大幅变化', medium: '中等变化', small: '轻微变化'},
  frame_type: {first: '首帧', last: '尾帧', first_frame: '首帧', last_frame: '尾帧'},
  status: {pending: '待处理', in_progress: '进行中', completed: '已完成', failed: '失败', ready: '已就绪'},
};

function isIndexKey(key: string): boolean {
  return key === 'idx' || key === 'index' || key.endsWith('_idx') || key.endsWith('_index');
}

function isIndexListKey(key: string): boolean {
  return key.endsWith('_idxs') || key.endsWith('_indices');
}

function checkpointStatus(count: number, expected: number): ReadinessStatus {
  if (expected <= 0 || count <= 0) return 'missing';
  return count >= expected ? 'ready' : 'partial';
}

function renderCheckpointStatus(count: number, expected: number): ReadinessStatus {
  if (count <= 0) return 'inactive';
  return expected > 0 && count >= expected ? 'ready' : 'partial';
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parentArtifactPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator >= 0 ? path.slice(0, separator) : '';
}
