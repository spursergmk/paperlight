# Paperlight PDF 阅读器

一个本地运行的英文 PDF 阅读器 MVP。使用 PDF.js 显示 PDF 原页与可选中文本；选中英文后，页面旁的轻量浮层和右侧面板会立即显示中文翻译与原文上下文。

## 项目结构

```text
.
├── index.html
├── vite.config.ts              # 本地开发服务器与 OpenAI 翻译代理
├── src/
│   ├── App.tsx                  # 阅读器布局、文件打开、选区、笔记和快捷键
│   ├── components/
│   │   ├── PDFPage.tsx          # PDF.js 页面渲染与文字选择层
│   │   └── PDFThumbnail.tsx     # 页面缩略图
│   ├── lib/translation.ts       # 模拟 / OpenAI provider 接口
│   ├── types.ts
│   └── styles.css
├── .env.example
└── README.md
```

## 本地运行

需要 Node.js 20.19+ 或 22.12+。在项目目录运行：

```bash
npm install
npm run dev
```

开发服务器会显示本地地址，通常是 `http://127.0.0.1:5173`。用浏览器打开即可。无需密钥就能使用模拟翻译模式，PDF 文件由浏览器本地读取。

### 启用兼容 API 翻译

1. 启动 Paperlight，点击右上角“模拟翻译”，选择“OpenAI 兼容 API”。
2. 在设置面板顶部选择服务：**DeepSeek 官方** 或 **ZJUAI 网关**，也可以手动填写 Base URL。
3. DeepSeek 官方使用 `https://api.deepseek.com`，模型 `deepseek-flash`（即 DeepSeek-V4.1-Flash）。密钥请在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 申请。
4. 输入 API 密钥并点击“保存配置”。状态显示“API 已配置”后即可翻译。

请求协议按 Base URL 自动选择：`api.deepseek.com` 使用 OpenAI Chat Completions（`POST /chat/completions`），OpenAI 官方与 ZJUAI 网关使用 Responses（`POST /v1/responses`）。面板状态行会显示当前使用的协议。切换服务后需要填入该服务的密钥，密钥保存在同一个 `.env.local` 条目中。

Base URL 和密钥由本机 Vite 服务写入项目根目录的 `.env.local`，其中密钥文件权限为 `0600`。通过页面保存时，Base URL 必须是没有账号、端口、查询参数或片段的 HTTPS 地址；当前允许 `api.deepseek.com`、OpenAI 官方地址和 `api.zjuailab.club`，避免页面脚本把密钥转发到其他主机。页面不会回显密钥，也不会把它写入浏览器存储或打包进前端；`.env.local` 已被 Git 忽略。保存接口仅接受同源、本机请求，并使用 CSRF nonce 和原子文件替换。设置页可以更新配置或移除本机保存的密钥。

也可以在启动 Paperlight 前通过 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 环境变量提供配置。环境变量优先级最高；采用这种方式时，页面只显示配置状态，不能覆盖或删除配置。

翻译请求通过本地 `/api/translate` 代理调用所配置网关的兼容端点。Base URL 可以填写网关根地址或以 `/v1` 结尾的地址。生产构建可运行 `npm run build`；本 MVP 的代理只挂载在 Vite 开发服务器上，正式部署时应将同一 provider 接到受控的服务端 API。

## 阅读与翻译

- 点击“打开 PDF”或把 `.pdf` 拖入窗口。
- 在 PDF 中拖选一个词，右侧“义项”面板会结合上下文给出**这一处的准确含义**；选区浮层显示同样的结论。
- “查询词”输入框可以直接用键盘改写要查的词，按 Enter 重新查询。
- 左侧“页面”列出缩略图，“目录”显示 PDF 内置书签（如果文件带有目录）。点缩略图或目录项可跳转。
- 拖入 PDF 与页面渲染都在浏览器端完成。扫描版 PDF 没有文本层时无法选词，需要 OCR 后续支持。

## 阅读助手（义项 / 记录本 / 对话）

右侧三个面板：

1. **义项**：针对选区上下文消歧，给出中文含义、英文释义、例句、使用场景、使用建议、使用频率、替代表达、近反义词辨析与词根词缀。点“查看完整词典义项”可展开该词的全部义项。
2. **记录本**：核心记录是**不可自由编辑的「词语 ↔ 具体含义」原子**，而不是整个单词的全部义项。点“加入记录本”保存一条；每条原子下可以不断追加笔记。
3. **对话**：当前义项卡是对话的**固定首条输出**，之后可以自由提问。任意消息都能“存为笔记”。

笔记按本地日期编号为“某日期第 N 份笔记”，删除后序号不复用；每份笔记都带跳转到相关「词语 ↔ 含义」的链接。

## 关于内容来源与 AI 标记

- 例句分为两类并明确标注：**有出处**（给出作品/作者/年份或 URL）与 **AI 生成例句**。服务端强制校验：标记为“有出处”却缺少出处信息的例句会被自动降级为 AI 生成，避免伪造出处。
- 义项、用法建议与“完整词典义项”均由模型生成，**不是授权词典内容**，界面会明确提示自行核对。项目当前没有接入任何授权词典/语料，因此不承诺词典级权威性。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 打开 PDF | `⌘ O`（macOS）或 `Ctrl O` |
| 放大 / 缩小 | `⌘ +` / `⌘ -` 或 `Ctrl +` / `Ctrl -` |
| 上一页 / 下一页 | `←` / `→` |
| 关闭浮层或设置 | `Esc` |

页码输入框支持输入页码后按 Enter 跳转；工具栏的“适宽”按钮恢复适合阅读区宽度。

## 翻译 provider

- 整句翻译：`src/lib/translation.ts` 的 `translateSelection`；`mock` 不访问网络，`openai` 请求 Vite 侧的 `/api/translate`。
- 义项查询与对话：`src/lib/sense.ts` 请求 `/api/sense`，服务端按 provider 协议构造请求并强制 JSON 结构。
- 本地记录：`src/lib/notebook.ts`，保存在浏览器 localStorage（`paperlight-senses-v1`、`paperlight-notebook-v2`、`paperlight-chat-v1`）。
- 旧版整段译文笔记（`paperlight-notes-v1`）仍保留在浏览器中但不再展示，未自动迁移到新记录本。
