# Paperlight：本地英语阅读与语言积累

一个本地优先的**桌面 app**，用来精读英文文档并沉淀知识：左侧像 IDE 一样浏览本机文件夹，双击即在标签页里打开；右侧「阅读助手」随手查询语义、追问、记笔记。阅读区与助手之间的分界线可以随时拖动。

除了「阅读空间」，还有并列的**表达池**、**笔记空间**（本地 Markdown vault）和**对话空间**（只针对 vault 内容做知识挖掘，选中内容后严格 grounded）。

支持 **PDF**、**EPUB**、**TXT**、**Markdown**（同一次会话里可以混着开）。

> 项目约定与长期记忆见 [AGENTS.md](AGENTS.md)。所有改动都以 app 形态为准。

## 版本与 V2.0 开发状态

当前正式版本仍是 **1.0.2**。工作文件夹的开发分支正在实现 V2.0；它不是可发布的 V2.0 完成版，P0/P1 全部验收前不得作为正式版本发布。

当前开发分支已有的可运行增量包括：表达池（Markdown 持久化、识别/探索来源、重复语境合并、AI 候选需确认）、表达与语义/笔记的本地搜索、PDF/EPUB/TXT/Markdown 阅读标记、保守的原文定位恢复、自由 Markdown 专项研究及其 Vault/对话关联，以及按活跃交互估算阅读时间并生成五段 Daily。macOS App 已做隔离配置启动检查；完整 P0/P1 验收、签名/公证、全文尺度阅读助手、研究成果的进一步组织和网页导入仍未完成。试用迭代只更新仓库根目录的 `Paperlight.app`，不生成安装包。

语义数据保留 V1 的确定性 ID、旧文件路径、`senses` frontmatter 与 `/api/sense` 契约；新记录添加 `semantic` 标记与 `semantics` 关联字段。相同 AI 语义 ID 自动累积来源；同一词元和词性但 AI ID 不同时，会先让用户选择合并语境或保留为不同语义。确认合并后保留旧解释，并记录备用 ID 以避免下次重复询问。用户改过的语义 Markdown 正文会被保留，语境只更新在 Paperlight 管理的区块里。

## 快速开始

需要 Node.js 20.19+ / 22.12+（本机验证于 v24.18）。

```bash
npm install
npm run app          # 构建并以 app 形态运行（日常使用）
```

在开发分支体验 V2 时，请使用独立的应用状态目录和测试 Vault，避免与已安装的 V1 共用状态或改动真实资料：

```bash
PAPERLIGHT_USER_DATA_DIR="$HOME/Library/Application Support/Paperlight-V2-Sandbox" ./Paperlight.app/Contents/MacOS/Paperlight
```

首次启动后在应用里选择一个空的测试文件夹作为 Vault。正式发布版本继续使用原来的应用数据目录。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm run app:dev` | 开发模式：Vite dev server + Electron 窗口，前端热更新 |
| `npm run dev` | 仅在浏览器里调试（没有文件夹浏览权限时会退化为文件选择器） |
| `npm run check` | 类型检查 + 生产构建 + 单元测试 + JS 语法检查 |
| `npm run smoke` | Electron 端到端冒烟测试（含 PDF/EPUB/TXT/Markdown 四种格式），截图输出到 `tests/artifacts/` |
| `npm run app:mac` | 仅构建 macOS universal `./Paperlight.app` 供试用；不生成安装包，也不改动 `release/` |

## 界面

四个空间共用一个窗口：最左侧的竖排 rail（阅读 / 笔记 / 表达 / 对话）随时切换；阅读助手右上角的按钮直接进入笔记空间。

```
┌ 标题栏（macOS 交通灯 + 品牌 + 打开文件/文件夹 + 翻译设置）──────────────┐
│ 阅读空间：标签页（⌘W 关闭，⌘1…⌘9 切换）                                │
├──┬─────────────┬──────────────────────────────┬────────────────────────┤
│空│ 文件/页面/目录 │◀ 分界线 ▶│   阅读区（虚拟化） │◀ 分界线 ▶│  阅读助手    │
│间│ 文件夹浏览    │           │                    │           │ 语义/记录本/对话│
└──┴─────────────┴──────────────────────────────┴────────────────────────┘

