# FrameFlow 本地界面

中文创作工作区包含创作助手、导演台、素材、已有视频剪辑与设置。界面通过本地 Node.js 服务调用 Python 工作流或已适配的本地 Agent。

## 启动

从项目根目录运行：

```bash
uv sync --python 3.12
npm --prefix web ci
./vimax web
```

默认访问 `http://127.0.0.1:4173`。服务默认只监听本机；可通过 `VIMAX_WEB_HOST` 与 `VIMAX_WEB_PORT` 调整开发环境。首次运行可直接在设置中配置执行者与服务，或从 `configs/agent.example.yaml` 复制私有的 `configs/agent.local.yaml`。

生产构建：

```bash
npm --prefix web run build
./vimax web start
```

## 视频剪辑与探测

FFmpeg 默认由 `imageio-ffmpeg` 提供，可使用 `FRAMEFLOW_FFMPEG` 指定可执行文件。视频元数据探测优先使用系统 `ffprobe`，也可用 `FRAMEFLOW_FFPROBE` 指定路径；缺少 `ffprobe` 时会回退到 FFmpeg 探测。需要系统工具时安装 FFmpeg：

```bash
brew install ffmpeg
```

已有视频剪辑先导入素材，再由本地 Agent 根据描述和时长提出方案，人工确认后在本机裁切、排序和拼接。源视频保留，成片另存。

## 私有配置

`configs/agent.local.yaml` 保存接口配置，`.vimax/` 保存执行者偏好与项目索引，`.working_dir/` 保存会话、素材和产物；这些目录均被 Git 忽略。无需将密钥写入受版本控制的配置模板。

完整功能、macOS 构建与当前状态请见 [项目 README](../README.md)。
