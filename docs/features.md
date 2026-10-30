# Echo 功能设计

本文按功能模块描述**当前实现**的行为、规则和代码位置。架构层面的机制（锁、revision、原子写、路径安全、数据格式）见 [architecture.md](architecture.md)，本文不重复说明。

## 1. 功能总览

| 模块 | 简述 | 后端 | 前端 |
| --- | --- | --- | --- |
| 笔记库与仓库 | 本地目录即笔记库；可在最近 5 个仓库之间切换 | `repositories.go`、`store.go` | `RepoSwitcher.tsx` |
| 目录与文件管理 | 目录树、新建/重命名/移动/删除、回收站 | `store.go`、`files.go` | `Sidebar.tsx`、`App.tsx` |
| 编辑与预览 | CodeMirror 源码编辑、Markdown 预览、自动保存、冲突处理 | `store.go` | `Editor.tsx`、`MarkdownView.tsx`、`App.tsx` |
| 分类 | 逻辑分组 + 多标签，写入 frontmatter | `metadata.go`、`files.go` | `App.tsx`（分类对话框） |
| 搜索与筛选 | 全文搜索、分组和标签筛选、多选批量操作 | `server.go` `/api/notes?q=` | `Sidebar.tsx` |
| 图片资源 | 上传/粘贴/拖放、资源目录迁移、未引用清理 | `server.go` `upload`、`files.go`、`storage.go` | `Editor.tsx`、`StorageSettings.tsx`、`ImagePreview.tsx` |
| 绘图 | Excalidraw 与离线 Draw.io：独立文件、指定目录新建、笔记内引用预览 | `store.go` | `Drawing.tsx`、`Drawio.tsx` |
| 笔记引用 | 插入指向其他笔记的链接，预览中可跳转 | `files.go`（移动时改写） | `NotePicker.tsx`、`noteReference.ts` |
| 任务看板 | 笔记勾选任务 + 独立自定义任务，三列看板 | `tasks.go`、`custom_tasks.go` | `TasksView.tsx` |
| 计划与提醒 | 单次/每日/每周的定时提醒 | `plans.go`、`tasks.go` | `PlansView.tsx`、`App.tsx` 提醒中心 |
| 导出 | MD / MD 资源包 / HTML / PDF / DOCX | `exports.go` | `export.tsx`、`exportDocx.ts` |
| 设置 | 外观、笔记、Agent、快捷键、存储 | `store.go`、`files.go` | `SettingsPanel.tsx` 等 |
| 笔记 Agent | 接入 OpenAI 兼容模型，聊天或直接修改当前笔记 | `agent_*.go` | `AgentPanel.tsx`、`src/agent/*` |

## 2. 笔记库与仓库切换

- **笔记库**（代码中称 repository）就是一个目录。第一次打开空目录时会创建 `.echo/` 和欢迎笔记 `欢迎使用 Echo.md`。
- **启动选择**：显式传入 `--data-dir` 时使用该目录；否则使用最近打开的仓库，打开失败再回退到默认目录 `notes`。
- **最近仓库**：最多保存 5 个，按最近打开时间排序，保存在用户配置目录的 `Echo/repositories.json`。可以重命名显示名称（最多 80 字、不能包含换行），可以移除记录（不能移除当前仓库，也不会删除目录）。
- **切换流程**：
  1. 前端 `prepareRepositorySwitch`：中断 Agent → 保存当前笔记 → 保存正在编辑的绘图。
  2. `POST /api/repositories/switch`（填写路径）或 `POST /api/repositories/pick`（弹出系统文件夹选择框；Windows 用 PowerShell 调起 WinForms `FolderBrowserDialog`，macOS 用 osascript，Linux 用 zenity）。
  3. 后端打开新的 Store，启动后台轮询，关闭旧 Store 的轮询和 Agent，广播 `switched`。
  4. 所有标签页收到 `switched` 后清除本仓库的 localStorage 会话并重新加载页面。**不在切换后保存**，以免把旧仓库的笔记写进新仓库。
- **打开本地目录**：`POST /api/storage/open` 在系统文件管理器中打开当前笔记库根目录。

## 3. 目录与文件管理

