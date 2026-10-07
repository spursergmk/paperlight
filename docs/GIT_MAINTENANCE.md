# Git 自动维护

公开仓库：`https://github.com/spursergmk/paperlight`

`scripts/git-maintain.sh` 用于在一次任务完成并验证后，把明确指定的文件提交并推送到公开 `main` 分支。完整 DSH 任务历史保留在本地 `local/private-history` 分支，脚本禁止从该分支推送。

## 使用方法

从仓库根目录运行：

```bash
scripts/git-maintain.sh "fix: describe the completed change" path/to/file another/file
```

脚本会：

1. 拒绝已有暂存内容、detached HEAD、缺少 `origin` 或缺少仓库作者信息的状态。
2. 只暂存命令行明确列出的路径，不扫描或自动收集其他改动。
3. 拒绝提交环境密钥文件、PDF、本地 `dsh_inputs/` 任务记录、依赖目录、构建目录、`Paperlight.app` 和 `.DS_Store`。
4. 运行 `git diff --cached --check`。
5. 创建提交，并在成功后推送当前分支；首次推送会设置 upstream。

## 使用边界

- 调用者必须先完成与改动相匹配的测试或检查。
- 不要传入来源不明的文件或与当前任务无关的改动。
- 脚本不会执行 force push、删除分支、修改 remote 或解决合并冲突。
- push 失败时，本地提交会保留，便于检查网络或认证后重新推送。
- GitHub 凭据由 GitHub CLI/系统凭据存储管理，不得写入仓库文件。
