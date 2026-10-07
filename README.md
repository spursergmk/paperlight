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

### 启用 OpenAI 翻译

1. 将 `.env.example` 复制为 `.env.local`。
2. 在 `.env.local` 中设置自己的 `OPENAI_API_KEY`。
3. 重启 `npm run dev`，点击右上角“模拟翻译”，选择“OpenAI API”。模型默认是 `gpt-5-mini`，也可以在设置中修改。

密钥由 Vite 本地开发服务器读取，通过本地 `/api/translate` 代理请求 OpenAI Responses API，不会打包进浏览器代码。不要把 `.env.local` 提交到版本库。

生产构建可运行 `npm run build`，本 MVP 中 OpenAI 翻译代理只挂载在 Vite 开发服务器上；要部署为正式服务时，应将同一 provider 接到受控的服务端 API。

## 阅读与翻译

- 点击“打开 PDF”或把 `.pdf` 拖入窗口。
- 在 PDF 中拖选英文句子或段落，选区上方会出现翻译浮层；右侧“翻译”面板会显示译文、所在页及原文上下文。
- 左侧“页面”列出缩略图，“目录”显示 PDF 内置书签（如果文件带有目录）。点缩略图或目录项可跳转。
- 右侧面板可折叠；“保存为笔记”会将原文、译文和页码保存到当前浏览器。笔记可编辑并删除。
- 拖入 PDF、页面渲染与本地笔记都在浏览器端完成。扫描版 PDF 没有文本层时暂时无法选词翻译，需要 OCR 后续支持。
- 模拟翻译用于体验操作流程，只有少数常见句子带示例译文；其他句子会明确标记为占位内容。需要实际翻译时配置 OpenAI API。

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 打开 PDF | `⌘ O`（macOS）或 `Ctrl O` |
| 放大 / 缩小 | `⌘ +` / `⌘ -` 或 `Ctrl +` / `Ctrl -` |
| 上一页 / 下一页 | `←` / `→` |
| 关闭浮层或设置 | `Esc` |

页码输入框支持输入页码后按 Enter 跳转；工具栏的“适宽”按钮恢复适合阅读区宽度。

## 翻译 provider

界面通过 `src/lib/translation.ts` 的 `translateSelection` 接口请求 provider。`mock` 不访问网络，`openai` 请求 Vite 侧的 `/api/translate`；服务端仅转发选中文本以及前后各一小段上下文。可在此模块添加其他翻译服务，而不必改动 PDF 阅读和选区界面。
