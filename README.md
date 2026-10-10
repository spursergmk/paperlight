# Paperlight

**把真实英语材料读懂，把值得掌握的表达和理解留在自己手里。**

Paperlight 是一款本地优先的桌面英语阅读与语言积累应用。它把材料阅读、阅读助手、表达池、Markdown Vault 和 grounded 对话放在同一套工作流里，帮助你从阅读走向理解与积累。

当前代码版本为 **2.5.0**。V2.5 收尾了本轮从 V2.0 体验中标出的四项问题：PDF 阅读书签恢复到段落、输入标记支持视觉样式和评论、旧 inbox 安全迁移、表达来源回跳时高亮原文。代码已进入 `main`；这不代表已发布 GitHub Release 或正式安装包。

## 功能一览

### 阅读空间

- 在同一窗口打开 **PDF、EPUB、TXT 和 Markdown**，支持多标签、文件夹浏览、最近材料和目录跳转。
- 选中文字后，内容只会填入阅读助手的查询框；点击查询或按 Enter 才会发起 AI 请求。
- 阅读助手可查询语境中的词义、翻译选中文本、追问和保存完整回答。初次回答与每条追问回答都能分别存为 Markdown 笔记。
- 阅读书签保存阅读位置和原文线索。EPUB、TXT 和 Markdown 可恢复段落或章节位置；PDF 会尝试匹配并返回原文段落。
- 输入标记把“目的”和“呈现”分开：目的包括进度、形式、内容；呈现可选高亮或下划线，并可附评论。标记保存在 Paperlight 数据中，不改写原始 PDF 或 EPUB。

### 表达池

表达池用于积累可主动掌握的英语表达，独立于语义记录和自由笔记。

- 在阅读材料、阅读助手回答、对话、笔记和专项研究中选中表达，可直接收录；也可手动添加。
- **识别**从已经读过或讨论过的材料中摘录表达；**探索**从想表达的意思或已有表达出发寻找其他说法。
- AI 候选需要用户确认后才进入表达池，并标记为 AI 生成，不会伪装成真实材料引文。
- 确定性较高的重复表达会合并到同一记录，并保留每次出现的语境和来源；意思相近但形式不同的表达不会仅因相似而自动合并。
- 支持本地搜索、编辑、删除、查看语境，以及跳回原材料并高亮匹配的原文。

### 语义库与笔记空间

- 语义按“词汇 → 语义 → 来源语境”组织。同一词汇的不同语义分开保存；相同语义可以累积来自不同材料的实例。
- 阅读助手的完整回答和追问回答保存到 `notes/inbox/`；grounded 对话笔记保存到 `notes/interconnections/`；有材料上下文的语义笔记保存在相应的 `notes/<材料目录>/`。
- 笔记、语义、表达和专项研究成果均以普通 Markdown 文件保存在你选择的 Vault 文件夹中，可用其他编辑器查看和编辑。
- 搜索在本地完成，涵盖表达、语义和笔记正文；来源链接可帮助返回相关材料或笔记。

### 对话空间与专项研究

- 对话空间允许勾选 Vault 笔记作为 grounded 上下文。回答会标注来源；未选择笔记时，界面会明确说明回答不受 Vault 内容限定。
- Enlightenment 是自由 Markdown 专项研究空间。你可以把材料、笔记和对话关联到研究，不必填写固定模板；研究中的表达也能直接收录。

### Daily

每天使用一份 `Daily/<日期>.md`，呈现五部分：读了多久、读了什么、表达、语义、总结与勉励。

阅读时间是估算值：应用在后台、阅读器失焦或长时间无操作时不会继续累计，并按本地午夜分日。Daily 总结根据当天记录生成；已有 Markdown 和用户补充内容会受到保护。

## Vault 目录

Vault 是普通文件夹，由用户自己掌握。Paperlight 会按需建立管理目录：

```text
Vault/
├── materials/              原始阅读材料
├── notes/
│   ├── inbox/              随手笔记、阅读助手回答和非 grounded 对话笔记
│   ├── interconnections/   grounded 对话笔记
│   └── <材料目录>/         与材料关联的语义和笔记
├── expressions/            表达记录及其多个来源语境
├── enlightenment/          自由 Markdown 专项研究
└── Daily/
    └── YYYY-MM-DD.md       当天五部分记录
```

