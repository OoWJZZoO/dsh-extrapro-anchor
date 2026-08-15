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
- 附带一个**前台悬浮面板**(默认折叠、默认关闭、位于网页右侧):一键开关锚定注入、实时
  显示思考链健康度(最近的思考里出现 `let me` 就会变黄/变红提醒用户)、展开后可编辑
  注入文本并提供"恢复默认"。修改先在浏览器缓存,面板收起或下一次注入发生时落盘生效。

这是社区项目,并非 DeepSeek 官方 preset,也不代表 DeepSeek 的认可或背书。

## 模型在首个请求看到的上下文(按序)

```
system         minimal persona 一句 + 两工具声明
               ("You have access to the following tools: bash,
                str_replace_editor …")——无论挂的是哪个普通 preset,其完整提示词
               在这里被插件替换掉
[user]         "Please read the entire <项目>/.dsh/agent-dev-guide.md
                in the project root directory for detailed information, and work
                entirely according to the instructions it contains."
[assistant]    minimal 风格 reasoning + 一次 bash 工具调用
[tool result]  与该 bash 命令真实 stdout 完全一致的渲染:
                 When the user asks you to read this document and work
                 according to it, it means that your Agent's operation has
                 changed to some extent; please work according to the
                 following more detailed prompt:
                 <该 preset 的真实提示词>
[user]         用户真实首条消息
[user]         AGENTS.md / CLAUDE.md(system-reminder 框架——由 harness 自带的
               dsh-agent-instructions 注入,位于真实消息之后)
tools          完整目录——请求里的工具 SCHEMAS 从不被过滤
```

模型首次回复之前,转录严格就是这一序列:minimal persona → 虚拟读文件请求 →
虚拟 assistant 回应 + 工具调用 → guide 内容(preset 真实提示词唯一展开的位置)→
用户真实首条消息 → AGENTS.md(harness 惯例)。插件自身**从不**
注入工作区指令;harness 内置 `dsh-agent-instructions`(dsh-base 依赖)在真实用户消息
之后编排 AGENTS.md/CLAUDE.md,与标准模式一致。除此之外不注入任何东西,preset 提示词
不会泄漏到任何其他通道误导模型。

系统替换是**全局且幂等**的:每次 `system-prompt/assemble` 都重新应用 minimal 段,
持久化的 `request/header` 在后续 step/turn 一直保持 minimal(请求缓存友好);工具
schemas 全程是全量目录。完整目录不再复制进 guide 文件——每个工具的名称与描述都由
schema 本身提供。system 文字与工具 schema 的刻意错位是设计决策:虚拟轮已经"调用过
一次工具",全量 schema 才是模型真正能调用的面,两工具声明只塑造首请求策略。
白名单中的动态段(默认 `plan:policy`)在激活时**追加在** minimal 两段之后,plan mode
规则仍能进入 system,同时不动 runtime context 及其缓存前缀。

> **自包含 preset 注意。** `preset/agent.cordis.yml` 保持 persona `complete: true`;
> harness 会在 waterfall 之后强制执行该 complete 段,因此在这个 preset 里最终 system
> 只有 minimal persona 一句(两工具声明不可见)。这也是刻意的:模型真正会用到的工具
> 来自全量请求 schema,旧的 minimal 工具名不属于真实可调用面,不必出现。叠加在**没有**
> complete 段的普通 preset 上时,两工具声明会正常出现在 system 里。

guide 文件会在事件注入前**真实写盘**——单一共享 `.dsh/agent-dev-guide.md`,每次
fresh seed 直接覆盖,内容与虚拟结果逐字一致;读取结果已持久化在会话日志中,注入后
转录不再依赖该文件。

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

## 实测对照(2026-08-15)

冻结的 Project2 V4.1b 评测,每组一次:WSL2、DeepSeek V4 Pro(官方 API)、reasoning
`max`、无 MCP、无 dsh-read-image、DSH 0.1.0-rc.6。

| 配置 | Ability | hidden | ESP static | 真实构建 |
|---|---:|---:|---:|---|
| minimal 原生(无 anchor) | **97** | 43/45 | 9/9 | 通过(模型会话内自驱动) |
| standard + anchor-seed | **96** | 44/45 | 9/9 | 失败(编译错误) |
| code(PTC)+ anchor-seed | **88** | 42/45 | 8/9 | 失败(configure 阶段) |

对照原作者无 anchor 基线(同模型、`max`、WSL、官方 API):