- **目录树**（`GET /api/tree`）：只显示文件夹、`.md`、`.excalidraw`、`.drawio`；隐藏点开头的条目、资源目录和符号链接；文件夹排在前面，同类按名称排序。
- **新建**：笔记、文件夹、绘图都支持用 `/` 一次创建多层目录。新建笔记的默认内容为 `# 文件名`（前端调用时传入空内容）。文件夹名不能以点开头。目标已存在时报错，不会覆盖。
- **重命名 / 移动**（`/api/notes/move`、`/api/folders/move`、`/api/drawings/move`）：
  - 必须带 revision（文件夹除外）；不能移动到自身或子目录，不能移动资源目录，也不能移动到资源目录里。
  - 移动后**自动改写所有笔记中指向被移动对象的相对链接**，以及被移动笔记自身的出站相对链接；同时更新提醒和任务完成历史中的笔记路径。
  - 前端同步更新多标签页、当前笔记和正在打开的绘图的路径。
- **删除**：移到 `.echo/trash/<id>`，在 `state.json` 中记录原路径和时间。只允许删除笔记、绘图和文件夹；不能删除资源目录或包含资源目录的文件夹。
- **回收站**：`GET /api/trash` 列出条目，`POST /api/trash/restore` 恢复。原路径已有文件时拒绝恢复。目前没有「彻底删除」或「清空回收站」功能。

## 4. 编辑与预览

### 4.1 标题

- 笔记标题 = 跳过 frontmatter 后第一行 `# ` 开头的标题；没有时使用文件名（不含扩展名）。前后端算法一致（`store.go` `readNote` / `src/noteTitle.ts`）。
- 页面上的标题可以直接点击编辑（`NoteTitle.tsx`），保存时改写或插入正文中的一级标题（`applyNoteTitle`），**不会重命名文件**。

### 4.2 源码编辑器（`Editor.tsx`）

- CodeMirror 6 + Markdown 语言包（代码块中的语言可以高亮），支持查找替换、撤销重做、折叠和自动补全。
- 工具栏：标题、加粗、斜体、删除线、下划线（`<u>`）、引用、无序/有序/任务列表、链接、**笔记引用**、**引用 Draw.io**、图片、**绘图**、行内代码、代码块、表格、撤销、重做。
- 快捷键可在设置中自定义（`shortcuts.ts`）：标题 1–6 级、加粗、斜体、删除线、下划线、行内代码、代码块、引用、有序/无序列表。保留键（保存、搜索、查找、撤销、重做、全选、复制、粘贴、剪切）不能占用，也不允许重复绑定；后端 `validateShortcuts` 会再校验一次。
- 全局快捷键：`Ctrl/Cmd+S` 保存，`Ctrl/Cmd+K` 聚焦侧栏搜索框。
- 图片可以通过文件选择、拖放、粘贴上传。上传期间在插入位置保留锚点，完成后替换为相对路径；失败时可以重试。
- 跳转到指定行：派发 `echo:goto-line` 自定义事件（大纲导航、看板中的「定位来源」都使用它）。

### 4.3 预览（`MarkdownView.tsx`）

- `react-markdown` + GFM（表格、任务列表、删除线），可选 `remark-breaks`（严格换行模式）；frontmatter 不显示；`skipHtml` 忽略原始 HTML，只把 `<u>…</u>` 转成下划线。
- 代码块使用 shiki 高亮（结果有缓存），可选显示行号；`mermaid` 代码块渲染为图表，渲染失败时退回代码块。
- 图片通过 `/api/assets?path=` 加载；`.excalidraw` 与 `.drawio` 引用显示为静态图，右下角有编辑按钮；点击图片可以放大预览、复制、下载（`ImagePreview.tsx`）。
- 内部链接：title 为 `echo-ref` 或者指向库内 `.md` 的相对链接，点击后在应用内打开对应笔记。
- 任务勾选框可以直接点击，会通过 `/api/tasks` 回写源文件。
- 标题带 `data-heading-line`，供大纲导航定位。

### 4.4 视图辅助

- 源码 / 预览 Tab 切换；可选「源码模式分栏预览」（左边编辑，右边实时预览）。
- 大纲导航（`NoteOutline`）：解析标题，点击后跳转到源码行或预览中的位置。
- 全屏预览：使用浏览器 Fullscreen API。
- 多标签页（设置项 `multiTabs`）：最多 10 个，超出时关闭最早打开的；关闭当前标签页时切换到相邻标签页。
- 状态栏：最后修改时间、字符数（不含空白）、行数。

