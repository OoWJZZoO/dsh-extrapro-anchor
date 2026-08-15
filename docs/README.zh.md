# dsh-anchor-seed

[English](../README.md)

> 确定性轨迹锚定:在首个模型请求之前,向每个顶层会话注入一轮预先采样的 minimal 风格
> 虚拟读文件回合,其工具结果把会话"提升"到当前 preset 的真实提示词——不需要任何真实
> 工具调用,跨项目、跨 preset 通用。

一个 DeepSeek Harness 插件,把 `anchored-standard` 的思路通用化(证据见
[`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) 的 2026-08-14
触发机制实验与 98/99 双跑):

- `anchored-standard` 靠"首请求只给两个工具、等待真实 `tool/call` 后再晋升"来锚定
  轨迹——锚定依赖模型真实行为;
- `anchor-seed` 让锚定**确定性**发生:在首个请求之前把一轮虚拟回合追加进 session 日志。
  模型什么都不用做,首个真实请求就同时拥有完整工具目录和一段"刚完成 onboarding 读取的
  minimal 会话"历史。

这是社区项目,并非 DeepSeek 官方 preset,也不代表 DeepSeek 的认可或背书。

## 模型在首个请求看到的上下文(按序)

```
system         minimal persona 一句 + 两工具声明
               ("You have access to the following tools: bash,
                str_replace_editor …")——无论挂的是哪个普通 preset,其完整提示词
               在这里被插件替换掉
[user]         "Please read the entire <项目>/.dsh/<session id>/agent-dev-guide.md
                in the project root directory for detailed information, and work
                entirely according to the instructions it contains."
[assistant]    minimal 风格 reasoning + 一次 bash 工具调用
[tool result]  与该 bash 命令真实 stdout 完全一致的渲染:
                 Your access in this project has been elevated; you may now act
                 according to the following prompt:
                 <该 preset 的真实提示词>
                 The full tool catalog available in this session:
                 - bash: … - read: … - edit: …(每个工具名 + 描述)
[user]         用户真实首条消息
[user]         AGENTS.md / CLAUDE.md(system-reminder 框架——由 harness 自带的
               dsh-agent-instructions 注入,位于真实消息之后)
tools          完整目录——请求里的工具 SCHEMAS 从不被过滤
```

模型首次回复之前,转录严格就是这一序列:minimal persona → 虚拟读文件请求 →
虚拟 assistant 回应 + 工具调用 → guide 内容(preset 真实提示词唯一展开的位置,外加
全量工具目录文本)→ 用户真实首条消息 → AGENTS.md(harness 惯例)。插件自身**从不**
注入工作区指令;harness 内置 `dsh-agent-instructions`(dsh-base 依赖)在真实用户消息
之后编排 AGENTS.md/CLAUDE.md,与标准模式一致。除此之外不注入任何东西,preset 提示词
不会泄漏到任何其他通道误导模型。

系统替换是**全局且幂等**的:每次 `system-prompt/assemble` 都重新应用 minimal 段,
持久化的 `request/header` 在后续 step/turn 一直保持 minimal(请求缓存友好);工具
schemas 全程是全量目录——模型只是"以为"只有两个工具,直到虚拟轮的 result 揭示完整
清单。

guide 文件会在事件注入前**真实写盘**,内容与虚拟结果逐字一致,后续模型若真的去读该
文件不会发现矛盾。

## 为什么这样做

DeepSeek V4 Pro 会强烈依赖首轮 API 可见工具目录与请求结构(modeltest 探针实验):

- minimal system + 两工具 → `We need` 轨迹(Project2 99/96);
- 首请求即 25 工具 → `Let me` 轨迹(91);
- **首轮两工具锚定、随后晋升到全部 25 工具 → 轨迹保持(98/99)**——关键在首轮策略
  选择,完整工具之后仍可用。

`anchored-standard` 用"真实工具调用后晋升"复现了这一点;`anchor-seed` 用预先采样的
虚拟首轮替换真实首轮,于是:

- 锚定确定性成立,不依赖模型首个动作;
- 首请求即完整目录,没有 bootstrap、没有晋升逻辑;
- elevation 文本就是 preset 自己的提示词,同一插件可叠加到任意 preset、任意项目;
- 子 agent 永不注入(仅顶层会话)。

**声明边界:** 机制与已发布证据一致,但本插件本身是新的——上线前请先验证轨迹指纹
(见"验证加载")。

## 安装

### 方式一:自包含 preset(推荐,同 anchored-standard)

```sh
dsh_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$dsh_home/.agent-presets"
test ! -e "$dsh_home/.agent-presets/anchor-seed"
cp -R preset "$dsh_home/.agent-presets/anchor-seed"
```

完整重启 DeepSeek Harness,新建空白会话,选择 **Anchor Seed (experimental)**。
不要在已有内容的会话中途切换 preset。示例组合保留 Minimal system prompt(complete)
并挂载完整 Standard 工具集——即 anchored-standard 的表面,去掉 bootstrap,加上种子。

### 方式二:作为 bundle 插件叠加到自有 preset

在任意 preset 的 `agent.cordis.yml` 里加一行:

```yaml
- id: anchor-seed
  name: '@deepseek-ai/dsh-anchor-seed'
  config:
    elevationPrompt: ''   # '' → 自动捕获非 persona 提示词段
```

锚定按设计生效的前提:

- **不再要求组合自带 minimal persona**:插件自己会在每次组装时把 system 提示词替换为
  minimal persona + 两工具声明,不管挂的是什么 preset;preset 的完整提示词被捕获进
  guide 文件(elevation),由虚拟轮揭示;
- 工作区指令(AGENTS.md/CLAUDE.md)由 **harness 而非插件**注入:harness 自带
  `dsh-agent-instructions`(dsh-base 依赖)在用户真实首条消息之后编排它们(标准惯例)。
  anchor-seed 不自行注入指令,也无需去重。`injectProjectInstructions` /
  `maxInstructionsBytes` 配置键为兼容保留,实际无作用。

## 配置(组合行 `config`)

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `elevationPrompt` | `''` | 放在 elevation 句子之后的 preset 真实提示词。 |
| `elevationSource` | `auto` | `auto`:捕获组装中的非 persona 提示词段(空则回退 `elevationPrompt`);`config`:只用 `elevationPrompt`;`none`:只有句子。 |
| `elevationNotice` | `Your access in this project has been elevated; you may now act according to the following prompt:` | 固定框架句。 |
| `personaSection` | `persona` | 自动捕获时排除的段名。 |
| `virtualUserTemplate` | 预采样(见 `lib/runtime.js`) | 虚拟用户消息模板;`{path}` 替换为项目根相对路径(`.dsh/<id>/agent-dev-guide.md`)。默认文本来自 modeltest 指纹最优一轮的逐字采样。 |
| `virtualReasoningTemplate` | 预采样(见 `lib/runtime.js`) | 虚拟 assistant 的 reasoning 文本;默认是同一轮的逐字 minimal "We need" 首块。 |
| `virtualToolName` | `bash` | 虚拟 assistant 调用的工具名(minimal 实际面是 `bash` + `str_replace_editor`,没有 `read` 工具)。 |
| `virtualCommandTemplate` | `pwd && cat {path}` | bash 命令;其虚构 stdout 即工具结果。 |
| `injectProjectInstructions` | `true` | **惰性(兼容保留)。** 工作区指令由 harness 自带的 `dsh-agent-instructions` 在用户真实首条消息之后注入。 |
| `maxInstructionsBytes` | `65536` | **惰性(兼容保留)。** 见 `injectProjectInstructions`。 |
| `guard.enabled` | `true` | 环境自检开关;`false` 跳过自检强行加载。 |

## 验证加载

导出 session JSONL,检查首轮事件:

- 一个 `user/message`(读请求,source 为 `plugin`)、一个含 `reasoning` 块与单个
  `tool-call` 的 `assistant/message`、一个 `tool/call`、一个内容为 guide 文件的
  `tool/result`;
- `tool/result` 带 `surfaceOp: append` 与 `sourceEventSeqs: [<tool/call seq>]`;
- `.dsh/<session id>/agent-dev-guide.md` 真实存在且与虚拟结果内容一致;
- 首个 `request/header` 已包含完整工具目录。

零依赖测试:

```sh
npm test
```

## 重要行为

- 种子在首个 `system-prompt/assemble` waterfall 内追加,早于 `buildRequest` 派生
  请求消息——首个真实请求必然包含虚拟轮。
- 仅顶层新鲜会话:子 agent(`delegationDepth > 0`)永不注入;已有 `user/message` 的
  会话永不重复注入(种子事件是持久的,resume/reload 天然幂等)。
- 虚拟 `tool/result` 与 `dsh-tool-fs` 的 `read` 输出逐字节一致(`<path>` 信封、行号、
  `(End of file - total N lines)`),且磁盘文件相同,真实读取无法推翻转录。
- 所有失败路径都降级:自检失败、guide 写入失败、会话拒绝事件——只记一次告警,会话
  不带锚定继续运行;插件钩子绝不向 harness 抛错。
- 插件无网络请求、无遥测。
- 与 shell 同级信任:插件会向项目写入一个文件(`.dsh/<session id>/agent-dev-guide.md`),
  请把 `.dsh/` 加入项目 .gitignore。

## 已知限制

- 默认虚拟对话文本是**一轮真实采样的逐字原文**(`session-1018c36f`,minimal preset,
  由 `scripts/find-best-sampling-round.mjs` 按 modeltest 指纹选出)。属于 n=1 采样:
  若你有更合适的轮次,可用 `virtualUserTemplate`/`virtualReasoningTemplate` 替换。
- 虚拟工具结果是 `pwd && cat <guide>` 的虚构 stdout(`<cwd>\n<内容>`)。若覆盖
  `virtualCommandTemplate`,请保持结果格式与该命令真实输出一致。
- elevation 位于首个工具结果;长会话的压缩可能摘要或裁剪它(anchored-standard 的一次
  性晋升也有同样约束)。工具目录恒定,因此请求前缀缓存只在首请求前后变化一次。
- 需要在你自己的模型/环境上做 n=1 实测;已发布的 98/99 证据针对 DeepSeek V4 Pro 与
  单一冻结题面。

## 开发

`lib/runtime.js` 是纯逻辑(无 harness 依赖,完全可单测);`lib/index.js` 是 Cordis
宿主插件;`lib/guards.js` 是 fail-safe 环境自检(dsh-read-image 模式)。
`preset/lib/` 是构建快照——改动 `lib/` 后运行 `scripts/build-preset.sh`。

采样辅助:`scripts/find-best-sampling-round.mjs` 批量扫描
`$DSH_HOME/sessions/<cwd-slug>/`,按 modeltest minimal 指纹(逐字复用
`modeltest/evaluator/trigger_probe` 的 `classifyReasoning`)给每个会话打分排序,
输出最优一轮的首个 reasoning 块、用户消息与工具调用,可直接填入
`virtualUserTemplate`/`virtualReasoningTemplate`。需要 `unzstd` CLI。

## 许可证

MIT。`preset/agent.cordis.yml` 派生自 DeepSeek Harness Standard preset 与
`xiaobright/dsh-anchored-standard`,原始 DeepSeek 版权与 MIT 声明保留在
[`NOTICE`](../NOTICE)。
