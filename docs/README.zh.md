# dsh-extrapro-anchor

[English](../README.md)

> 确定性轨迹锚定:在首个模型请求之前,每个新的顶层会话都会被注入一轮预先采样的
> minimal 风格虚拟读文件回合,其工具结果把会话“提升”到当前 preset 的真实提示词——
> 不需要任何真实工具调用,适用于任意 preset、任意项目。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件,
把 [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
的思路通用化:不再等模型先真实调用工具再晋升目录,而是在首个请求之前确定性地注入锚点。

这是社区项目,并非 DeepSeek 官方 preset,也不代表 DeepSeek 的认可或背书。

## 它做什么

- 每个新的顶层会话都会先被注入一轮虚拟回合:用户消息要求读取
  `.dsh/agent-dev-guide.md`,assistant 以 minimal 风格回复并调用一次 `bash`,
  工具结果里展开当前 preset 的真实提示词。
- 已锚定会话的 system 提示词会被替换为 minimal persona + 两工具声明;工具 schema
  从不过滤,完整工具目录始终可用。
- 子 agent 永不注入,同一会话绝不重复注入。

## 安装

需要 DeepSeek Harness(`dsh`)`0.1.0-rc.6` 或更高版本。

```sh
dsh plugin --profile <profile> add github:OoWJZZoO/dsh-extrapro-anchor
```

然后重启 `dsh web`(或让 profile patch 热加载器热加插件行)并刷新页面。本包自带
`cordis.patch.yml`,插件行会自动合成。

手工安装:添加依赖、插入两行、重启。

```json
// ~/.dsh/profiles/<profile>/package.json → dependencies
"@deepseek-ai/dsh-extrapro-anchor": "github:OoWJZZoO/dsh-extrapro-anchor#v0.2.0"
```

```sh
cd ~/.dsh/profiles/<profile> && pnpm install
```

```yaml
- id: extrapro-anchor
  name: '@deepseek-ai/dsh-extrapro-anchor'
  config: {}
- id: extrapro-anchor-panel
  name: '@deepseek-ai/dsh-extrapro-anchor/panel'
  config: {}
```

> 两种方式不要混用:`dsh plugin add` 已经合成两行。

## 悬浮面板

安装完成后,网页右侧会出现一个折叠的胶囊面板。面板是插件的主要使用入口;注入默认
**关闭**,打开开关后才会生效。

- **折叠时**只显示两样:注入开关和思考链健康度。
  - 开关**开** → 新的顶层会话会被锚定注入;开关**关** → 新会话按普通方式运行。
    已经锚定的会话继续保留 minimal system 替换。
  - 健康度圆点反映实时模型思考链:绿色 = 稳定的 minimal 风格链,黄色/红色 =
    检测到 `let me` 漂移。
- **展开后**可以编辑四项注入文本(引导说明、虚拟提问、虚拟思考、注入命令)。缺少
  `{path}` 的模板会标红且不会被保存;一键“恢复默认”可回到内置文本。
- 文本修改先缓存在浏览器,面板收起或下一次注入发生时落盘生效;开关即时保存。
- 面板位置按浏览器记忆(`localStorage`)。

设置持久化在 `$DSH_HOME/storages/extrapro-anchor/settings.json`。宿主插件在每次
fresh seed 前都会重新读取,因此面板就是启用和微调锚定注入的唯一开关。

## 配置

组合行 `config` 可选的覆盖项:

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 无面板设置文件时的注入开关兜底;面板落盘值在 seed 时覆盖此值。 |
| `elevationSource` | `auto` | `auto`:自动捕获 preset 的非 persona 提示词段;`config`:只使用 `elevationPrompt`;`none`:只保留引导句。 |
| `elevationPrompt` | `''` | `elevationSource: config` 时使用的显式提示词。 |
| `elevationNotice` | 内置句子 | guide 文件开头的固定引导句。 |
| `virtualUserTemplate` / `virtualReasoningTemplate` / `virtualCommandTemplate` | 预采样默认 | 虚拟轮三段文本;`{path}` 会替换为 `.dsh/agent-dev-guide.md`。 |
| `dynamicSections` | `['plan:policy']` | minimal 替换后保留的动态 system 段白名单。 |
| `guard.enabled` | `true` | 环境自检开关;`false` 跳过自检强行加载。 |

## 安全

启动时插件会对所有触及的 harness 契约做环境自检。任一检查失败时插件**安全失败**:
不加载任何东西、harness 照常启动。完整诊断写入
`~/.dsh/logs/dsh-extrapro-anchor-guard.log`,前台只打一条双语提示。面板在浏览器端
执行同样的客户端自检,缺失服务时只记日志、不安装任何东西。

## 验证加载

安装后刷新页面,打开面板开关。新建会话并导出 JSONL:首轮应依次包含
`source = { kind: 'user', form: 'extrapro-anchor' }` 的 `user/message`、
一个 `assistant/message`、一个 `tool/call`、一个 `tool/result`,然后是你的真实消息
和 harness 注入的 AGENTS.md。共享 guide 文件 `.dsh/agent-dev-guide.md` 的内容与
虚拟工具结果一致。

运行零依赖测试:

```sh
npm test
```

## 已知限制

- 默认虚拟对话来自一轮预采样(n=1);可通过面板或组合行配置替换。
- 长会话的压缩可能摘要或裁剪首个工具结果中的 elevation。
- 请在自己的模型/环境上验证轨迹指纹后再依赖它。

## 开发

`lib/` 是无 harness 依赖的纯逻辑(已单测);`panel/` 是面板伴随客户端行。完整检查:

```sh
npm run check
```

## 引用与致谢

- [`xiaobright/dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) —
  本插件所推广的原“两工具 → 全量目录”锚定机制。
- [`xiaobright/modeltest`](https://github.com/xiaobright/modeltest) —
  trigger-probe 实验与 `We need` / `Let me` 指纹分类器。
- [`OoWJZZoO/dsh-read-image`](https://github.com/OoWJZZoO/dsh-read-image) —
  fail-safe 环境自检模式与 Typert Remote 面板桥模式。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
  本插件所叠加的宿主平台。

## 许可证

MIT