| 配置 | 无 anchor(原作者) | + anchor-seed(本次) | Δ |
|---|---:|---:|---:|
| minimal | 99/96(2 工具 wire) | 97(25 工具 wire,harness 版本差异) | 不可直接比\* |
| standard | 91 | **96** | **+5** |
| PTC(code) | 92 | 88 | **−4** |

\* 本 harness 的 base 层注册了全局工具目录,minimal 原生首请求 wire 为 25 个工具
schema(原作者的 harness 只发 2 个工具),因此本机 minimal 原生 97 是当前 harness 的
原生基线,与原作者 2 工具 RL 面的 99/96 不可直接比较。

要点:

- **anchor 在 standard 上验证有效。** 虚拟轮把首请求拉进 minimal 轨迹("We need" 开头、
  "Let me" 归零),hidden 复现了 anchored-standard 的精确指纹——44/45,唯一 miss 与
  anchored-standard 两跑相同(F12-04 语义串)。96 vs 原作者无 anchor 的 standard 91;
  若固件编译通过,按冻结评分器应为 99(96 与 minimal 原生 97 的差距纯粹来自 F9 构建
  证据:run2 固件有一处真实编译错误——沿用了 v6.0 之前 esp-mqtt 的 `MQTT_EVENT` base
  宏,模型已在 PR 中如实记录)。
- **PTC 不适合 anchor。** 88 低于原作者无 anchor 的 PTC 基线(92)。虚拟轮是 bash/read
  风格转录,而 PTC 的 wire 面只有 `run_code` 一个入口,模型要调和"历史里用过的工具在
  当前面不可复现"的矛盾,且写程序的间接开销挤占了推理预算(ambient 会话权限与 ESP
  mqtt 依赖声明双双失守)。
- 每组 n=1,均为 provisional。F9:冻结的构建 runner 仅支持 Windows-PowerShell;run1
  的 F9=6/6 使用模型会话内真实成功构建的证据(stdpro.bin 已归档并附哈希),run2/run3
  维持冻结的 3/6 部分分。

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
自包含 preset 不带悬浮面板,因此其 `anchor-seed` 行写死了 `enabled: true`;这种安装方式
下注入默认开启。

### 方式二:作为 bundle 插件叠加到自有 preset

用 `dsh plugin add` 安装(其 `cordis.patch.yml` 会自动插入宿主 `anchor-seed` 行和
`anchor-seed-panel` 面板伴随行),或手工插入两行:

```yaml
- id: anchor-seed
  name: '@deepseek-ai/dsh-anchor-seed'
  config:
    elevationPrompt: ''   # '' → 自动捕获非 persona 提示词段
- id: anchor-seed-panel
  name: '@deepseek-ai/dsh-anchor-seed/panel'
  config: {}
```

重启 `dsh web`(或用 profile patch 热加载器热加面板行)后刷新现有页面,右侧会出现
折叠的悬浮面板。bundle 安装方式下注入**默认关闭**——把面板上的开关打开一次即可启用。

锚定按设计生效的前提:

- **不再要求组合自带 minimal persona**:插件自己会在每次组装时把 system 提示词替换为
  minimal persona + 两工具声明,不管挂的是什么 preset;preset 的完整提示词被捕获进
  guide 文件(elevation),由虚拟轮揭示;
- 工作区指令(AGENTS.md/CLAUDE.md)由 **harness 而非插件**注入:harness 自带
  `dsh-agent-instructions`(dsh-base 依赖)在用户真实首条消息之后编排它们(标准惯例)。
  anchor-seed 不自行注入指令,也无需去重。`injectProjectInstructions` /
  `maxInstructionsBytes` 配置键为兼容保留,实际无作用。

## 悬浮面板(Web)

伴随行 `@deepseek-ai/dsh-anchor-seed/panel` 在页面浮层里注册一个可拖动、可折叠的面板,
默认位于右侧、处于折叠状态,注入开关默认**关闭**:

- **折叠时**只显示两样:注入开关和思考链健康度;
- **展开后**可编辑四项注入文本(引导说明、虚拟提问、虚拟思考、注入命令),并提供一键
  **恢复插件内置默认值**。`{path}` 仍是项目根相对路径占位符;缺少 `{path}` 的模板会
  标红且不会被保存;
- 注入开关即时生效;文本修改先缓存在浏览器,面板**收起或下一次注入发生时落盘生效**
  (面板观察到新会话出现会先 flush),下一次 seed 永远使用最后持久化的值;
- 面板位置按浏览器记忆(`localStorage`),默认贴网页右侧。