┌ 笔记空间：vault 文件夹树 │◀ 分界线 ▶│ 笔记标签 + 编辑/预览 │◀ ▶│ 笔记信息 ┐
┌ 对话空间：对话记录 │◀ 分界线 ▶│ vault 内容选择（勾选）│◀ ▶│ 严格 grounded 对话 ┐
```

- **文件**：打开系统文件夹后逐层浏览，双击文件夹进入、双击文档在新标签页打开（PDF / EPUB / TXT / Markdown，列表里带格式标签）；支持筛选、收藏、最近文件/文件夹、在访达中显示。
- **页面 / 目录**：PDF 显示缩略图；PDF 内置书签、EPUB 目录、Markdown 标题都会出现在「目录」里，点击即跳转。
- **阅读助手**：语义（结合上下文的词义消歧）、记录本（词语 ↔ 含义原子 + 笔记）、对话（围绕当前语义追问，任意消息可存为笔记）。右上角 `⤢` 可一键把助手加宽，或直接拖动分界线。标题栏的「笔记空间」按钮、语义卡下方的「语义存入 vault / 生成 AI 完整笔记」都会直接进入笔记空间。
- 分界线支持拖动、方向键微调、双击恢复默认；宽度会记住。

## 四个空间

### 阅读空间

上面「界面」里的那套：文件夹浏览、多标签阅读、选词查语义、追问、记笔记。

### 笔记空间（vault）

和 Obsidian 一样的排布：左边是 vault 文件夹树，中间是笔记标签 + 一种铺满的显示模式，右边是这份笔记的信息（类型、字数、关联语义、链接到的笔记、今日记录、日报、最近改动）。

- **vault 就是一个文件夹**：首次进入点「选择文件夹」（或菜单 `文件 → 打开笔记 vault…`、⌘⇧V）。vault 路径与最近使用会记住，切换 vault 后各 vault 的阅读状态互不影响。第一次用某个 vault 时会自动建好管理目录（已存在的不动）。
- **编辑 / 浏览二选一**（右上角切换，⌘E）：编辑模式整屏是 Markdown 源码，浏览模式整屏是渲染结果，不做左右分栏；模式会记住。
- **新建空白笔记**：笔记标签栏右侧的 `+`（或任意空间按 `⌘N`）会直接在 `notes/` 下建一份空白笔记并打开；阅读空间的标签栏 `+` 是一个小菜单（打开文档… / 新建空白笔记）。
- **vault 结构**（自动建立、可自由扩展）：

  ```text
  vault/
    materials/…            原始阅读资料，你自己组织（materials/books/、materials/articles/…）
    notes/…                笔记与语义，自动镜像 materials/ 的目录
    expressions/…          独立的个人表达池（Markdown）
    enlightenment/…        你自己的「专项发现」，日报会读这里
    Daily/<日期>.md         当天记录、阅读活动与总结（单文件）
    Daily/<日期>-report.md  仅作为升级前旧版日报的保留副本
  ```

- **materials → notes 的镜像**：`materials/books/book1.pdf` 或 `materials/books/book1/ch1.pdf` 都对应 `notes/books/book1/`；在 vault 里新建资料夹会自动创建对应的 `notes/` 目录。读书时收藏的语义、记录本笔记、AI 完整笔记都会落到这本书自己的 `notes/<资料夹>/` 里；没有资料上下文的笔记（对话空间存回来的、随手新建的）进 `notes/_inbox/`。
- **在 vault 里直接读书**：`materials/` 下的 PDF/EPUB/TXT 会出现在树里（斜体书名图标），点一下就在阅读空间打开；阅读助手会告诉你「这条会话的笔记会存到 notes/<资料夹>/」。
- **所有笔记都是 `.md`**（frontmatter 只用安全子集：`title`/`kind`/`date`/`tags`/`senses`/`hash` 等），支持 `[[另一份笔记]]` 跳转，自动保存（停顿 1.2 秒落盘，⌘S 立即保存），写入是「临时文件 + rename」，断电不会截断笔记。
- **专项研究（Enlightenment）**：在 `enlightenment/` 新建空白自由 Markdown 研究，不套固定模板；可将 Vault 内的材料或笔记以 `[[Vault 路径]]` 加入研究，也可关联已有对话的稳定本地 ID。研究面板能返回原材料或对话；来源文件和聊天正文不复制。研究正文中的表达也可直接收录到表达池。更完整的研究成果组织仍在开发中。
- **Daily 每天一份五段记录**（`Daily/<日期>.md`）：读了多久、读了什么、表达、语义、总结与勉励（继往开来）。阅读时间只估算前台且聚焦的阅读器活动；最近交互超过 45 秒或采样间隔异常过长时停止累计，并按本地午夜分日。`### 我的补充` 保留手写内容，并兼容旧版 `## 我的补充`。总结与当天记录写在同一文件；检测到受管理内容被手改时，先将差异快照归档到“我的补充”。
- **Daily 总结**按设置的时间生成（默认 20:00，可在「设置 → 日报生成时间」改，也可以关掉自动生成、只手动生成）。生成时会参考当天真实阅读活动、表达、语义和 `enlightenment/` 专项发现，只更新同一份 `Daily/<日期>.md` 的第五部分；当天记录变化后，界面会提示总结已过期。新版本不会生成第二个 `-report.md` 文件。升级前已有的 `Daily/<日期>-report.md` 保留原样，并在 Notes 树中标明为旧版副本，供用户查看或自行处理。
- vault 之外的文件夹不会被改动；删除笔记会真的删掉磁盘上的 `.md` 文件（有二次确认）。旧版的 `Paperlight/Daily/*.md` 首次打开时会**复制式迁移**到 `Daily/`，原文件保留作为恢复副本；已有目标文件不会被覆盖。旧版日报内容会并入对应日期的单文件 Daily；独立的 `-report.md` 原文件保留不删。

