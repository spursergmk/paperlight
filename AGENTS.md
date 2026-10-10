# Paperlight 项目记忆（AGENTS.md）

> 本文件是本项目**唯一**的常驻记忆。新会话先读这里，再读 `README.md`。
> 任何与本文件冲突的旧文档、旧任务台账、旧启动口令都已删除，不要再从历史里恢复它们。

## 一、项目是什么

Paperlight 是一个**本地优先的英语阅读与语言积累桌面 app**：阅读真实材料，咀嚼语言和内容，并把值得复用的表达、语义与笔记沉淀进用户控制的本地 Vault。当前正式版本是 **1.0.2**；V2.0 仍在开发分支实现，不能把未完成的功能记成已交付。

四个并列空间（阅读、笔记、表达、对话；入口在最左侧 rail。阅读助手右上角也有进入笔记空间的按钮。**不要再在阅读空间的左侧栏里重复一排空间按钮**，那是与 rail 重复的冗余入口）：

- **阅读空间**：文件夹浏览 + 多标签阅读 + 阅读助手（语义 / 记录本 / 对话）。
- **笔记空间**：Obsidian 式 vault 文件夹树 + 笔记标签 + 单栏（编辑/浏览切换）+ 信息面板；所有笔记都是 vault 里的 `.md`。vault 结构：`materials/`（原始资料）→ `notes/`（镜像归档语义与笔记）、`enlightenment/`（用户的专项发现）、`Daily/`（记录清单 + 独立成文件的日报）。
- **对话空间**：左栏两列（对话记录 + vault 内容选择），勾选内容后对话严格 grounded，回答可存回 vault。
- **表达池**：可从既有语言材料中识别表达，也可从表达意图出发探索；收录保留独立来源语境，AI 候选要经用户确认。

- 技术栈：Electron 44 + Vite 7 + React 19 + pdf.js 6（TypeScript）。
- 目标形态：`npm run app` 或打包出的 `Paperlight.app`。**浏览器里的 `npm run dev` 只是调试手段，不是交付物。**

## 二、铁律（每次改动都要满足）

1. **一切围绕 app，且要能在三平台发布。** 新功能必须在 Electron app 里可用、可验证（`npm run smoke` 里有对应检查或截图）；发布目标是 macOS（universal）+ Windows(x64) + Linux(x64)，因此**不要写死 macOS 专有行为**（标题栏、路径分隔符、`/Volumes` 之类都要判断平台或做兼容）。
2. **离线可用。** 不引入需要联网的运行时资源（远程字体、CDN、在线图标）。字体使用系统字体栈。app 启动不应发起任何外部网络请求，只有用户主动翻译/查询时才访问已配置的 API。
3. **文件系统优先。** 阅读器必须能直接打开系统文件夹、双击打开文档（新标签页）、恢复上次打开的文件夹与标签页；不允许退回「每次都手动导入单个文件」的形态。
   - 新增格式要同时改三处：`src/lib/documentKind.ts`（渲染层的类型判定）、`electron/main.mjs` 的 `DOCUMENT_EXTENSIONS`/`documentKindOf`（主进程放行与对话框过滤）、`src/components/FileExplorer.tsx` 的图标与打开条件。冒烟测试会各开一个文件，两边清单不一致会失败。
4. **大文档必须虚拟化。** PDF 只挂载视口附近的页面（`src/lib/pagelayout.ts` + `src/components/PageStack.tsx`），EPUB 只渲染当前章，超长文本按段渐进渲染。任何「一次性渲染全部内容」的改动都算性能回归。
5. **分界线可拖拽。** 左侧栏、阅读区、阅读助手之间是可拖拽的 divider（`src/components/Splitter.tsx`），宽度持久化，支持键盘方向键与双击复位；阅读助手的空间不能被固定死。
6. **密钥不出本机。** API 密钥只写入本机文件（开发：项目根 `.env.local`；打包后：app 的 userData 目录），只能通过 loopback 请求使用。不要把密钥写进前端代码、日志、截图或 git。
7. **改完必须验证。**
   - `npm run check`：类型检查 + 生产构建 + 单元测试 + `node --check` 语法检查。`electron/*.mjs`、`server/*.mjs`、`scripts/*.mjs` 是纯 JS，**不要在里面写 TypeScript 语法**（`as const`、类型注解等会让 app 直接起不来）。
   - `npm run smoke`：Electron 端到端冒烟，截图写到 `tests/artifacts/`，结果写到 `tests/artifacts/smoke-report.json`，失败时退出码非 0。
   - 试用迭代需要更新 macOS app 时，运行 `npm run app:mac`；该命令只替换仓库根 `./Paperlight.app`，不生成安装包、不改动 `release/`。使用独立 `PAPERLIGHT_USER_DATA_DIR` 和空测试 Vault 验证。
   - 只有用户明确要求维护分发包时才运行 `npm run dist*`；日常试用迭代不维护安装包。

