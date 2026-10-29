# Echo 开发文档

本目录面向后续参与开发的人和 Agent，描述 Echo 的**当前实现**。根目录 `README.md` 面向使用者，这里面向改代码的人。

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 技术栈、目录结构、进程与请求链路、后端分层、并发与一致性、安全边界、数据落盘格式、构建与测试 |
| [features.md](features.md) | 按功能模块描述行为、规则、涉及的接口与代码位置，以及完整 API 清单 |

## 维护约定

- 文档以代码为准。发现文档与代码不一致时，先确认代码行为，再更新文档。
- 修改以下内容时，请同步更新对应章节：
  - 新增或修改 `/api` 路由：`features.md` 的「API 清单」和对应功能章节。
  - `.echo/state.json`、`agent.json`、`agent.db` 结构，Markdown 内嵌格式（frontmatter、`echo-task` 注释、笔记引用）：`architecture.md` 的「数据存储」。
  - 新增顶层模块、目录或依赖：`architecture.md` 的「目录结构」「技术栈」。
  - 新增设置项：`features.md` 的「设置」，同时检查 Go `Settings`、`defaults()`、前端 `types.ts`、`App.tsx` 中的 `defaults`。
- 文档里的代码位置使用相对仓库根目录的路径，只写到文件或函数级别，避免写易变的行号。
- 已知与根目录 `README.md` 不一致之处，记录在 `features.md` 末尾的「已知差异与待办」。

## 快速定位

| 想改什么 | 先看哪里 |
| --- | --- |
| HTTP 路由、请求校验、本机访问限制 | `internal/app/server.go` |
| 笔记读写、路径安全、回收站、文件变更检测 | `internal/app/store.go` |
| 移动/重命名、链接改写、分类批量修改、资源目录迁移 | `internal/app/files.go` |
| YAML frontmatter 读写 | `internal/app/metadata.go` |
| 笔记勾选任务解析与回写 | `internal/app/tasks.go` |
| 计划与提醒 | `internal/app/plans.go`、`tasks.go` 中的 `checkReminders` |
| 自定义任务 | `internal/app/custom_tasks.go` |
| 多笔记库（仓库）切换 | `internal/app/repositories.go` |
| Agent 配置 / 对话存储 / 模型调用 | `internal/app/agent_config.go`、`agent_db.go`、`agent_chat.go` |
| 存储占用与未引用资源清理 | `internal/app/storage.go` |
| 导出快照与 ZIP | `internal/app/exports.go`、`src/export.tsx` |
| Excalidraw 与 Draw.io 绘图 | `internal/app/store.go`（`validateDrawing`）、`src/components/Drawing.tsx`、`src/components/Drawio.tsx`、`scripts/fetch-drawio.mjs` |
| 前端全局状态、保存、冲突、对话框 | `src/App.tsx` |
| 编辑器、快捷工具栏、AI 实时修改 | `src/components/Editor.tsx`、`src/agent/editorSession.ts` |
| Markdown 预览 | `src/components/MarkdownView.tsx` |