### 4.5 保存与冲突

- 停止输入 800ms 后自动保存，`Ctrl+S` 或点击保存状态按钮立即保存。保存状态显示为：保存中、保存失败、待保存、已保存。
- 每次输入都写入 localStorage 草稿；打开笔记时如果发现草稿与磁盘内容不同，就恢复草稿；如果草稿的基准版本与磁盘版本也不同，直接弹出冲突对话框。
- 后端返回 409 时弹出冲突对话框，左右对比「当前草稿」和「磁盘版本」，提供三种处理：
  1. **另存草稿副本**：草稿另存为 `<原名>-草稿-<时间戳>.md`，当前显示磁盘版本。
  2. **使用磁盘版本**：丢弃草稿。
  3. **覆盖磁盘版本**：`force: true` 保存。
- 存在冲突或 Agent 修改等待确认时，暂停自动保存。
- 关闭页面时如果有未保存内容，会弹出浏览器的离开确认。

## 5. 分类：分组与标签

- 每篇笔记最多一个分组（`echo.group`）和多个标签（`echo.tags`），写在 frontmatter 中，**不会移动文件**。没有分组的笔记显示为「未分组」。
- 分组/标签列表 = `state.json` 中显式创建的名称 ∪ 所有笔记 frontmatter 中出现的名称，去重后排序。
- 操作：
  - 单篇或批量设置（`POST /api/notes/batch`）：批量模式会**替换**所选笔记的标签和分组；每篇笔记都校验 revision。
  - 新增（`POST /api/groups|tags`）：只写入 state。
  - 重命名（`PUT`）：改写所有引用了该名称的笔记。
  - 删除（`DELETE ?name=`）：从笔记中移除该分组或标签，不删除笔记。
- 名称长度 1–100 字，不能包含换行。frontmatter 是非法 YAML 时，笔记显示 `metadataError`，并拒绝修改分类，避免覆盖原内容。

## 6. 搜索、筛选与多选

- 侧栏搜索框输入后防抖 180ms，调用 `GET /api/notes?q=`，后端对「路径 + 全文」做不区分大小写的子串匹配。
- 分组筛选和标签筛选（多个标签取交集）在前端对笔记列表过滤，可以与搜索叠加。
- 多选笔记后，顶部出现选择栏，可以批量设置分类或导出所选笔记。
- 后端 `/api/notes` 同样支持 `group=` 和 `tags=` 参数（逗号分隔），目前前端主要在本地过滤。

## 7. 图片与资源目录

- **上传**：`POST /api/assets?notePath=`，multipart 字段为 `file`。按内容嗅探类型，只接受 PNG/JPEG/GIF/WebP，不超过 20MB；保存为 `<assetsDir>/<随机ID>.<ext>`，返回相对于当前笔记的 `markdownPath`。
- **读取**：`GET /api/assets?path=`，只返回非 SVG 的图片，缓存 5 分钟。
- **资源目录迁移**：在设置中修改 `assetsDir`。新目录必须不存在或为空，并且不能与旧目录互相嵌套。迁移会复制资源、改写所有笔记中的引用，并通过迁移日志保证崩溃后可以恢复（见架构文档 5.4）。
- **存储统计**（`GET /api/storage`）：分别统计配置数据、笔记正文、资源的大小和数量。
- **未引用资源清理**：
  1. `GET /api/storage/unused-assets`：扫描所有笔记以及**回收站中的笔记**里的 Markdown 图片、HTML `src/href`、`[[wiki]]` 引用，列出资源目录中没有被引用的图片和绘图，并返回基于笔记 revision 和资源大小/修改时间计算的 `token`。
  2. `POST /api/storage/cleanup {token}`：重新扫描，`token` 不一致就返回 409；删除前逐个确认文件大小和修改时间没有变化，并使用 `os.Root` 限定删除范围。
  3. 前端在检查和清理前都会先保存当前笔记；图片上传期间禁止检查和清理。

## 8. 绘图（Excalidraw 与 Draw.io）

两种绘图共用 `/api/drawings`、目录树里的 `type: "drawing"`，以及重命名、移动、删除和回收站。扩展名决定编辑器和内容校验，移动或重命名时必须保持原来的扩展名。不允许在资源目录中创建独立绘图。

### 8.1 Excalidraw