健康度的量化方式来自仓库内参考证据:逐字采用
[`modeltest/evaluator/trigger_probe/src/classifier.mjs`](modeltest/evaluator/trigger_probe/src/classifier.mjs)
的词法分类器(`We need`/`we` 风格加分,`Let me` 减分),并对照
`dsh-anchored-standard` 与 `modeltest/docs/v4.1` 的轨迹表(锚定轮 `let me = 0/1`,
standard 轮 `let me = 208`)。因此最近的思考块里一旦出现 `let me`,读数立即变黄/变红;
稳定 `we` 风格显示绿色和 0–100 分。

设置持久化在 `$DSH_HOME/storages/anchor-seed/settings.json`(可用环境变量
`DSH_ANCHOR_SEED_SETTINGS_PATH` 覆盖)。宿主插件在每次 fresh seed 前按文件 mtime
重读——磁盘即事实。

## 配置(组合行 `config`)

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false`(面板姿态;自包含 preset 写 `true`) | 无面板设置文件时的注入开关兜底。面板落盘值在 seed 时覆盖此值。 |
| `settingsPath` | `$DSH_HOME/storages/anchor-seed/settings.json` | 面板设置文件路径覆盖(测试/特殊部署用)。 |
| `elevationPrompt` | `''` | 放在 elevation 句子之后的 preset 真实提示词。 |
| `elevationSource` | `auto` | `auto`:捕获组装中的非 persona 提示词段(空则回退 `elevationPrompt`);`config`:只用 `elevationPrompt`;`none`:只有句子。 |
| `elevationNotice` | `When the user asks you to read this document and work according to it, it means that your Agent's operation has changed to some extent; please work according to the following more detailed prompt:` | 固定框架句。 |
| `personaSection` | `deployment:persona` | 自动捕获时排除的段名(与 harness 自身在 dsh-system-prompt 中注册的 persona 段名一致)。 |
| `virtualUserTemplate` | 预采样(见 `lib/runtime.js`) | 虚拟用户消息模板;`{path}` 替换为项目根相对路径(`.dsh/agent-dev-guide.md`)。默认文本来自 modeltest 指纹最优一轮的逐字采样。 |
| `virtualReasoningTemplate` | 预采样(见 `lib/runtime.js`) | 虚拟 assistant 的 reasoning 文本;默认是同一轮的逐字 minimal "We need" 首块。 |
| `virtualToolName` | `bash` | 虚拟 assistant 调用的工具名(minimal 实际面是 `bash` + `str_replace_editor`,没有 `read` 工具)。 |
| `virtualCommandTemplate` | `pwd && cat {path}` | bash 命令;其虚构 stdout 即工具结果。 |
| `dynamicSections` | `['plan:policy']` | minimal 替换保留的动态 system 段白名单。段渲染文本非空时,追加在 minimal persona/tools 两段**之后**(例如 plan mode 激活时的规则文本)。 |
| `injectProjectInstructions` | `true` | **惰性(兼容保留)。** 工作区指令由 harness 自带的 `dsh-agent-instructions` 在用户真实首条消息之后注入。 |
| `maxInstructionsBytes` | `65536` | **惰性(兼容保留)。** 见 `injectProjectInstructions`。 |
| `guard.enabled` | `true` | 环境自检开关;`false` 跳过自检强行加载。 |

## 验证加载

面板(bundle 安装):刷新页面后右侧出现折叠胶囊;
`curl http://127.0.0.1:<web 端口>/plugins/@deepseek-ai/dsh-anchor-seed/panel/client.js`
能取到客户端 bundle;第一次拨动开关或收起带修改的面板后,
`$DSH_HOME/storages/anchor-seed/settings.json` 落盘。

导出 session JSONL,检查首轮事件:

- 一个 `user/message`(source 为 `{ kind: 'user', form: 'anchor-seed' }`)、一个含
  `reasoning` 块与单个 `tool-call` 的 `assistant/message`、一个 `tool/call`、一个
  内容为 guide 文件的 `tool/result`;
- `tool/result` 带 `surfaceOp: append` 与 `sourceEventSeqs: [<tool/call seq>]`;
- `.dsh/agent-dev-guide.md` 真实存在且与虚拟结果正文一致;
- 首个 `request/header` 已包含完整工具目录。

零依赖测试:

```sh
npm test
```

## 重要行为

- **bundle 安装默认关闭。** 未开启前,新会话不注入、保持普通 system 提示词;面板开关
  (或已落盘的 `settings.json` / 组合行配置)打开后才注入。已带 durable 锚定的会话在
  中途关闭开关后仍保持 minimal 替换;半成品 seed 会被补全而不是丢下半个转录。自包含
  preset 因没有面板,写死 `enabled: true`。