## 三、架构地图

```
electron/main.mjs        Electron 主进程：窗口、菜单、内置 HTTP 服务（dist + API）、
                         IPC（文件夹选择、目录列表、读取 PDF、应用状态文件、vault 读写）
electron/preload.cjs     contextBridge：window.paperlight（唯一的能力入口）
electron/smoke.mjs       端到端冒烟测试（真实窗口 + 真实 IPC + 截图）
server/api.mjs           本地 AI 代理（配置/语义/翻译/vault 对话/笔记/日记汇总）——Vite dev 与 app 共用这一份实现
server/api.d.mts         上面这个模块的类型声明
src/App.tsx              编排：空间切换、会话、标签页、分栏、选区、笔记/对话、vault 接线
src/components/          Splitter / TabStrip / FileExplorer / PageStack / PDFPage /
                         AssistantPanel(SenseCard, NotebookPanel, ChatPanel) / WelcomeScreen /
                         SpaceRail / VaultTree / MarkdownPreview / NotesSpace / ChatSpace / useVault
src/components/TextReader.tsx    TXT / Markdown 重排阅读器（渐进渲染 + 锚点目录）
src/components/EpubReader.tsx    EPUB 章节阅读器（DOMPurify 清洗后插入 DOM，图片转 blob）
src/components/useFlowReader.ts  重排阅读器共用的滚动/位置恢复
src/components/NotesSpace.tsx    笔记空间：vault 树 + 笔记标签 + 单栏编辑/浏览 + 信息面板
src/components/ChatSpace.tsx     对话空间：对话记录栏 + vault 内容选择栏 + grounded 对话
src/components/ExpressionSpace.tsx 表达池：Markdown 记录、来源语境、关联与本地搜索
src/components/InputMarkerOverlay.tsx PDF/EPUB/TXT/Markdown 的非破坏性视觉标记层
src/components/useVault.ts       vault 的唯一状态机：列目录、读写、语义/笔记/回答落盘、每日汇总
src/components/SpaceRail.tsx     四个空间的切换入口（每个空间左侧都有）
src/lib/vault.ts         vault 纯逻辑：路径限制、materials→notes 镜像、frontmatter 子集、笔记/日报模板、日报时间槽、文件树（纯函数，有单测）
src/lib/vaultfs.ts       vault 文件端口：Electron bridge / 浏览器调试用的虚拟 vault
src/lib/vaultai.ts       /api/vault-chat、/api/note、/api/daily-summary 的客户端 + 摘录预算
src/lib/documentKind.ts  格式判定（pdf/text/epub）
src/lib/textdoc.ts       安全 Markdown 子集解析（纯函数，有单测）
src/lib/epub.ts          EPUB 解析：container/OPF/spine/nav/NCX（纯函数，有单测）
src/lib/xml.ts           宽松 XML 扫描器（不依赖 DOMParser，可在 Node 里测）
src/lib/pagelayout.ts    PDF 分页几何（纯函数，有单测）
src/lib/persist.ts       应用状态（空间、标签页、分栏宽度、笔记、vault、两份空间布局）读写与遗留数据迁移
src/lib/readingActivity.ts 前台活跃阅读时长估算与本地日期切分
src/lib/fsaccess.ts      FileSystemPort：app 桥接 / 浏览器 File System Access / 兜底
src/lib/documents.ts     按 key 缓存 + 引用计数的 PDF 文档
scripts/app-dev.mjs      `npm run app:dev`：Vite + Electron 同时启动
scripts/make-icons.mjs   从 build/icon.png 生成 icon.icns / icon.ico（新图标时跑 `npm run icons`）
scripts/check-node-files.mjs 用 Node 解析所有 .mjs/.cjs，防止 TS 语法混进纯 JS
electron-builder.yml     macOS（dmg+zip，universal）/ Windows（nsis+zip）/ Linux（AppImage+deb）打包配置
.github/workflows/release.yml  推 v* 标签自动出三平台安装包并附到 draft Release
```

约定：