- **独立绘图**：目录树中的 `.excalidraw` 文件。侧栏「新建绘图」或文件夹操作里的「新建绘图」会创建它。
- **笔记内嵌绘图**：编辑器中点击绘图按钮会调用 `POST /api/drawings {notePath}`，在资源目录中创建 `<随机ID>.excalidraw`，并在光标处插入 `![绘图](相对路径)`。内嵌绘图会随笔记移动、资源目录迁移和未引用清理一起处理。
- **编辑**：`DrawingModal` 弹框，可以在编辑和查看之间切换；停止操作约 800ms 后自动保存（`PUT /api/drawings`，带 revision），冲突时提示并且不覆盖；可以导出 SVG/PNG/JPG。关闭弹框后 `drawingVersion` 加一，触发预览刷新。
- **校验**：内容必须是 `type: "excalidraw"` 的 JSON，不能为空，且不超过 20MB。绘图中插入的图片保存在绘图 JSON 内部。

### 8.2 Draw.io

- **离线编辑器**：`scripts/fetch-drawio.mjs` 固定拉取 Draw.io `v32.6.1` 标签压缩包中的 `src/main/webapp`（与发行包 `draw.war` 里的网页是同一套文件），解压到 `third_party/drawio/`，并删除其中的 `WEB-INF` 和 `META-INF`。已有同版本且关键文件齐全时会跳过下载。该目录不提交进仓库，也不放在 Go 的 `vendor/` 下。`npm run dev` 和 `npm run build` 都会先执行这个脚本，因此第一次需要联网。开发时由 Vite 提供 `/drawio/`；生产构建复制到 `internal/web/dist/drawio` 后打进可执行文件。`PreConfig.js` 把 `DRAWIO_BASE_URL` 设成本机的 `/drawio`，编辑器地址带 `offline=1` 和 `pwa=0`，避免云存储和 Service Worker。
- **新建**：侧栏底部回收站按钮左侧的 Draw 按钮在笔记库根目录新建 `.drawio`。文件夹操作弹框里的「新建 Draw.io」在该目录下新建。默认内容是一份空的 `<mxfile>`。
- **引用**：编辑器工具栏「引用笔记」旁边的「引用 Draw.io」打开 `NotePicker`（`kind="drawio"`），只列出笔记目录中的 `.drawio`（资源目录不在目录树里）。选中后由 `drawioReferenceMarkdown` 插入 `![名称](相对路径.drawio)`。预览在加载自托管的 `viewer-static.min.js` 之前设置 `STENCIL_PATH` 等路径，再用 `GraphViewer.createViewerForElement` 渲染；右下角可以打开编辑器。导出笔记时按 `application/vnd.jgraph.mxfile` 内联。资源目录里被引用的 `.drawio` 不会被未引用资源清理删掉；未被引用的会被列出来。
- **编辑**：`DrawioModal` 用同源 iframe 加载 `/drawio/index.html` 的 embed 协议。收到 `init` 后加载 XML，并打开 autosave；停止操作约 800ms 后保存，冲突处理与 Excalidraw 相同。可以导出 SVG/PNG。
- **校验**：`.drawio` 内容必须是根元素为 `mxfile` 的 XML，不能为空，且不超过 20MB。
- 切换仓库、执行文件操作前，会通过 `registerDrawingFlush` 先保存正在编辑的绘图（两种编辑器共用这一入口）。

## 9. 笔记引用

- 编辑器工具栏的「笔记引用」按钮打开 `NotePicker`（目录树形式，排除当前笔记），选择后插入 `[标题](相对路径 "echo-ref")`。旁边的「引用 Draw.io」使用同一个选择器，只显示 `.drawio` 文件。
- 预览中点击引用会在应用内打开目标笔记。
- 移动或重命名目标笔记时，后端会自动改写这些相对链接。

## 10. 任务看板

看板（`view = 'board'`）有两个页签，都使用「待办 / 进行中 / 已完成」三列，支持拖动卡片改变状态和关键字筛选：

### 10.1 自定义任务（默认页签）

- 独立于笔记，保存在 `state.json` 的 `customTasks` 中。字段为 `text`（必填）、`description`、`status`。
- 接口：`GET/POST/PUT/DELETE /api/custom-tasks`。

### 10.2 笔记任务