### 表达池

- 表达池与语义、自由笔记并列。阅读 PDF/EPUB/TXT/Markdown、阅读助手回答、对话、笔记和专项发现中的文本都可以直接选中并收录；也可手动添加。
- **识别**来自已接触材料，**探索**从表达意图或已有表达出发；参与者可以是用户或 AI。AI 候选只在用户确认后写入，并标明“AI 生成”，不会伪装成真实材料引文。
- 相同表达经过大小写、空白和标点规范化后共用一个 Markdown 记录并累积独立语境；语义相近但形式不同的表达保持分开。来源材料与位置随语境保存。
- 表达池支持本地搜索、编辑、删除、关联表达、来源回跳和 AI 探索。

### 输入标记

- 进度（书签）、形式、内容是标记目的；高亮和下划线是可选的视觉呈现。标记不改写原始 PDF/EPUB。
- PDF/EPUB 使用原文摘录、邻近文字和位置作保守恢复；TXT/Markdown 另外保存阅读比例，重开后可从标记菜单返回并恢复视觉标记。无法可靠定位时会显示未恢复状态，不会静默指向相似但错误的句子。

### 对话空间

专门为 vault 知识挖掘与管理设计的对话：

- **左栏两列**：一列是**对话记录**（多段对话、标题可改、可删），另一列是 **vault 内容选择**（只列 Markdown 笔记，勾选笔记或整个文件夹，也可以先筛选；`materials/` 里的原始资料不会混进来）。
- **严格 grounded**：勾选内容会成为这段对话的固定上下文（最多 8 份、每份截取前 6000 字，合计 24000 字上限），请求把它们一起送给模型，并明确要求「只依据这些摘录作答、每条结论用 `[[文件名]]` 标注出处、摘录里没有就直说没有」；回答上方显示 `grounded` 徽标与来源笔记，点来源可以跳到笔记空间。
- 没有勾选任何内容时会明确提示「未限定 vault 内容」，回答不受 vault 约束。
- 每条回答都能一键**存回 vault**（`notes/_inbox/`），复制，或点开引用到的笔记。

## 它解决的核心问题

- **打开就能读**：启动后恢复上次的文件夹、标签页、每本书的阅读位置与缩放，不用每次重新导入。
- **大文档不卡**：只渲染视口附近的页面（120 页文档常年只挂 2–3 个 canvas），实测首次出字约 130 ms。
- **空间可分配**：阅读、查询、追问、记笔记的比例由你拖出来，而不是写死。
- **笔记归你自己**：所有笔记都是 vault 文件夹里的普通 Markdown，Obsidian / VS Code / 其它编辑器随时能打开；语义收藏、AI 完整笔记、日记与每日汇总都落成 `.md`。
- **知识能被追问**：对话空间只看你勾选的 vault 内容，回答必须标注来源笔记，不拿模型的一般知识冒充你的笔记。
- **一切本地**：文件夹读取、状态保存、笔记都在本机；App 不会主动联网，只有你触发翻译/语义/对话/汇总时才调用已配置的 API。

