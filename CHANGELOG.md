# 更新记录（CHANGELOG）

Paperlight 的版本号规则：**整数部分 = 大版本功能变更，小数部分 = 修复式小更新**。

| 变化 | 版本示例 |
| --- | --- |
| 大功能（新的空间、新的知识管理形态） | 1.0.0 → **2.0.0** |
| 修复与小改进（界面细节、逻辑 bug、文案） | 1.0.0 → **1.1.0** |
| 单点热修 | 1.1.0 → **1.1.1** |

每次更新：先写清楚改动，然后由用户明确批准后才运行 `npm run release -- minor "一句话摘要"`（或 `major` / `patch`）——脚本会改版本号、提交并推送标签。没有明确批准时，只更新本地工作树，不创建正式标签或 Release。

## Unreleased · V2.0 worktree（未发布、尚未完成）

正式版本号仍为 **1.0.2**。以下内容位于隔离分支 `codex/paperlight-v2`，不能据此宣称 Paperlight V2.0 已完成。

### 已实现并验证的增量

- 表达池以 Markdown 保存表达本体、Recognition/Exploration 来源、多个材料语境和表达联系；PDF/EPUB 重复摘录会合并到同一表达，AI 探索候选必须由用户确认后才写入。
- 阅读 PDF/EPUB/TXT/Markdown 与阅读助手回答可直接收录表达；对话消息支持直接摘录。表达池提供本地搜索、编辑、删除、关系和来源回跳。
- PDF、EPUB、文本材料支持进度/形式/内容输入标记；视觉高亮、下划线不修改原始材料。定位使用原文摘录和上下文校验，无法可靠恢复时明确标出。
- 语义记录累积带来源的语境；归档到原 V1 文件路径时保留用户编辑的 Markdown，只更新 Paperlight 标记的语境块。继续读取旧 ID、文件路径、`senses` frontmatter 与 `/api/sense`。
- 新增本地表达/语义/笔记检索；Daily 改为五段，并只把前台阅读器中近期有交互的时长计为估算阅读时间，跨午夜分日。Daily 管理区有内容指纹，检测到手改内容时先保留原文快照再重建。
- `PAPERLIGHT_USER_DATA_DIR` 为开发版提供隔离应用状态目录，避免试用 V2 与正式 V1 共用状态文件。

### 尚未完成

- P0/P1 全量验收尚未结束：仍需完成完整语义增量整合交互、更多格式与来源的标记回溯复核、阅读助手单词至全文尺度、Enlightenment 专项研究关联和网页正文导入等。
- 三平台本地打包已完成并验证 macOS App 可启动；当前没有签名/公证凭据，未做正式签名、公证或发布验收。包版本未升级，未创建或推送 Git 标签，也未发布 GitHub Release。
- 构建仍有主 JS chunk 大于 500 KB 的 Vite 警告。

### 当前验证

- `npm run check`：89 个测试通过，含构建、单元测试和 Node 语法检查；Daily 手动编辑保护有单测。
- `npm run smoke`：Electron 桌面 smoke 通过；覆盖 V1 阅读/笔记/对话回归、PDF/EPUB 表达、AI 候选确认、PDF 标记重开、EPUB 标记跳回章节、五段 Daily、阅读时间估算和旧 Daily 迁移。
- `npm run dist`：macOS universal（App/DMG/ZIP）、Windows x64（安装包/ZIP）、Linux x64（AppImage）均生成；隔离配置启动 macOS App 后保持运行并正常退出。产物仅留在 worktree 的 `release/` 与 `Paperlight.app`，未发布。

## [1.0.2] - 2026-10-08

### 改进

- 修复 GitHub Actions 的 macOS 打包：GitHub 会把缺失的签名 secret 展开成空变量，electron-builder 因此用空证书签名并失败（v1.0.0 的 macOS job 就是如此）；现在先清掉空值，并在打包失败时打印日志尾部

<details>
<summary>改动文件（2）</summary>

**根目录**

- `github/workflows/release.yml`（修改）
- `AGENTS.md`（修改）

</details>

## [1.0.1] - 2026-10-08

### 改进

- 发布脚本：版本号只改写本包的 version 字段并做 JSON 校验（避免误改依赖版本），推送失败时提示凭据修复方式

<details>
<summary>改动文件（1）</summary>

**根目录**

- `cripts/release.mjs`（修改）

</details>

## [1.0.0] - 2026-10-08

第一个正式版本：从「本地英文文档阅读器」升级为 **阅读 + 笔记 + 对话** 三空间的本地知识工作台。所有内容都在本机，笔记是 vault 里的普通 Markdown。

### 新增