- 来源于所有笔记中的 Markdown 勾选列表（跳过代码块、HTML 块和 frontmatter）。
- 修改状态时调用 `PUT /api/tasks`，带上 `notePath`、`line`、`id`、`revision`。后端定位到对应行，改写勾选框并写入/更新 `<!-- echo-task: {...} -->` 注释，然后保存笔记。前端会先保存当前笔记，再重新拉取任务列表获取最新的 revision。
- 卡片上可以「定位来源」，打开笔记并跳到对应行。
- 任务完成时会在 `history` 中记录。笔记任务**不支持到期时间、重复规则和应用提醒**；需要定时提醒时使用计划（第 11 节）。后端 `TaskUpdate` 仍保留 `due` / `remindAt` / `repeat` 等字段，但前端不提供设置入口，`checkReminders` 也不会根据笔记任务生成提醒。

## 11. 计划与提醒

- **计划**（`view = 'plans'`，`PlansView.tsx`）：标题、备注、重复方式（`once` 需要日期；`daily`；`weekly` 需要选择星期，0 表示周日）、时间 `HH:mm`、时区（默认 `Local`）、启用开关。
- **提醒生成**（`checkReminders`，在后台每 2 秒执行一次，读取提醒列表或修改计划时也会执行）：对每个启用的计划，计算「不早于计划创建时间、且不晚于当前时间」的**最近一次**触发时间。提醒 ID 由「计划 ID + 触发时间」哈希得到，已经存在的不会重复生成。长时间没有打开应用时，每个计划只补发一次，不会积压多条。
- **提醒确认**：前端发现未确认的提醒后，调用 `POST /api/reminders/ack` 认领；只有认领成功（`claimed: true`）的标签页才显示 toast 和浏览器通知，从而避免多个标签页重复提醒。
- **提醒中心**：顶栏铃铛按钮，有未确认提醒时显示红点；可以申请浏览器通知权限；点击提醒跳转到计划视图。
- 应用关闭期间不会发送系统通知，重新打开后会补发。
- 资源迁移日志存在时，暂停生成提醒。

## 12. 导出（`src/export.tsx`、`src/exportDocx.ts` + `exports.go`）

| 格式 | 范围 | 实现 |
| --- | --- | --- |
| Markdown（`md`） | 仅单篇 | 后端直接返回原始文件下载，不包含图片 |
| Markdown 资源包（`bundle`） | 单篇或多篇 | 后端生成 ZIP，保留目录结构，图片和被引用的绘图放在包内 `.assets`，并改写导出副本中的引用 |
| HTML（`html`） | 单篇导出为 `.html`；多篇导出为 ZIP（含索引页） | 前端从后端获取 `snapshot`（笔记 + base64 资源），用 `MarkdownView` 离屏渲染，内嵌样式、图片、绘图和代码高亮；批量导出时修正所选笔记之间的链接 |
| PDF（`pdf`） | 单篇或合并多篇 | 打开专用打印页，用户通过浏览器「另存为 PDF」；每篇另起一页 |
| DOCX（`docx`） | 单篇导出为 `.docx`；多篇每篇一个 `.docx`，打包为 ZIP | 前端用 remark-docx 从 `snapshot` 生成可编辑的 Word 文档。图片、绘图和 Mermaid 嵌入为图片，代码保留高亮。不支持行号，也不支持 `<u>` 以外的内联 HTML。Draw.io 图里的 HTML 文本在转成图片后可能无法显示 |

- 导出范围：当前笔记、所选笔记、当前筛选结果，或从笔记操作菜单导出指定笔记。
- 导出前先保存；本地图片或绘图缺失时返回 422，并列出缺失和外链图片，用户确认后带 `allowMissing` 重新导出。外链图片不会下载。`.excalidraw` 内联为 `application/vnd.excalidraw+json`，`.drawio` 内联为 `application/vnd.jgraph.mxfile`。

## 13. 设置（`SettingsPanel.tsx`）

左侧菜单、右侧详情；切换菜单时保留未保存的修改；外观修改即时预览，取消后恢复。一次「保存设置」会同时提交笔记设置和 Agent 设置（Agent 设置有变更时才提交）。

