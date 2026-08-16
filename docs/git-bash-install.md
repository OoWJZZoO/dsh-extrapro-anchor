# Installing Git Bash (Windows compatibility mode)

## Why Git Bash is needed

On Windows, the compatibility mode of `dsh-extrapro-anchor` uses the
`bash.exe` shipped with Git Bash to provide the `bash` tool, replacing the
default `pwsh` so the anchored trajectory matches the Linux surface.

When Git Bash is missing:

- the plugin does not register the compatibility `bash` tool and the session
  keeps using `pwsh`;
- the model is more likely to drift into `let me` style, so the panel shows
  the **amber/red health state** with the message “Git Bash 未安装”
  (Git Bash not installed).

After installing, **restart `dsh web`** so the plugin can re-detect and
register the `bash` tool.

## Option 1 (recommended): let an AI assistant install it

Copy this prompt:

```text
请帮我安装Git Bash并将bash注册进PATH
```

(Translation: “Please help me install Git Bash and add bash to PATH.”)

Paste it into any AI assistant that can run commands on this machine, for
example:

- DeepSeek Harness
- Claude Code
- OpenAI Codex
- another AI coding assistant

The assistant will download Git for Windows, run the installer, and add
`bash.exe` to `PATH`. Afterwards, restart `dsh web`.

## Option 2: install manually

1. Open the official Git for Windows download page:

   <https://git-scm.com/download/win>

2. Download and run the installer.

3. On the **“Adjusting your PATH environment”** page, choose:

   `Git from the command line and also from 3rd-party software`

   This option registers `bash.exe` on `PATH`, which is exactly what the
   plugin needs.

4. Keep the remaining options at their defaults and finish the installation.

5. Open a new PowerShell window and verify:

   ```powershell
   where.exe bash
   ```

   It should print a path such as `C:\Program Files\Git\bin\bash.exe`.

## Verify after installation

1. Fully restart `dsh web` (refreshing the page is not enough).
2. Open a new session and turn on the anchor-injection switch in the
   floating panel.
3. Once the panel health returns to normal, the compatibility `bash` tool
   includes the `run_in_background` parameter; background jobs are managed
   with `job_output` / `job_kill`.
4. If the panel still shows “Git Bash 未安装”, confirm `bash.exe` is on
   `PATH` and restart `dsh web` again.