## 目录结构

```text
electron/main.mjs       主进程：窗口、菜单、内置 127.0.0.1 服务（dist + /api）、IPC 文件能力
                        （含 vault 读写：路径必须落在所选文件夹内，含符号链接检查）
electron/preload.cjs    contextBridge 暴露 window.paperlight
electron/smoke.mjs      端到端冒烟测试（真实窗口 + 真实 IPC + 截图）
server/api.mjs          本地 AI 代理（配置 / 语义 / 翻译 / vault 对话 / 笔记 / 日记汇总），
                        Vite dev 与 app 共用
server/api.d.mts        类型声明
src/App.tsx             编排：四个空间的切换、阅读会话、标签页、分栏、选区、笔记与对话
src/components/         Splitter, TabStrip, FileExplorer, PageStack, PDFPage,
                        AssistantPanel(SenseCard, NotebookPanel, ChatPanel), WelcomeScreen,
                        SpaceRail, VaultTree, MarkdownPreview, NotesSpace, ChatSpace, useVault
src/lib/vault.ts        vault 纯逻辑（路径限制、frontmatter 子集、笔记模板、日记汇总、文件树）
src/lib/vaultfs.ts      vault 文件端口（Electron bridge / 浏览器调试虚拟 vault）
src/lib/vaultai.ts      vault 对话、笔记生成、日记汇总的本地 API 客户端
src/lib/pagelayout.ts   分页几何（纯函数）
src/lib/persist.ts      应用状态读写、遗留数据迁移
src/lib/fsaccess.ts     文件系统适配层（app 桥接 / 浏览器 / 兜底）
src/lib/documents.ts    PDF 文档缓存与引用计数
scripts/                app-dev.mjs（开发启动）、package-mac.mjs（打包）
tests/                  单元测试 + fixtures + 冒烟产物（artifacts/）
```

## 支持的格式

| 格式 | 渲染方式 | 能选词 → 语义 / 追问 / 笔记吗 | 位置记忆 |
| --- | --- | --- | --- |
| PDF | pdf.js 逐页渲染 + 文字层 | 有文字层就能（扫描版不能，未接 OCR） | 页码 + 页内位置 |
| EPUB 2 / 3 | 解压 → 解析 OPF/spine/nav → 章节 XHTML 经 DOMPurify 清洗后在 DOM 里排版（不用 iframe，所以选中文本和 PDF 一样自然） | 能 | 章节 + 章内进度 |
| TXT | 纯文本按空行分段，可读性排版 | 能 | 全文滚动进度 |
| Markdown | 内置的安全子集渲染器（标题/列表/引用/代码块/加粗斜体/链接/分隔线；不支持的语法按纯文本显示） | 能 | 同上（标题会进入「目录」） |

EPUB 的原始 CSS 会被丢弃，统一使用阅读器自己的排版；书内图片会从压缩包里取出并以 blob URL 显示，外链在系统浏览器打开。

## 阅读与翻译

- 拖选一个词（PDF / EPUB / TXT / Markdown 都一样）：右侧「语义」结合上下文给出这一处的准确含义，选区旁浮层同步显示。
- 「查询词」可直接用键盘改写，Enter 重新查询。
- 「整句翻译参考」折叠区可翻译选中的整句。
- 扫描版 PDF 没有文本层时只能翻页阅读，无法选词（尚未接入 OCR）；文字层偶尔会加载超时，此时页面会出现「重试 / 重新载入文档」，不会一直卡在载入中。

## 翻译 / AI 服务配置

1. 右上角「模拟翻译」→「OpenAI 兼容 API」。
2. 选择服务（DeepSeek 官方 / ZJUAI 网关）或手动填写 Base URL，输入密钥并保存。
3. 请求协议按 Base URL 自动选择：`api.deepseek.com` 用 Chat Completions，其他用 Responses。

所有 AI 能力都走同一个本地代理（`server/api.mjs`），只有 loopback 可以访问：

| 端点 | 用途 |
| --- | --- |
| `POST /api/sense` | 语义查询 / 全部语义 / 围绕语义的追问 |
| `POST /api/translate` | 整句翻译参考 |
| `POST /api/vault-chat` | 对话空间：带所选 vault 摘录的提问（严格 grounded） |
| `POST /api/note` | 由语义 / 摘录 / 主题生成一份完整的 Markdown 笔记 |
| `POST /api/daily-summary` | 生成当天日报（读记录清单 + `enlightenment/` 专项发现） |