| 分页 | 内容 | 存储 |
| --- | --- | --- |
| 外观 | 6 种界面风格（sage/paper/mono/soft/glass/ink，切换风格会联动默认强调色）、明亮/暗黑/跟随系统、强调色（预设或自定义）、界面动画 | `state.json` |
| 笔记 | 编辑器字体大小 12–32、预览正文宽度（默认 / 中 1200px / 大 1600px）、源码行号、预览代码行号、源码分栏预览、严格换行、多笔记标签页 | `state.json` |
| Agent | 启用开关、API 地址、API Key（只写不读）、模型、上下文长度、最大输出长度、温度、系统提示词、超时，以及「测试连接」 | `.echo/agent.json` |
| 快捷键 | 录制按键、冲突提示、恢复默认 | `state.json` 的 `shortcuts` |
| 存储 | 存储占用、打开目录、资源目录路径、未引用资源检查与清理 | `state.json` / 文件系统 |

顶栏的主题按钮可以快速切换明亮/暗黑模式（直接保存设置）。动画关闭时同时影响 CSS 过渡和 Motion，并遵循系统的「减少动态效果」设置。

## 14. 笔记 Agent

### 14.1 配置约束（`agent_config.go`）

| 字段 | 默认值 | 约束 |
| --- | --- | --- |
| `baseURL` | `https://api.openai.com/v1` | http/https，不能包含用户信息；自动补全 `/chat/completions` |
| `model` | `gpt-4o-mini` | 不超过 200 字符，不能包含换行 |
| `contextTokens` | 32000 | 1024 – 2,000,000 |
| `maxOutputTokens` | 4096 | 1 – 128000，且必须小于上下文长度 |
| `temperature` | 0.7 | 0 – 2 |
| `timeoutSeconds` | 90 | 5 – 600 |
| `systemPrompt` | 内置中文提示词 | 不超过 20000 字 |

- 开启 Agent 前必须先填写 API Key；API Key 中的 `Bearer ` 前缀会被自动去掉。
- `POST /api/agent/test` 发送 `ping` 测试连接，可以临时覆盖地址、Key、模型和超时。

### 14.2 使用流程

- 顶栏机器人按钮打开右侧面板（宽度 280–560，可拖动调整）；只有启用 Agent 后才显示该按钮。
- **聊天模式**：普通多轮对话，不修改笔记。
- **笔记模式**：必须先打开一篇笔记。模型可以调用三个工具：
  - `edit_note {edits:[{search, replace}]}`：精确查找替换，`search` 必须在原文中逐字唯一匹配，多处修改不能重叠。
  - `append_to_note {text}`：在笔记末尾追加。
  - `rewrite_note {content}`：整篇重写。
- 工具调用开始后，界面切到源码模式并锁定编辑器，修改**随流式输出实时写入**编辑器并高亮。结束后显示「保留 / 撤销」，未成功应用的修改会列出原因（找不到匹配、匹配不唯一、范围重叠等）。
  - 保留：解锁并保存笔记。
  - 撤销：恢复会话开始时的内容。
  - 用户的决定通过 `PATCH /api/agent/messages/outcome` 写入数据库，并改写对应 tool 消息的内容，让模型在下一轮知道修改是否生效。
- 生成过程中可以点击「停止」。切换笔记、关闭标签页、删除或移动当前笔记、切换仓库都会中断生成，并撤销未确认的修改。
- **历史对话**：最多列出 200 条，可以打开或删除（删除需要二次确认）；新对话的标题取第一条消息的前 30 个字。每条消息显示时间，可以复制内容。

## 15. API 清单