- **只有一个 AI 代理实现**（`server/api.mjs`）。不要在 `vite.config.ts` 或 Electron 里再写第二份。
- 渲染进程没有 Node 权限；所有系统能力从 `electron/preload.cjs` 暴露，并通过 `src/lib/bridge.ts` 的类型使用。
- 纯逻辑（分页几何、选区解析、笔记序数、vault 路径/模板/日记汇总）放 `src/lib/`，并在 `tests/*.test.ts` 里覆盖。
- **vault 的每一次磁盘访问都走 `vault:*` IPC**：路径必须是 vault 相对路径、不能有 `..`、解析后必须落在所选文件夹内（额外做符号链接检查），写入用「临时文件 + rename」，只允许 `.md`/`.markdown`。渲染进程不要自己拼绝对路径去读盘。
- **笔记只能是 Markdown，位置由材料决定**：语义与笔记写到 `notes/<materials 镜像>/`（`notes/_inbox/` 表示没有材料上下文），专项发现写 `enlightenment/`，记录清单写 `Daily/<日期>.md`，日报写 `Daily/<日期>-report.md`。frontmatter 只用 `src/lib/vault.ts` 的安全子集。
- **V1 语义兼容优先**：V1 的 `SenseAtom` 身份、旧文件路径、`senses` frontmatter、`/api/sense` 与历史链接必须继续可读。V2 新建笔记可写 `kind: semantic` 与 `semantics`，不做批量重命名或破坏性迁移。完全相同的语义 ID 可自动累积；不同 AI ID 即使词元/词性相同也必须先询问用户，不得直接调用 `mergeSemanticAtom` 跨 ID 合并。确认后保留 alternate ID、原解释和来源；AI 更新不得覆盖用户改过的 Markdown 正文，Paperlight 只替换自己标记的语境块。
- **表达记录保持来源**：Vault 的 `expressions/*.md` 是表达本体、语境和联系的权威数据；确定性规范化只合并大小写/空白/标点差异，不因语义相近自动合并不同表达。AI 候选只有用户确认后才写盘，并保留生成来源。
- **写入时记录真实路径**：原子/笔记上的 `notesFolder` 是「应该在哪」，`notePath` 是「实际写到哪」。`senseNotePath` / `notebookNotePath` 必须优先用 `notePath`，否则先收藏、后写 vault 的语义会在记录清单里链到错误的 `_inbox` 路径（冒烟里有对应检查）。
- **Daily 固定五段**：读了多久、读了什么、表达、语义、总结与勉励（继往开来）。阅读活动只有在阅读空间、窗口前台、文档加载完成且近 60 秒有交互时按 15 秒节拍估算；跨午夜分日，UI 使用约分钟显示。活动源不等同于应用运行时长。
- `Daily/<日期>.md` 是本地即时整理（无模型调用，源哈希含收录与活动，`managedHash` 标记生成区内容）；`Daily/<日期>-report.md` 只在设置的日报时间或用户手动触发时生成，覆盖上一版。AI 日报只用当日材料、表达、语义与 `enlightenment/` 发现，不补造学习活动。重写清单时兼容并保留旧版 `## 我的补充`；若旧数据没有指纹，或检测到生成区被手动修改，先将旧生成区快照保留在用户补充部分，再重建。
- 旧的 `Paperlight/Daily/*.md` 首次打开时迁移到 `Daily/`（汇总进日报文件）；不要删除旧源文件，除非独立证明迁移完整且用户明确授权清理。
- **安全试用工作分支**：开发版如需人工体验，设置 `PAPERLIGHT_USER_DATA_DIR` 指向独立目录，并先选择空的测试 Vault；不要让 V1 与 V2 共用状态文件，也不要用测试流程写入用户真实 Vault。
- 每个空间的状态分开持久化（`state.notesSpace` / `state.chatSpace` / `state.vault`），改状态前先看 `src/lib/persist.ts` 的 `mergeState`：新字段要带默认值并在那里做清洗，坏数据必须降级而不是崩。
- **空间组件不要在 effect 依赖里放整只 vault API 对象**（它每次渲染都会重建）：用 ref 读它，否则会出现「每次按键都重新加载笔记、覆盖草稿」这类 bug。
- pdf.js 每个文档一个自己的 worker（不共用 `workerPort`，见 `src/lib/documents.ts`），但 `pdf.cleanup()`/`loadingTask.destroy()` 会动到 worker 级与静态缓存（字体度量、TextLayer 的离屏画布），且 `cleanup()` 可能因为「页面正在渲染」而拒绝。因此关闭标签页时只释放引用，缓存清空时才整体销毁。
- **阅读位置必须按「页码 + 页内比例」重新锚定**（`src/components/PageStack.tsx`），不能只存像素：缩放、窗口/分栏尺寸变化、混合尺寸页面（横版插页）都会改变每页高度。
- 每页的渲染缩放由该页自身宽度推导（`src/components/PDFPage.tsx`），不要用第 1 页的宽度套所有页。
- pdf.js 的文字层流可能卡住：`PDFPage` 对它有超时 + 自动重试 + 「重新载入文档」兜底，任何情况下都不要让已渲染的页面被载入遮罩永久盖住。渲染时给每次渲染一个新的 canvas 元素，避免 pdf.js 复用画布导致的 `UnknownVizError`。
- 不受信任的文档内容（EPUB 的 XHTML）**不能**用 `dangerouslySetInnerHTML`：走 `EpubReader` 的 DOMPurify `RETURN_DOM_FRAGMENT` + `replaceChildren` 路径；Markdown/TXT 一律渲染成 React 元素。