- **笔记空间**：与阅读空间并列，最左侧竖排 rail / `⌘⌥2` 进入。Obsidian 式排布 —— vault 文件夹树、笔记标签、单栏编辑/浏览（右上角切换，`⌘E`）、右侧信息面板（类型、字数、关联义项、链接到的笔记、今日记录、日报、最近改动）。所有笔记都是 vault 里的 `.md`，支持 `[[另一份笔记]]` 跳转，1.2 秒自动保存（`⌘S` 立即保存），写入用「临时文件 + rename」。
- **项目 vault**：首次进入选择一个文件夹即可（`⌘⇧V` / 菜单 `文件 → 打开笔记 vault…`），自动建好 `materials/`、`notes/`、`enlightenment/`、`Daily/` 四个目录，vault 路径与最近使用会记住。
  - `materials/` 放原始阅读资料，你自己组织（`materials/books/`、`materials/articles/`…）；树里可以直接点开 PDF/EPUB/TXT 进入阅读空间。
  - `notes/` 自动镜像 `materials/` 的目录：`materials/books/book1.pdf` 或 `materials/books/book1/ch1.pdf` 的义项与笔记都归到 `notes/books/book1/`；没有资料上下文的（对话存回的、随手新建的）进 `notes/_inbox/`。
  - `enlightenment/` 是你的「专项发现」，日报会读它。
  - 读取/写入全部走主进程 `vault:*` IPC：相对路径、禁止 `..`、符号链接检查、只允许 `.md`。
- **对话空间**：专门为 vault 知识挖掘设计。左栏两列 —— 对话记录 + vault 内容选择；勾选后对话**严格 grounded**（最多 8 份 × 前 6000 字），回答标注 `grounded` 徽标与 `[[来源笔记]]`，摘录里没有就直说没有；未勾选时明确提示「未限定 vault 内容」。每条回答可一键存回 vault、复制、跳转来源。
- **每日记录清单 + 日报**：`Daily/<日期>.md` 是本地即时整理的当天收录（义项、记录本笔记、当天新建或修改的 vault 文件，全部带链接，`## 我的补充` 归你）；`Daily/<日期>-report.md` 是独立成文件的日报，在设置的时间（默认 20:00，可改/可关）自动生成或手动生成，读 `enlightenment/` 里的专项发现，**每次覆盖上一版**。
- **AI 完整笔记**：义项卡或笔记信息面板一键让模型写一份结构完整的 Markdown 笔记，存进对应材料的 `notes/` 目录。
- **待归档义项**：记录本里还没有对应 vault 文件的义项会在笔记空间右侧列出，一键全部写入。
- 新的 AI 端点（都只接受 loopback 请求）：`/api/vault-chat`（严格 grounded 对话）、`/api/note`（完整笔记）、`/api/daily-summary`（日报）。

### 改进

- 阅读助手新增进入笔记空间的按钮，义项卡下方提供「义项存入 vault」「生成 AI 完整笔记」，并显示「这条会话的笔记会存到 notes/<资料夹>/」；记录本每条笔记可单独「存入 vault」。
- 笔记区不再左右分栏：编辑与浏览各自铺满，右上角切换（旧的并排模式自动回落为编辑）。
- 标签栏的 `+` 成为真正的「新建标签页」：阅读空间是菜单（打开文档… / 新建空白笔记），笔记空间直接建空白笔记；任意空间 `⌘N` 新建空白笔记。
- 删除阅读空间侧栏里与竖排 rail 重复的「空间」一排按钮。

### 修复

- 当天记录清单的「关联义项」不再显示为空：清单 frontmatter 写入 `senses`，每条收录都是可点击的 `[[真实路径|标题]]`。
- 义项先「加入记录本」、后「存入 vault」时不再链到错误的 `_inbox` 路径：写入时记录真实路径（`notePath`）并优先使用，路径变化也计入清单哈希。
- 旧版 `Paperlight/Daily/*.md` 自动迁移到 `Daily/`：原来的汇总整理成独立的日报文件（含 `### 主题脉络 / ### 待跟进` 全部小节），`## 我的补充` 原样保留。

### 说明

- 应用状态仍在 `<userData>/paperlight-state.json`（空间、标签页、分栏、义项/笔记/对话、vault 路径、笔记与对话空间的布局、日报时间）。
- 冒烟测试覆盖三空间：`npm run smoke`（vault 镜像归档、单栏模式、记录清单与 senses、日报独立文件与 findings、旧日记迁移、`+` 新建空白笔记、grounded 对话）。
- 打包目标不变：macOS（universal）/ Windows(x64) / Linux(x64)，`./Paperlight.app` 为本地 app 形态。

## [0.2.0] - 2026-10-07（历史补记）

v1.0 之前的阅读器基线：

- PDF（pdf.js 逐页渲染 + 文字层，视口虚拟化）、EPUB（章节渲染 + DOMPurify 清洗）、TXT / Markdown（渐进渲染 + 锚点目录）；文件夹浏览、多标签、阅读位置记忆。
- 阅读助手：结合上下文的义项查询、全部义项、围绕义项的追问、记录本（词语 ↔ 含义 + 按日期编号的笔记）。
- 本地 AI 代理（`server/api.mjs`，Vite dev 与 app 共用）、密钥只存本机、`/api/*` 仅 loopback。
- 打包：electron-builder 三平台配置、GitHub Actions 出包。
