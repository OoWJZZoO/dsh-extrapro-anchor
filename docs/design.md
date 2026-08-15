# 设计:虚拟对话锚定(virtual-read anchor)

## 目标

让 DeepSeek V4 Pro 这类对首轮结构高度敏感的模型,在**不依赖任何真实模型行为**的前提
下,于会话开始时进入 minimal 轨迹,同时拥有完整工具目录。这是 `anchored-standard` 的
通用化:它不再等待"第一个真实的 `tool/call`",而是把首轮锚定做成确定性的历史注入。

## 证据基础(modeltest,2026-08-14)

| 配置(V4 Pro 正式版,max) | Ability | 轨迹摘要 |
|---|---:|---|
| DSH standard / WSL | 91 | `let me=208`,55 次阶段回复 |
| DSH PTC / WSL | 92 | `run_code` 未形成批处理 |
| DSH minimal / WSL | 99, 96 | `let me=0`,`we=272/231`,仅 1 次可见回复 |
| DSH anchored-standard / win32 | **98, 99** | 首轮 `pwsh/read` 锚定,随后 25 工具;355 块仅 1 次 `let me` |

决定性微探针:turn1 两工具 → `We need`;turn2 恢复全部 25 工具 → 仍是 `Need/We` 风格并
合法调用工具。结论:**首轮结构决定轨迹,之后可以恢复完整工具而不丢轨迹**;影响来自实际
可调用的 schema surface,工具名作为文本不改变轨迹。

`anchored-standard` 用真实首轮实现这一点,代价是晋升依赖真实事件。本插件用**预先采样的
虚拟首轮**替换真实首轮,把"首轮结构"变成可控常量。

## 机制

### 注入时机

种子在第一个 `system-prompt/assemble` waterfall 内完成(该 waterfall 是
`systemPrompt.assemble()` 的一部分,在 `agent-loop` 的 `preStep` 中运行):

1. `next()` 解析后,waterfall 内可见**完整**的段列表(complete 段裁剪发生在 waterfall
   之后)——`elevationSource: auto` 借此捕获非 persona 提示词段;
2. 插件同步写盘 guide 文件、同步追加事件;此时事件已进入 session 日志;
3. 循环随后调用 `buildRequest`,其 `session.deriveMessages()` 已经包含虚拟轮。

顺序保证:虚拟轮(→ AGENTS.md/CLAUDE.md 注入)必然先于真实用户消息进入转录。

### 注入内容(事件序列,与 agent-loop 真实格式一致)

| 事件 | surface 元数据 | 数据要点 |
|---|---|---|
| `user/message` | `surfaceOp: append` | role user;请求读 guide;source 标记 plugin |
| `assistant/message` | `surfaceOp: append` | content = `reasoning` 块 + `tool-call` 块;`arguments` 为 `{file_path}` 的 JSON 字符串 |
| `tool/call` | 无(非 surface) | `{turn, step, callId, name, arguments}` |
| `tool/result` | `surfaceOp: append` + `sourceEventSeqs: [callSeq]` | `tool-result` 块,内容为 guide 全文,渲染与 `dsh-tool-fs` 的 `read` 输出逐字节一致 |
| `user/message`(可选) | `surfaceOp: append` | AGENTS.md/CLAUDE.md,`<system-reminder>` 框架,source `{kind: plugin}` |

刻意**不**追加 `turn/start`/`step/start`/`turn/end`:agent-loop 在构造时用
`turn/start` 推导真实轮号,合成边界事件会与真实轮号冲突;消息事件已足以构成转录。

### 一致性保证

guide 文件在事件注入**之前**真实写盘(`<cwd>/.dsh/<sessionId>/agent-dev-guide.md`),
内容 = elevation 句 + preset 真实提示词 + **全量工具目录文本**;虚拟 `tool/result` 用
`pwd && cat` 的真实 stdout 渲染(`<cwd>\n<内容>`,minimal 面只有 bash,没有 read
工具)。模型若之后真的去读该文件,得到与历史完全相同的文本——转录与磁盘互相印证,
不会困惑。

### 系统提示词替换(全局、幂等)

无论组合挂的是什么普通 preset,插件在每次 `system-prompt/assemble` 中把返回的
`sections` 替换为两段:minimal persona 一句 + 两工具声明(仅 bash、
str_replace_editor)。**工具 schemas 从不过滤**——`assembly.tools` 原样保留,首请求
即全量目录;完整工具清单以文本形式渲染进 guide(`buildToolCatalogText`),由虚拟轮的
result 揭示给模型。替换幂等且全局:每次 assemble 重放,持久化的 `request/header`
保持在 minimal system(请求缓存友好);elevation 捕获在替换**之前**完成(seed 先跑)。