## 四、命令

| 命令 | 作用 |
| --- | --- |
| `npm run app` | 构建并在本机以 app 形态运行（推荐日常使用） |
| `npm run app:dev` | 开发模式：Vite dev server + Electron 窗口（热更新） |
| `npm run dev` | 只起浏览器调试（无文件夹浏览时退化为文件选择器） |
| `npm run check` | 构建 + 单元测试 |
| `npm test` | 只跑单元测试（node --test） |
| `npm run smoke` | Electron 端到端冒烟 + 截图 |
| `npm run app:mac` | 只更新仓库根 `./Paperlight.app`，不生成安装包 |
| `npm run dist:mac` / `dist:win` / `dist:linux`、`npm run dist` | 用户明确要求维护分发包时才运行 |
| `npm run icons` | 图标变更后重新生成 icns/ico（仅 macOS） |
| V2 开发批次 | 更新预览版本、`CHANGELOG.md`、检查与本地 App；只提交并推送当前 V2 开发分支，不创建正式标签或 Release |

快捷键上的约定：`⌘N` 新建空白笔记（任意空间），标签栏的 `+` 也是「新建标签页」——阅读空间是菜单（打开文档… / 新建空白笔记），笔记空间直接建空白笔记。

## 四点五、V2 开发批次版本管理

V2 批次固定版本：V2.1=`2.1.0`、V2.2=`2.2.0`、V2.3=`2.3.0`、V2.4=`2.4.0`、V2.5=`2.5.0`；批次内修复可递增 patch 位。

每批按以下流程执行：

1. 核对当前分支与工作树；只改用户反馈范围。
2. 完成定点测试与本批验收，然后运行 `npm run check`、`npm run smoke` 和 `npm run app:mac` 更新仓库根 `Paperlight.app`。
3. 手动更新 `package.json`、`package-lock.json` 与 `CHANGELOG.md`。如使用 npm 命令改版本，只能用 `npm version <版本号> --no-git-tag-version`。
4. 只暂存本批明确修改的文件；不得用 `git add -A`，不要暂存用户草稿、`.codex/` 或生成产物。
5. 创建准确描述的 commit，并推送到现有 `codex/paperlight-v2` 分支。禁止 force push。
6. V2 开发批次不维护安装包，不创建或推送 `v*` 标签，不发布 GitHub Release，不合并 `main`。`npm run release` 属于正式发布流程，本轮不得调用。

正式发版另走已有发布流程；上述 V2 开发批次规约优先于历史版本脚本说明。

## 五、状态与数据

- 应用状态文件：`<userData>/paperlight-state.json`
  - 打包后 userData 通常为 `~/Library/Application Support/Paperlight/`；开发模式为 `app.getPath('userData')` 同名目录。
  - 内容：当前空间（`activeSpace`）、打开的标签页与阅读位置、当前文件夹、最近文件/文件夹、分栏宽度、模型设置、语义/笔记/对话数据，以及 `vault`（root / recentRoots / collapsed）、`notesSpace`（打开的笔记、当前笔记、编辑视图、面板宽度）、`chatSpace`（多段对话、每段对话的 `contextPaths`、栏宽）。
  - 旧的 localStorage 数据（`paperlight-senses-v1`、`paperlight-notebook-v2`、`paperlight-chat-v1`）首次启动时自动迁移。
  - 打包版首次启动时，若 `Paperlight.app` 位于项目目录内且项目根有 `.env.local`，会把密钥配置复制到 userData（权限 0600）；移动到别处则不会复制。