未配置密钥时，语义、AI 笔记、vault 对话这些需要模型的功能会明确提示去设置里配置；笔记空间的本地整理与日记汇总不依赖网络。

安全边界：

- 密钥写入本机文件（开发模式：项目根 `.env.local`，权限 `0600`；打包后：app 的 userData 目录），**不会**进入前端 bundle、浏览器存储或 git。
- 打包后的 `Paperlight.app` 首次启动时，如果它还放在项目目录里且项目根存在 `.env.local`，会自动把该配置复制到 app 自己的数据目录（权限 `0600`），这样已有的密钥在 app 里可以直接用；把 app 移到别处则不会复制。
- 只有 `127.0.0.1` 的请求能访问 `/api/*`；写配置额外要求同源 Origin 与 CSRF nonce，Base URL 只允许白名单主机。
- 也可用环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 提供配置，此时页面只能查看状态，不能覆盖或删除。
- 渲染进程启用 `contextIsolation`、禁用 `nodeIntegration`，并施加严格 CSP。

## 数据与状态

- 应用状态：`<userData>/paperlight-state.json`（当前空间、标签页、阅读位置、文件夹、最近记录、分栏宽度、语义/笔记/对话、vault 路径、打开的笔记、对话空间的多段对话）。
  - 打包后位于 `~/Library/Application Support/Paperlight/`。
  - 首次启动会自动迁移旧版 localStorage 数据（`paperlight-senses-v1`、`paperlight-notebook-v2`、`paperlight-chat-v1`）。
- 笔记按本地日期编号「某日期第 N 份笔记」，删除后序号不复用。
- **笔记本体在 vault 里**（不在状态文件里）：`materials/`（原始资料）、`notes/`（语义与笔记，镜像 `materials/`）、`enlightenment/`（专项发现）、`Daily/`（记录清单 + 日报）。每份笔记都带一小段 frontmatter（`title` / `kind` / `date` / `tags` / `senses` / `hash` / `folder` 等，只支持单行值与 `[a, b]` 列表），正文是普通 Markdown，外部编辑器可以直接改。
- vault 的读写只通过主进程的 `vault:*` IPC 进行：路径必须是相对路径、不能有 `..`、解析后必须落在 vault 内（并额外检查符号链接），写入用临时文件 + rename，单个笔记上限 4 MB，单个 vault 最多列出 4000 个条目。
- 浏览器里 `npm run dev` 没有 Electron 桥：此时 vault 退化为浏览器存储里的**虚拟 vault**（可完整体验笔记/对话界面，但不写磁盘），app 里才是真实文件夹。

## 关于内容来源

- 例句分「有出处」与「AI 生成」两类并明确标注；服务端会强制校验，缺少出处的例句自动降级为 AI 生成。
- 语义、用法建议与完整语义均由模型生成，**不是授权词典内容**，请自行核对。

## 版本与更新记录

当前工作区为 **Paperlight 2.3.0 Preview**，在 `codex/paperlight-v2` 开发分支试用，尚未正式发布。V2 批次依次使用 2.1.0、2.2.0、2.3.0、2.4.0；开发批次 commit 推送到开发分支，不推送正式版本标签或 GitHub Release。

运行本地试用版：

```bash
npm run app:mac       # 更新仓库根目录 Paperlight.app
npm run check         # 构建、自动化测试与 Node 语法检查
npm run smoke         # Electron 窗口端到端验证
```

开发批次不维护分发安装包；`npm run app:mac` 只生成可本地体验的 macOS App。

## 测试与验收

```bash
npm run check    # tsc + vite build + node --test
npm run smoke    # Electron 真实窗口端到端：文件夹浏览、120 页文档渲染、
                 # 虚拟化、跳页、多标签、拖动分界线、状态持久化、关闭标签、
                 # 笔记空间（选 vault、materials/notes 镜像、编辑/浏览单栏模式、
                 # [[链接]]、专项研究材料/对话关联、单文件 Daily）、
                 # 对话空间（勾选 vault 内容、严格 grounded、回答存回 vault）
```