### 幂等与范围

- `isFreshTopLevelAgent`:仅顶层(`delegationDepth === 0`)且尚无 `user/message` 的
  会话;种子事件本身是 `user/message`,因此重复组装、resume、reload 天然幂等;
- 进程内再加 `WeakSet<session>` 双保险;
- 子 agent 永不注入(用户决策:只顶层);非顶层、非 fresh 的组装不改动 system。

## 设计决策记录

1. **system 由插件自己替换为 minimal(用户决策,2026-08-15 修正)**:目的不是"要求
   preset 配 minimal",而是**在任意普通 preset 上注入 minimal 提示词 + 虚拟对话,再
   重注入真实普通 preset 提示词**,同时继承优质思维链与多工具能力。工具 schemas
   始终全量;首请求模型"以为"只有两工具(minimal system 声明),虚拟轮 result 揭示
   全量清单后自然调用。
2. **只顶层注入**(用户确认):spawn 子 agent 直接全量目录,不锚定。
3. **UI 如实呈现并标记**(用户确认):虚拟消息 source 均为 `{kind: 'plugin'}`,
   导出 JSONL 可审计。
4. **注入点选 `system-prompt/assemble` 而非 `agent/inbox/inserted`**:前者能自动捕获
   preset 真实提示词(elevation 内容),且注入顺序严格早于 `deriveMessages`;后者只能
   用配置文本;且 waterfall 的返回值权威,可同时改写 system 与保留 tools。
5. **去重 harness 自带的 `dsh-agent-instructions`(dsh-base 依赖)**:插件自己注入
    AGENTS.md/CLAUDE.md(顺序与用户描述一致);harness 内置的 agent-instructions
    会在 `agent/pre-step` 里把 AGENTS.md 再次插入到**真实用户消息之后**(2026-08-15
    dev 轨迹实测:虚拟轮 → AGENTS.md → 用户消息 → AGENTS.md 重复)。anchor-seed 以
    `prepend: true` 注册 `agent/pre-step`,`next()` 后丢弃
    `source.kind === 'agent-instructions'` 的消息,转录中恰好只有一条 instructions
    消息、位于虚拟轮与真实首条消息之间。要增量更新则 `injectProjectInstructions:
    false` 并挂回官方插件。
6. **虚拟轮消息用 `turn: 0, step: 0`(而非 1:1)**:轨迹 UI 的 assistant-step 生命周期
    以 `${turn}:${step}` 为 id;虚拟轮打 1:1 会让它的 `assistant/message` 以 "update"
    先于真实 `step/start` 到达,触发 "received an update before its start Match"
    硬断言、轨迹渲染异常(2026-08-15 实测)。turn 0 是 UI 的 prologue 桶,会合并显示
    在 turn 1 之前——正好是"虚拟前奏"的预期位置。
7. **fail-safe**:guard 自检(参照 dsh-read-image)、写盘失败、append 失败均降级为
    "一次告警 + 会话无锚定继续",绝不向 harness 抛错。

## 风险与待验证

- **合成首轮 vs 真实首轮的锚定强度**:证据支持"turn1 真实生成后再扩展目录",不支持
  "合成历史"直接等价;风格延续大概率成立,强度未知——上线前需导出 JSONL 验证首块
  reasoning 是否仍为 `We/Need` 风格、`let me` 是否保持低位。
- **默认虚拟文本是 n=1 真实采样**:默认值取自 modeltest 指纹最优轮
  (`session-1018c36f`,minimal),路径泛化为 `{path}` 占位;工具调用对齐 minimal 真实
  面(`bash` + `cat`,无 `read` 工具),工具结果为 `pwd && cat` 的真实 stdout 形态
  (`<cwd>\n<内容>`)。若换用其他采样轮,需保持同样的自洽约束。
- **压缩**:elevation 在首个工具结果中,长会话的 compaction 可能摘要/裁剪;工具目录
  恒定,请求前缀缓存只在首请求前后变化一次。
- **跨题泛化**:modeltest 作者明确 n=2 同题复现不构成跨任务证明;本插件的效果需在
  目标项目上独立验证。

## 参考资料

- `xiaobright/dsh-anchored-standard`(本仓库 `../dsh-anchored-standard/`,已 gitignore)
- `xiaobright/modeltest`(本仓库 `../modeltest/`,已 gitignore)— 触发机制实验、
  harness 对照、98/99 双跑评审
- DeepSeek Harness `47f9438`:`minimal-preset.snapshot.ts`("sends the exact RL
  prompt and schemas")、`dsh-agent-loop`(事件追加)、`dsh-session/surface`
  (surface 契约)、`dsh-tool-fs`(read 输出格式)、`dsh-agent-instructions`
  (instructions 注入格式)