- 种子在首个 `system-prompt/assemble` waterfall 内追加,早于 `buildRequest` 派生
  请求消息——首个真实请求必然包含虚拟轮。
- 仅顶层新鲜会话:子 agent(`delegationDepth > 0` 或 `origin: 'subagent'`)永不注入;
  已有真实 `user/message` 的会话永不重复注入。是否已锚定由 durable 日志判定,因此
  resume/reload 后 system 仍保持 minimal 替换;被中断的半成品 seed 会在下一次组装时
  补全,而不是重新注入。
- 虚拟 `tool/result` 是 `pwd && cat <guide>` 的原始 stdout(`<cwd>\n<内容>`,bash,
  不是 read 工具信封)。共享 guide 文件每次 fresh seed 覆盖;虚拟读取结果持久在会话
  日志里。
- 会话标题服务会先拿虚拟 user 消息起标题(内置 first-prompt provider 永远取第一条
  user 消息)。真实首条消息落盘且出现引用虚拟消息的 `session/title` 后,插件会纠正它:
  标题 provider 可达时按真实消息生成 provider 标题;否则(以及作为确定性兜底)追加
  一条由真实消息派生的修正 fallback。
- 所有失败路径都降级:自检失败、guide 写入失败、缺少模型路由、会话拒绝事件——只记
  一次告警,会话不带锚定继续运行;插件钩子绝不向 harness 抛错。
- 插件无外部网络请求、无遥测(面板只与本机宿主的 Typert Remote 桥通信)。
- 与 shell 同级信任:插件会向项目写入共享 guide 文件(`.dsh/agent-dev-guide.md`),
  并向 `$DSH_HOME/storages/anchor-seed/` 写入面板设置;请把 `.dsh/` 加入项目
  .gitignore。

## 已知限制

- 默认虚拟对话文本是**一轮真实采样的逐字原文**(`session-1018c36f`,minimal preset,
  由 `scripts/find-best-sampling-round.mjs` 按 modeltest 指纹选出)。属于 n=1 采样:
  若你有更合适的轮次,可用 `virtualUserTemplate`/`virtualReasoningTemplate` 替换。
- 虚拟工具结果是 `pwd && cat <guide>` 的虚构 stdout(`<cwd>\n<内容>`)。若覆盖
  `virtualCommandTemplate`,请保持结果格式与该命令真实输出一致。
- elevation 位于首个工具结果;长会话的压缩可能摘要或裁剪它(anchored-standard 的一次
  性晋升也有同样约束)。请求的工具 schemas 恒定,因此请求前缀缓存只在首请求前后变化
  一次。
- 需要在你自己的模型/环境上做 n=1 实测;已发布的 98/99 证据针对 DeepSeek V4 Pro 与
  单一冻结题面。

## 开发

`lib/runtime.js` 是纯逻辑(无 harness 依赖,完全可单测);`lib/index.js` 是 Cordis
宿主插件;`lib/guards.js` 是 fail-safe 环境自检(dsh-read-image 模式);
`lib/settings.js` 是面板设置的磁盘存储;`lib/health.js` 是参考仓库派生的思考链健康度
分类器;`lib/config-remote.js` 构造 `anchorSeedConfig` Typert Remote 桥。`panel/`
是面板伴随行(空宿主半边 + `panel/client.js` 浏览器 bundle)。`preset/lib/` 是构建
快照——改动 `lib/` 后运行 `scripts/build-preset.sh`。

浏览器 bundle 无法 import 宿主半边,因此 `panel/client.js` 内重复了默认文本(对应
`lib/settings.js`)与健康度分类器(对应 `lib/health.js`)——三处必须同步修改。

采样辅助:`scripts/find-best-sampling-round.mjs` 批量扫描
`$DSH_HOME/sessions/<cwd-slug>/`,按 modeltest minimal 指纹(逐字复用
`modeltest/evaluator/trigger_probe` 的 `classifyReasoning`)给每个会话打分排序,
输出最优一轮的首个 reasoning 块、用户消息与工具调用,可直接填入
`virtualUserTemplate`/`virtualReasoningTemplate`。需要 `unzstd` CLI。

## 许可证

MIT。`preset/agent.cordis.yml` 派生自 DeepSeek Harness Standard preset 与
`xiaobright/dsh-anchored-standard`,原始 DeepSeek 版权与 MIT 声明保留在
[`NOTICE`](../NOTICE)。
