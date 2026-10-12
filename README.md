<div align="center">
  <img src="desktop/assets/frameflow-app-icon.png" width="112" alt="FrameFlow 眨眼场记板图标" />
  <h1>FrameFlow</h1>
  <p>从想法到成片，让创作保留控制。</p>
  <p><a href="https://17lijunyi.github.io/projects/frameflow/">项目介绍</a> · <a href="#快速开始">快速开始</a> · <a href="LICENSE">MIT 许可</a></p>
</div>

FrameFlow 是一个面向短片与故事创作的中文桌面工作室，将创作对话、剧本与分镜、逐镜生成和已有视频剪辑放在同一条流程里。可以从一句想法开始，也可以带着剧本、小说或视频素材进入，在每个环节检查、修改，再推进到成片。

## 创作思路

我希望创作过程既能通过对话快速展开，也能在具体镜头上保留控制。围绕这个目标，我先梳理从想法到分镜的路径，再把镜头编辑、素材管理与任务反馈整理进导演台；随后接入本地 Agent、补上已有视频的剪辑流程，并将常用操作收进两条胶囊栏，让对话和制作衔接得更自然。

设计上，我把主要设置收敛为创作助手、图像生成和视频生成三个选择；把已有视频剪辑留作导演台里的独立入口。这样，从讨论故事到调整镜头、处理素材，都有明确的下一步，也保留了人工检查和修改的空间。

## 功能亮点

- **从对话进入制作**：讨论想法、生成剧本与分镜，支持创意、剧本和小说流程。
- **按环节选择执行者**：API 与本地 Agent 统一配置，目前实际适配 Codex CLI、Claude Code 和 Pi。
- **逐镜控制的导演台**：编辑描述、时长、统一风格和首尾帧，保留多次生成版本，预览后合并导出。
- **已有视频的 Agent 剪辑**：导入素材，生成裁切与排序方案，确认后由 FFmpeg 处理成片。
- **简洁的中文桌面交互**：双胶囊栏承担导航和常用操作，串联对话、素材与镜头制作。

## 适合怎样使用

| 起点 | 创作路径 |
| --- | --- |
| 一个短片想法 | 与创作助手讨论，整理成剧本与分镜，再进入导演台逐镜制作 |
| 一份剧本或小说 | 导入原文，提取故事信息、规划场景与镜头，检查后继续生成 |
| 已有视频素材 | 在导演台打开「剪辑已有视频」，描述素材与剪辑要求，确认方案后导出 |

导演台的视频生成使用所配置的**视频 API**。已有视频剪辑是另一条流程：Agent 根据素材描述、时长和剪辑要求提出裁切与排序方案，你可以检查和修改，随后在本机渲染。当前剪辑流程不包含自动观看视频或识别精彩片段。

## 快速开始

当前为**开源测试版**，提供源码构建方式。macOS App 依赖本地项目目录和运行环境；还不是免依赖的独立安装包。

### 准备环境

- macOS 12 或更高版本；桌面 App 使用 Swift / AppKit 与 WKWebView。
- Xcode Command Line Tools，包含 `swiftc`；首次安装可运行 `xcode-select --install`。
- [uv](https://docs.astral.sh/uv/getting-started/installation/)，用于安装 Python 3.12 和项目依赖。
- Node.js 22 或更高版本与 npm。
- 按需要安装并登录 Codex CLI、Claude Code 或 Pi；也可以配置模型 API。

### 构建 macOS App

```bash
git clone https://github.com/17lijunyi/FrameFlow.git
cd FrameFlow
uv sync --python 3.12
npm --prefix web ci
npm --prefix web run build
bash desktop/build-macos.sh
open FrameFlow.app
```

请保留项目目录、`.venv` 和 `web/dist`。构建脚本会记录项目与 Node.js 路径，移动项目目录后需要重新构建。macOS 首次运行时可能要求确认项目所在文件夹的访问权限。

视频处理默认使用 Python 依赖提供的 FFmpeg。需要系统级 `ffmpeg` / `ffprobe` 时，可通过 Homebrew 安装 `ffmpeg`；视频探测与剪辑配置见 [Web 运行说明](web/README.md)。

### 使用浏览器界面

完成 Python 与 Web 依赖安装后，也可从项目根目录启动：

```bash
./vimax web
```

访问 `http://127.0.0.1:4173`。启动已构建的界面使用 `./vimax web start`。

## 连接执行者

在「设置」中选择创作助手、图像生成和视频生成的执行者。API 与检测到的本地 Agent 放在同一套选择流程中，专业分工按需展开。

- **创作助手**：使用已适配的本地 Agent 或文本模型 API，承担讨论、剧本与分镜规划。
- **图像生成**：配置图像 API，或选择具备生图工具的本地 Agent。
- **视频生成**：配置视频服务 API，再进入导演台生成镜头。
- **已有视频剪辑**：从导演台单独进入，选择可调用的本地 Agent，确认剪辑方案后导出。

检测到 Agent 不代表它已经适配，也不证明当前模型具有看图或生图能力。这些能力取决于 Agent 自身的模型和工具配置，更换模型后需要重新确认。看图与生成图片是两种能力。

接口配置保存在私有的 `configs/agent.local.yaml` 中，项目记录、素材与执行者选择保存在本地工作目录。这些文件已加入 Git 忽略规则。素材在本地保存，但使用远端 Agent 或 API 时仍可能向服务商发送相应输入；具体范围由所选执行者与任务决定。

## 开发与验证

| 部分 | 技术 |
| --- | --- |
| macOS 容器 | Swift、AppKit、WKWebView |
| 创作界面 | React、TypeScript、Vite、Lucide |
| 本地服务 | Node.js、JSONL / SSE 事件流、项目与任务管理 |
| Agent 与工作流 | Python 3.12、LangChain、可替换的模型和工具适配器 |
| 媒体处理 | FFmpeg、MoviePy、镜头和素材版本管理 |

运行现有测试与前端构建：

```bash
uv run python -m pytest tests -q
npm --prefix web test
npm --prefix web run build
```

终端界面为可选入口，安装 `ui` 依赖后运行 `./vimax tui`。项目代码与职责见 [结构说明](docs/development.md)。

## 许可

使用 [MIT 许可](LICENSE)。部分底层视频工作流沿用 [HKUDS/ViMax](https://github.com/HKUDS/ViMax)，原版权与许可声明保留在仓库中；详见 [NOTICE](NOTICE)。

作者：[李俊祎](https://17lijunyi.github.io/)。
