# 开发结构

| 目录 / 文件 | 职责 |
| --- | --- |
| `desktop/` | macOS 原生窗口、WebView 与 App 构建脚本 |
| `web/src/` | 创作助手、导演台、素材、剪辑与设置界面 |
| `web/*.mjs` | 本地服务、任务调度、Agent 适配与文件访问 |
| `agent_runtime/` | Agent 循环、执行者、图像与视频剪辑工具 |
| `agents/`、`pipelines/` | 故事、角色、场景、分镜和媒体生成流程 |
| `main_agent.py`、`main_director.py`、`main_video_editor.py` | 对话、导演台与已有视频剪辑入口 |
| `tools/`、`utils/` | 模型服务、媒体处理和公共工具 |
| `configs/agent.example.yaml` | 不含密钥的配置示例 |
| `tests/`、`web/*.test.mjs`、`web/src/*.test.ts` | Python 与前端 / 服务测试 |
| `ui/`、`vimax` | 可选终端界面与本地启动命令 |

## 本地开发

```bash
uv sync --python 3.12
npm --prefix web ci
./vimax web
```

现有 Node.js 服务默认只监听本机 `127.0.0.1`。项目数据目录 `.vimax/`、`.working_dir/` 与接口密钥均不进入源码仓库。

## 测试

```bash
uv run python -m pytest tests -q
npm --prefix web test
npm --prefix web run build
./web/node_modules/.bin/tsc --noEmit --project web/tsconfig.json
```

Web 测试中的视频剪辑端到端用例使用临时素材和模拟 Agent，不调用付费生成服务。媒体探测依赖 `ffprobe`；没有系统 `ffprobe` 时，相关完整媒体端到端检查需先安装 FFmpeg。

可选终端界面：

```bash
npm --prefix ui ci
npm --prefix ui test
./vimax tui
```

## macOS 构建

```bash
npm --prefix web run build
bash desktop/build-macos.sh
```

`FrameFlow.app` 为本地构建产物，使用当前源码目录与 Node.js 路径。它与依赖环境一起运行，不能单独复制到另一台机器使用。源码更新不需要发布用户配置或本地会话。

## 图标与介绍

桌面图标主文件为 `desktop/assets/frameflow-app-icon.png`；浏览器图标在 `web/public/`。`docs/project-introduction.md` 保存与个人网站一致的项目介绍，修改文案时同步 README 与网站项目页。
