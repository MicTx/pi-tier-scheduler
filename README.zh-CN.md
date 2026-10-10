# pi-tier-scheduler

[![npm](https://img.shields.io/npm/v/pi-tier-scheduler)](https://www.npmjs.com/package/pi-tier-scheduler)
[![License: PolyForm-NC-1.0.0](https://img.shields.io/badge/License-PolyForm--NC--1.0.0-blue.svg)](LICENSE)
[![Pi](https://img.shields.io/badge/Pi-1.0.4%2B-5f5fff.svg)](#环境要求)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](#环境要求)

为 Pi 编码代理做分层模型调度——一个虚拟模型,把每个请求路由到 brain/pillar/crowd 三层之一。

[English](README.md) | **简体中文**

只选一个虚拟模型 `ts/auto`,调度器就把每个请求送到适合这项工作的实体模型:强模型负责规划与推理,均衡模型负责实现与调试,高效模型处理轻量任务。路由确定、可解释;手动接管永远只需一条命令;所有回退都有上界。

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [快速上手](#快速上手)
- [配置](#配置)
- [分层与路由](#分层与路由)
- [命令](#命令)
- [凭据](#凭据)
- [故障排查](#故障排查)
- [开发](#开发)
- [贡献](#贡献)
- [许可证](#许可证)
- [更新日志](#更新日志)

## 环境要求

- Pi **1.0.4 或更新**。这是经过验证的兼容地板:本包基于 Pi 1.0.4 扩展 API 构建并测试,`/ts doctor` 会报告它验证过的地板版本。
- Node **20 或更新**只在从检出目录跑开发检查时才需要;在 Pi 里安装并使用本包,不需要单独配置 Node。

## 安装

### 从 npm(推荐)

本包以 `pi-tier-scheduler` 发布在 npm:

```sh
$ pi install npm:pi-tier-scheduler
```

一条命令包含全部：从 npm registry 解析包、装进 Pi 的包目录、对每个新 Pi 会话注册——`pi list` 可见，`pi remove npm:pi-tier-scheduler` 卸载。npm 包页 [npmjs.com/package/pi-tier-scheduler](https://www.npmjs.com/package/pi-tier-scheduler) 镜像本 README 与版本历史。（裸 `npm install pi-tier-scheduler` 只是把文件放进项目的 `node_modules`——Pi 只加载它自己安装过的包。）

### 从 GitHub

```sh
$ pi install git:github.com/MicTx/pi-tier-scheduler@v0.4.0
```

`git:` 形式对任何可克隆的 git 远端都成立——公司 Gitea、自建服务或 fork 都行。用 `@<tag>` 钉版：后续更新只核对检出内容，不会移动钉死的 ref。认证走你 git 克隆该主机时本来就用的那套凭据；本包自身不保存任何密钥。`pi remove` 接同一个源。

### 从本地检出安装

本包也可以从本地克隆安装:

```sh
$ pi install ./
```

本地包从解析出的磁盘路径加载——不复制、不发布。装好后 `pi list` 会显示 `pi-tier-scheduler`,`pi config` 可以开关它的资源。在包根目录用同样的源路径卸载:

```sh
$ pi remove ./
```

只想在单个会话里试用、不安装:

```sh
$ pi -e ./
```

`pi install ./` 让本包对机器上每个新 Pi 会话可用;`pi -e ./` 只在那一次调用里加载。两条命令都不需要凭据:本包不保存密钥、不读取任何密钥材料(见[凭据](#凭据))。

## 快速上手

从安装到第一个被路由的请求,三步:

1. 在你的项目里启动 Pi,运行 `/ts init`——引导向导(TUI)会读取 Pi 已知的模型清单,逐层点选,零手输。没有向导可用?直接抄[配置](#配置)里的完整示例。
2. 把 `ts/auto` 选为会话模型——`/model`、`--model`、或设置项,它看起来和别的模型一样。
3. 随便问点什么。`/ts status` 随后显示哪个实体模型应答、为什么是它。

```sh
$ /ts init
$ /ts status
$ /ts use brain
$ /ts auto
```

后两条是手动逃生口:`/ts use brain` 把规划类工作钉在你最强的层,`/ts auto` 交还自动路由。

## 配置

配置是两份可选的 JSON 文件,都按包名命名:

- **用户级**:`<agent-dir>/tier-scheduler.json`——默认 `~/.pi/agent/tier-scheduler.json`。agent 目录跟随 Pi 的 `PI_CODING_AGENT_DIR` 覆盖。
- **项目级**:会话工作目录下的 `.pi/tier-scheduler.json`。不向上搜索父目录。

多层深合并,优先级为**内置默认 < 用户 < 项目**。每一层都是部分的:文件只写自己在意的键即可,最小合法文件就是 `{ "schemaVersion": 1 }`。完整示例:

```json
{
  "schemaVersion": 1,
  "tiers": {
    "brain": { "candidates": [{ "provider": "your-provider", "id": "strong-model" }] },
    "pillar": { "candidates": [{ "provider": "your-provider", "id": "balanced-model" }] },
    "crowd": { "candidates": [{ "provider": "your-provider", "id": "fast-model" }] }
  },
  "policy": {
    "defaultBias": "medium",
    "sticky": true
  },
  "retry": {
    "maxAttemptsPerRequest": 3,
    "maxTierSwitches": 2
  }
}
```

- `tiers.<tier>.candidates` 是有序的 `{ "provider", "id" }` 列表。这份列表就是你的模型清单:**上面的示例 ID 只是示意,由用户自填——内置候选数组为空**,在你配置至少一个候选之前,路由无模型可派。
- `policy.defaultBias`(`minimal` | `low` | `medium` | `high` | `xhigh` | `max`,默认 `medium`)是会话没有手动选择时施加的思考强度偏置。
- `policy.sticky`(默认 `true`)让续接请求尽量留在上一个实体模型上(只要它仍合格),保住提示缓存。
- `retry.maxAttemptsPerRequest`(默认 `3`)与 `retry.maxTierSwitches`(默认 `2`)约束恢复游走。这是只能收窄、不能放宽的天花板:代码强制硬上限——每请求 5 次尝试、每路由 3 次换层。

校验不过的层会被报告并跳过——其余层照常生效。无法解析的 JSON 会被隔离成 `.corrupt-*` 副本供你修复;任何内容都不会被静默覆盖。

## 分层与路由

三层,各说明一个模型是干什么的:

| 层 | 偏置 | 适合的工作 |
| --- | --- | --- |
| `brain` | high | 规划、架构、硬推理、横切分析 |
| `pillar` | medium | 实现、调试、重构——干活的主力默认层 |
| `crowd` | low | 会话闲聊、轻量或重复执行 |

把 `ts/auto` 选为会话模型（`/model`、`--model`、或设置项——它看起来和别的模型一样）。每个请求之前,路由器按以下顺序确定性决策:

1. **手动覆盖**——`/ts use <tier>` 永远压过自动路由。
2. **工作阶段**——对会话分类:规划 → `brain`,实现/验证 → `pillar`,闲聊 → `crowd`,无法分类 → `pillar`。
3. **复杂度**——高复杂度升一层,低复杂度降一层。
4. **思考偏置**——选中的虚拟思考等级(或 `policy.defaultBias`)朝同一方向轻推。完整 Pi 档位全部开放:`minimal`/`low` 倾向 `crowd`,`medium` 不动,`high`/`xhigh`/`max` 倾向 `brain`——更深的档位会传给路由到的模型,并按其能力钳制。
5. **候选选择**——该层配置顺序里第一个合格的候选胜出。合格性过滤已配置且已授权的 provider 和任务约束(图像输入、推理要求);请求的思考强度会被钳到实体模型支持的范围内。

每个决策都产出机器可读的理由(`work_phase`、`complexity_adjustment`、`thinking_bias`、`manual_override`、`manual_override_fallback`、`automatic_fallback`、`direct`);`/ts status` 显示最近一条。

回退天生有界。一次尝试失败后,失败被分类,下一个备选先从同层挑,再按配置的回退顺序走——绝不无限循环,始终在尝试与换层上限之内。粘性续接时,上一个实体模型只要仍合格就会被保留。`ts/auto` 永远派发**实体**模型,绝不派发另一个虚拟模型。基于分类器的路由精化是后续计划,不在本发布内;上面的确定性规则就是交付契约。

## 命令

一个命令族,注册为 `/ts`:

| 命令 | 可用模式 | 行为 |
| --- | --- | --- |
| `/ts` 或 `/ts status` | 全部 | 当前选择、最近派发的实体模型、生效中的覆盖、最近路由理由、生效配置摘要(含逐层候选表)|
| `/ts use <tier>` | 全部 | 手动覆盖到 `brain`、`pillar` 或 `crowd`;选中 `ts/auto` 并设置对应偏置 |
| `/ts brain` · `/ts pillar` · `/ts crowd` | 全部 | `/ts use <tier>` 的短别名 |
| `/ts auto` | 全部 | 解除手动覆盖,回到自动路由 |
| `/ts init` | TUI | 引导式首次配置——从已装模型中点选候选 |
| `/ts config` | 全部 / TUI | 任何模式都能看生效合并配置;**编辑仅限 TUI** |
| `/ts doctor` | 全部 | 配置合法性、模型可用性、凭据在场情况、路由器状态健康度、兼容地板——对齐的检查表输出 |

模式行为:`/ts init` 与 `/ts config` 的编辑半边要打开交互式 Pi 对话框,因此仅限 TUI;在 RPC、JSON、print 模式下它们回复一条纯文本提示,不做任何变更。status、覆盖、解除、doctor 在所有模式下行为一致,纯文本输出。

## 凭据

Pi 通过自己的机制解析 provider 凭据(它的认证存储和各 provider 的环境约定)。本包**绝不保存、写入、代理或记录凭据**——它只问 Pi 某 provider 是否已配置。你平时怎么给 Pi 配密钥就怎么配;调度器不需要任何额外的东西。

## 故障排查

- **doctor 报告凭据缺失**——某个已配置候选的 provider 在 Pi 里没有密钥。按 Pi 的方式补上凭据即可;调度器没有独立的密钥库。doctor 永远不打印凭据值。
- **`no_eligible_physical_model` 或状态里某层为空**——该层候选缺失、写错名字,或当前全都不可用(provider 未授权、模型不在目录里)。对照 Pi 列出的模型检查 `provider`/`id` 拼写,并用 `/ts doctor` 查看逐 provider 的授权状态。
- **加载时报配置问题**——校验不过的层被跳过,并给出指向问题键的 JSON 路径错误;其余层照常生效。修报告的键;只有文件损坏(而非校验不过)才会产生 `.corrupt-*` 隔离副本。
- **JSON 损坏**——配置文件无法解析时,原始字节保留为旁边的 `.corrupt-*` 副本,该文件视为不存在。修复或删除副本;调度器绝不静默丢弃它。
- **路由上上下文溢出**——失败分类器会标记它,重试游走在层内优先挑容量更大的兼容候选;上限耗尽时请求以有界错误结束,而不是循环。
- **撞到重试上限(`route_limit_exceeded`)**——有界游走在 `maxAttemptsPerRequest` 次尝试或 `maxTierSwitches` 次换层后停下。减少重复候选、给该层加一个健康候选、或在配置里收窄重试值,都会改变游走;想放宽到硬上限(5 / 3)以上是不可能的。
- **命令有响应,对话框不出现**——你在 RPC、JSON 或 print 模式。`/ts init` 与 `/ts config` 编辑按设计仅限 TUI;其余子命令在所有模式可用。
- **Pi 升级后扩展加载失败**——兼容地板是 Pi 1.0.4。运行 `/ts doctor`(它的版本检查会报告地板);在新版宿主上出现漂移时,使用前需要重新验证——本发布验证过的地板见更新日志。

## 开发

从检出目录:

```sh
$ npm install
$ npm run typecheck
$ npm test
$ npm run test:release
$ npm run test:coverage
```

在检出的包根目录运行。

`test:release` 先类型检查、再跑全量套件——发布门禁。测试套件确定且密闭:伪造的模型注册表与内存 provider、失败注入语料、配置/路由/命令/模式矩阵。验证**不发起真实网络调用、不使用真实凭据**。

## 贡献

欢迎到 [MicTx/pi-tier-scheduler](https://github.com/MicTx/pi-tier-scheduler) 提 issue 与 PR。提交 PR 即表示你同意贡献按本仓库的 [PolyForm Noncommercial 1.0.0](LICENSE) 条款授权。

## 许可证

以 [PolyForm Noncommercial License 1.0.0](LICENSE) 发布。个人、研究、教育及其他非商业用途免费;**商业使用需另行取得书面授权**。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md):发布历史与每个版本的兼容地板。