- **笔记在 vault 里，不在状态文件里**：`<vault>/materials/` 是用户自己的原始资料；`notes/<镜像>/` 放语义（`<词>--<语义>.md`）、记录本笔记（`<日期>-note-<序号>.md`）、AI 完整笔记与对话存回的笔记；`enlightenment/` 放专项发现；`Daily/` 放记录清单与日报。所有落盘动作都从 `src/components/useVault.ts` 走，不要在组件里另写一套。
- **记录清单的刷新**：进入笔记空间、笔记空间内 1.5 秒防抖（语义/记录本变化）、App 里 2.5 秒防抖、以及每次写入非 Daily 笔记后的 2 秒防抖（`useVault.writeNote`）；去重靠清单 frontmatter 的 `hash`（含条目路径）。
- **日报的生成**：`useVault.maybeGenerateReport` 每分钟看一次时间槽（`reportSlotDate`），每天每槽最多尝试一次（`scheduledAttempts`），成功后靠文件存在跳过；也可以由界面手动触发（`force`）。AI 失败回退 `localDailySummary`。
- 内置 HTTP 服务只监听 `127.0.0.1`，默认端口 `4178`（被占用时自动换端口）。
- `/api/*` 只接受 loopback 请求；写配置还要求同源 Origin + CSRF nonce。除 `translation-config` / `sense` / `translate` 外，新增 `vault-chat`（严格 grounded 对话）、`note`（AI 完整笔记）、`daily-summary`（日报：`records` + `findings`），三者同样只接受 loopback 请求并校验输入长度；vault 摘录预算 8 份 × 6000 字、合计 24000 字，专项发现预算 6 份 × 2500 字、合计 12000 字（`src/lib/vault.ts` 与 `server/api.mjs` 两侧常量要一致）。
- 冒烟测试会给进程一个本地假密钥（`sk-paperlight-smoke-stub`）以打开 AI 代码路径，所有 AI 端点都在渲染进程里被打桩，因此不会联网。
- **CI 的签名变量坑（v1.0.0 的 macOS job 就是这样挂的）**：GitHub 会把仓库里不存在的 secret 展开成「已定义但为空」的环境变量，electron-builder 见到空的 `CSC_LINK` 会拿空证书去签名，报 `empty password will be used for code signing` + `⨯ <项目目录> not a file` 并失败。本地没定义这些变量，所以本地打包正常、只有 CI 暴露。`.github/workflows/release.yml` 的 `Package` 步骤必须先清掉空值（并 `shell: bash`，三个 runner 都有 bash）。本地复现命令：`CSC_LINK= CSC_KEY_PASSWORD= APPLE_ID= npx electron-builder --mac --dir`。
- 打包产物在 `release/`；macOS 的 app 会同时放到仓库根 `./Paperlight.app`（`scripts/expose-mac-app.mjs` 用 rename 而不是 copy，避免破坏 framework 的符号链接）。
- 分发包是 ad-hoc 签名（`electron-builder.yml` 里 `mac.identity: '-'`）：`codesign --verify` 通过，因此不会出现"已损坏"，但未公证，对方第一次打开要右键→打开。配置 `CSC_LINK`/`WIN_CSC_LINK` 等 secrets 后即为正式签名 + 公证。

## 六、明确不做 / 不要回退

- 不恢复「GPT Boss / dsh_inputs / ACTIVE_TASK / 固定启动口令」那套工作流（已删除，见归档说明）。
- 不把 app 退回成「单文档、每次手动导入、渲染全部页面」的网页阅读器。
- 不做云端 vault 或多设备同步：vault 就是用户自己选的一个本地文件夹（浏览器调试模式才退化成虚拟 vault）。
- 不在 App 里改用户 vault 里非 Markdown 的文件：写操作只允许 `.md`/`.markdown`（`materials/` 下的 PDF/EPUB/TXT 只读、只在树里出现，点开去阅读空间）；`notes/_inbox` 之外的 `notes/` 目录与 `materials/` 的对应关系由镜像规则决定，不要手工造路径。
- 暂不做云同步、账号体系、OCR（扫描版 PDF 无文本层时只能阅读，不能选词）。
- 暂不做 MOBI/AZW3、DOCX、图片/CBZ（需要转换或图片阅读器；见 README 的格式说明）。
