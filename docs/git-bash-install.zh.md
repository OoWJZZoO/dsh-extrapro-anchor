# Git Bash 安装教程（Windows 兼容模式）

## 为什么需要安装 Git Bash

在 Windows 上，`dsh-extrapro-anchor` 的兼容模式使用 Git Bash 自带的
`bash.exe` 来提供 `bash` 工具，从而替代默认的 `pwsh`，让锚定轨迹与
Linux 环境保持一致。

如果系统里找不到 Git Bash：

- 插件不会注册兼容的 `bash` 工具，会话继续使用 `pwsh`；
- 模型更容易偏到 `let me` 风格，面板会显示**黄色/红色健康度**，并提示
  “Git Bash 未安装”。

安装完成后需要**重启 `dsh web`**，插件才会重新检测并注册 `bash` 工具。

## 方案一（推荐）：让 AI 助手帮你安装

复制下面这段提示词：

```text
请帮我安装Git Bash并将bash注册进PATH
```

把它粘贴给任意一个能在本机执行命令的 AI 助手，例如：

- DeepSeek Harness
- Claude Code
- OpenAI Codex
- 其他 AI 编程助手

助手会下载 Git for Windows、运行安装程序、并把 `bash.exe` 加入 `PATH`。
安装完成后，重启 `dsh web` 即可。

## 方案二：手动安装

1. 打开 Git for Windows 官方下载页：

   <https://git-scm.com/download/win>

2. 下载并运行安装程序。

3. 安装过程中，在 **“Adjusting your PATH environment”** 页面选择：

   `Git from the command line and also from 3rd-party software`

   （这个选项会把 `bash.exe` 注册进 `PATH`，正是插件需要的。）

4. 其他选项保持默认即可，一路完成安装。

5. 打开一个新的 PowerShell 窗口验证：

   ```powershell
   where.exe bash
   ```

   应能看到类似 `C:\Program Files\Git\bin\bash.exe` 的路径。

## 安装后的验证

1. 完全重启 `dsh web`（不是只刷新网页）。
2. 新建一个会话，并打开悬浮面板上的锚定注入开关。
3. 面板健康度恢复正常后，兼容的 `bash` 工具会带有
   `run_in_background` 参数，后台任务可用 `job_output` / `job_kill`
   管理。
4. 如果面板仍显示“Git Bash 未安装”，请确认 `bash.exe` 已在 `PATH`
   中，然后再次重启 `dsh web`。