所有接口都在 `/api` 下。除特别说明外，请求和响应都是 JSON。错误响应格式为 `{"error": "..."}`；409 冲突时额外带 `current`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ok, dataDir}` |
| GET | `/tree` | 目录树 |
| GET | `/notes?path=` | 读取单篇笔记（含 content） |
| GET | `/notes`（或 `/search`）`?q=&group=&tags=` | 笔记列表（不含 content） |
| POST | `/notes` | 新建 `{path, content?}`，返回 201 |
| PUT | `/notes` | 保存 `{path, content, revision, force?}` |
| DELETE | `/notes?path=` | 移到回收站 |
| POST | `/notes/move` | `{path, target, revision}` |
| POST | `/notes/batch` | 批量分类 `{paths, tags?, group?, revisions}` |
| POST / DELETE | `/folders` | 新建 `{path}` / 删除 `?path=` |
| POST | `/folders/move` | `{path, target}` |
| GET | `/trash` | 回收站列表 |
| POST | `/trash/restore` | `{id}` |
| GET / POST / PUT / DELETE | `/groups`、`/tags` | 列表 / 新增 `{name}` / 重命名 `{name, newName}` / 删除 `?name=` |
| GET / HEAD | `/assets?path=` | 读取图片 |
| POST | `/assets?notePath=` | multipart 上传图片，字段为 `file` |
| GET / POST / PUT / DELETE | `/drawings` | 读取 `?path=` / 新建 `{path}`（`.excalidraw` 或 `.drawio`）或 `{notePath}`（只在资源目录创建 `.excalidraw`）/ 保存 `{path, content, revision, force?}` / 删除 `?path=` |
| POST | `/drawings/move` | `{path, target, revision}` |
| GET / PUT | `/settings` | 读取 / 保存设置（可能触发资源目录迁移） |
| GET | `/storage` | 存储占用 |
| POST | `/storage/open` | 在系统文件管理器中打开笔记库 |
| GET | `/storage/unused-assets` | 未引用资源及 token |
| POST | `/storage/cleanup` | `{token}` |
| GET | `/tasks` | 所有笔记任务 |
| PUT | `/tasks` | `TaskUpdate {notePath, line, id, revision, status?, due?, remindAt?, repeat?, timezone?}`，返回更新后的笔记 |
| GET / POST / PUT / DELETE | `/custom-tasks` | 自定义任务 CRUD（删除用 `?id=`） |
| GET / POST / PUT / DELETE | `/plans` | 计划 CRUD（删除用 `?id=`） |
| GET | `/reminders` | 未确认的提醒（读取时会先执行一次 `checkReminders`） |
| POST | `/reminders/ack` | `{id}` → `{claimed}` |
| POST | `/exports` | `{paths, format: md\|bundle\|snapshot, allowMissing?}`；`md`/`bundle` 返回文件下载，`snapshot` 返回 JSON（供 HTML、PDF、DOCX 使用）；资源缺失时返回 422 |
| GET | `/events` | SSE：`changed` / `reminder` / `switched`，每 20 秒发送一次心跳 |
| GET / PUT / DELETE | `/repositories` | 仓库列表 / 重命名 `{path, name}` / 移除 `?path=` |
| POST | `/repositories/switch` | `{path}` |
| POST | `/repositories/pick` | 弹出系统文件夹选择框并切换；用户取消时返回 `canceled: true` |
| GET / PUT | `/agent/config` | Agent 配置（返回内容不含 Key） |
| POST | `/agent/test` | 测试连接 |
| GET / POST / PUT / DELETE | `/agent/conversations` | 列表或 `?id=` 详情 / 新建 `{mode, notePath}` / 重命名 `{id, title}` / 删除 `?id=` |
| POST | `/agent/chat` | SSE 流式对话，事件类型：`meta`、`delta`、`tool_start`、`tool_delta`、`tool_end`、`done`、`error` |
| PATCH | `/agent/messages/outcome` | `{id, outcome: accepted\|rejected, detail}` |

## 16. 已知差异与待办

以下是阅读代码时发现的、与当前文档或产品边界相关的事项，供后续开发参考：

1. **笔记任务排期字段的残留**：产品上不支持笔记任务提醒；`checkReminders` 只为计划生成提醒。但 `TaskUpdate` / `echo-task` 注释仍保留 `due`、`remindAt`、`repeat`、`timezone`、`anchorDay`，完成重复任务时后端仍会推进周期。若彻底清理，需要同步删除这些字段、相关测试和解析逻辑。
2. **README 功能覆盖**：Agent、多仓库切换、界面风格、快捷键设置、笔记引用、多标签页、分栏预览、全屏预览、Mermaid、图片放大预览等，根目录 README 仍可能介绍不完整。API 概览表也缺少 `/drawings`、`/repositories`、`/agent/*`。
3. **回收站**：只能恢复，没有彻底删除或清空的接口。
4. **Agent 数据库迁移**：`migrate()` 只实现了从 0 到 1 的建表，后续修改 schema 时需要补充增量迁移。
5. **请求串行**：所有普通 API 共用 `Store.mu`，笔记数量很大时，列表、搜索、指纹计算（每 2 秒全量读取所有笔记）可能成为性能瓶颈；如需优化，可以考虑引入增量索引或基于修改时间的缓存。