冒烟测试会生成 120 页与 24 页的测试 PDF 和一个临时 vault（`materials/books/book1/`、`enlightenment/`），截图写入 `tests/artifacts/`，结论写入 `tests/artifacts/smoke-report.json`；失败时退出码非 0。所有 AI 端点（语义、对话、笔记、日报、表达探索）在测试里都被本地打桩，所以冒烟即使配置了密钥也不会联网、不会花钱。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 打开 PDF | `⌘O` |
| 打开文件夹 | `⌘⇧O` |
| 打开笔记 vault | `⌘⇧V` |
| 新建空白笔记 | `⌘N` |
| 切换空间：阅读 / 笔记 / 对话 | `⌘⌥1` / `⌘⌥2` / `⌘⌥3` |
| 保存当前笔记（笔记空间） | `⌘S` |
| 编辑 / 浏览切换（笔记空间） | `⌘E` |
| 关闭当前标签页 | `⌘W` |
| 切换标签页 | `⌘1` … `⌘9` |
| 放大 / 缩小 / 适宽 | `⌘+` / `⌘-` / `⌘0` |
| 上一页 / 下一页 | `←` / `→`（或 `⌘↑` / `⌘↓`） |
| 关闭浮层或设置 | `Esc` |

## 分发给别人（macOS / Windows / Linux）

产物都在 `release/`（打完包后 mac 的 app 会同时放到仓库根目录的 `./Paperlight.app`）：

| 平台 | 文件 | 对方要做什么 |
| --- | --- | --- |
| macOS 13+，M 系与 Intel 通用 | `Paperlight-<版本>-mac-universal.dmg` | 拖进「应用程序」，第一次**右键 →「打开」**（作者没有 Apple 开发者证书，系统会提示"无法验证开发者"；若提示"已损坏"，执行 `xattr -dr com.apple.quarantine /Applications/Paperlight.app`） |
| Windows 10/11 x64 | `Paperlight-<版本>-windows-x64-setup.exe` | 双击安装；首次运行若出现"Windows 已保护你的电脑"，点「更多信息」→「仍要运行」 |
| Windows 免安装 | `Paperlight-<版本>-win-x64.zip` | 解压后直接运行 `Paperlight.exe` |
| Linux x64 | `Paperlight-<版本>-linux-x86_64.AppImage` | `chmod +x` 后直接运行 |

DMG 与 Windows 目录里都带了 `安装说明.txt`，把上面这些步骤写给了对方。

### 想做到「双击就能开、零提示」

需要代码签名证书（当前 `release/` 里的包是 ad-hoc 签名：`codesign --verify` 通过，所以不会出现"已损坏"，但未公证，首次打开仍需确认一次）：

1. **macOS**：加入 Apple Developer Program（$99/年），签发 `Developer ID Application` 证书，然后构建时提供
   `CSC_LINK`、`CSC_KEY_PASSWORD`，以及 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 用于公证。
   electron-builder 会自动签名 + 公证 + staple；同时把 `electron-builder.yml` 里的 `mac.hardenedRuntime` 改成 `true`。
2. **Windows**：购买 OV/EV 代码签名证书，构建时提供 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`，即可消除 SmartScreen 提示。

### 只推源码（零签名成本）

```bash
git clone https://github.com/spursergmk/paperlight.git
cd paperlight && npm install && npm run app
```

需要 Node.js 20.19+ / 22.12+；对方要自己填 API key 才能用语义/追问/翻译。

### 用 GitHub Actions 自动出全平台包

仓库里已带 [.github/workflows/release.yml](.github/workflows/release.yml)：

- 推送 `v*` 标签（如 `git tag v0.2.0 && git push origin v0.2.0`）→ 三个平台的 runner 各自构建，产物自动附到 draft Release；
- 也可以在 Actions 页面手动「Run workflow」，产物从运行页面下载。

签名证书通过仓库 Secrets 提供（`CSC_LINK`、`APPLE_ID`… / `WIN_CSC_LINK`），不配也能出未签名包。`.deb` 只在 Linux runner 上构建（需要 GNU tar）。

## 从旧版本升级

旧版是「Swift 启动器 + 单文档网页阅读器」。现在只有一个 app：`npm run app` 或打包后的 `Paperlight.app`。旧的 `Paperlight.app`（Swift 启动器）与 `dsh_inputs/` 任务台账已从项目目录移除（详见 `~/.paperlight-archive/`），不再维护第二套入口。