旧版 `notes/_inbox/` 中可识别的 Markdown 会先复制到 `notes/inbox/` 并校验内容，再移除已成功迁移的源文件。同名但内容不同的文件、非 Markdown 文件或无法安全迁移的内容会留在原位置，供用户检查；Paperlight 不会递归删除旧目录。

## 安全与数据控制

- 笔记 Markdown 是权威数据；应用状态和搜索数据用于恢复界面与加速检索，不替代 Vault 原文件。
- Vault 文件读写由 Electron 主进程执行，路径受所选 Vault 限制，并检查路径穿越和符号链接越界；笔记采用临时文件写入后原子替换。
- PDF 和 EPUB 原始文件保持不变；阅读标记作为 Paperlight 数据保存。
- AI 请求经本机 `127.0.0.1` 代理发送，仅在用户主动触发时发送。若启用了 Daily 定时生成，则遵循用户设置的时间。
- 已保存的 API Key 留在本机，不进入前端 bundle 或 Git。开发模式读取项目根目录的 `.env.local`；打包 App 使用自己的用户数据目录。把仓库根目录的 `Paperlight.app` 首次启动时，已有 `.env.local` 配置可导入 App 配置目录，因此升级后可继续使用现有 Key，无需为 V2.5 新建一份。`.env.local` 不应提交到仓库。
- 外部 API 地址必须使用 HTTPS，并受允许主机列表约束。渲染进程启用 context isolation、禁用 Node integration，并由严格的内容安全策略保护。

## 开始使用

### 运行源码

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run app
```

首次启动后，在应用内选择一个 Vault 文件夹。若希望隔离试用数据，可通过独立的应用状态目录启动：

```bash
PAPERLIGHT_USER_DATA_DIR=/tmp/paperlight-v25-profile npm run app
```

配置或复用本机已有的 OpenAI 兼容 API Key：打开右上角 AI 设置，选择服务并填写 Base URL、模型和 Key。DeepSeek、OpenAI 与已配置的 ZJUAI 网关均由本地代理支持。也可在开发环境中使用 `.env.local` 或 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 环境变量。

### 构建 macOS 试用 App

```bash
npm run app:mac
```

命令会更新仓库根目录的 `Paperlight.app`，生成 universal（Intel 与 Apple Silicon）目录型 App，不生成 DMG、PKG 或其他安装包。当前试用 App 使用 ad-hoc 签名，未经过 Apple 公证；macOS 可能在首次打开时提示确认。

### 开发与验证

| 命令 | 用途 |
| --- | --- |
| `npm run app:dev` | Vite 与 Electron 开发模式 |
| `npm run dev` | 浏览器界面调试；文件权限和持久 Vault 能力以 Electron App 为准 |
| `npm run check` | TypeScript 检查、生产构建、自动化测试和 Node 脚本语法检查 |
| `npm run smoke` | 驱动 Electron 窗口验证实际交互，结果和截图写入 `tests/artifacts/` |

Smoke 使用自动生成的临时材料、临时 Vault 和本地 AI stub，不读取真实 Vault，也不调用真实模型服务。

## 已知边界

- 扫描版 PDF 没有可选择的文字层；当前不包含 OCR。
- PDF 段落书签依据 PDF.js 文字层和行间距推断段落边界。材料文本改变或无法可靠匹配时，会提示并退回页级位置，不静默跳到相似文本。
- 阅读时间为合理估算，不是系统级精确计时。
- AI 生成的语义、翻译、总结与表达建议应结合原文核对；AI 生成表达会与真实来源摘录区分标记。

## 版本与反馈

主分支目前包含 Paperlight 2.5.0 的 V2.5 改进。本仓库尚未因此创建正式版本标签或 GitHub Release。变更细节见 [CHANGELOG.md](CHANGELOG.md)，开发约定见 [AGENTS.md](AGENTS.md)。
