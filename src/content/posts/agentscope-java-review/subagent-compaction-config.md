---
pubDatetime: 2026-09-23T10:00:00+08:00
modDatetime: 2026-09-30T12:00:00+08:00
title: "as-java-review: 声明式 Subagent 的独立 Compaction 配置"
description: "复盘 AgentScope Java PR #2378：声明式 Subagent 为何只能用默认 compaction，以及 Java Builder 与 YAML 三态语义如何补齐 override / inherit / disable。"
author: "Xiaoyu"
featured: false
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

> 本文记录 2026-08-25 的 Approve 与后续补丁；实现和状态于 2026-09-30 核对。PR 状态和实现可能继续变化，请以 GitHub 上的最新内容为准。<br>
> **PR**：[agentscope-ai/agentscope-java#2378](https://github.com/agentscope-ai/agentscope-java/pull/2378)（截至本文仍为 **Open**）<br>
> **Issue**：[Fixes #2325](https://github.com/agentscope-ai/agentscope-java/issues/2325)<br>
> **作者**：March-77<br>
> **Review**：[Approve（2026-08-25）](https://github.com/agentscope-ai/agentscope-java/pull/2378#pullrequestreview-5015901056) + [行为验证评论](https://github.com/agentscope-ai/agentscope-java/pull/2378#issuecomment-5406073570)（后续 [jujn Changes Requested](https://github.com/agentscope-ai/agentscope-java/pull/2378#pullrequestreview-5026818959)；YAML 解析已补，状态仍 Open）

## 问题：声明式 Subagent 无法配置 Compaction

Harness 允许父 Agent 配置会话压缩：

```java
HarnessAgent.builder()
    .compaction(
        CompactionConfig.builder()
            .triggerMessages(40)
            .keepMessages(12)
            .build())
    .build();
```

内置 `general-purpose` Subagent 工厂早就把父配置复制进子 Agent。声明式路径却没有：

- Java `SubagentDeclaration` 没有 compaction 相关 setter
- Markdown / YAML 声明的 front matter 也不读 `compaction`
- `buildDeclaredFactory(...)` 构建子 Agent 时不会传播父配置，也不会接受声明级覆盖

结果是：父 Agent 可以精细控制压缩阈值，声明式 Subagent 只能落到框架默认行为。任务越长、上下文越大，子 Agent 越容易提前触达默认阈值，或者反过来在本应禁用压缩的路径上继续压缩。

Issue #2325 要的不是“让声明式也无条件继承父配置”，而是 **per-subagent 可配置**：有的子 Agent 覆盖父策略，有的继承禁用，有的继承自定义 `CompactionConfig`。

这和 [声明式 Subagent 继承父 Agent Hooks](/posts/agentscope-java-review/declared-subagent-hook-inheritance/) 是同一类缺口：框架自动构建的 declared subagent，漏掉了父侧已经存在的一项配置能力。

## 时间线：Approve 之后又被挡住

这个 PR 的状态比代码本身更值得先说清。

| 时间点 | 事件 | 状态含义 |
| ------ | ---- | -------- |
| 2026-07-24 | PR 打开；早期 bot / maintainer 有过正面反馈 | Open |
| 2026-08-25 | 我提交 Approve，并本地验证了三类继承/覆盖行为 | Approve 已给 |
| 2026-08-26 | maintainer `jujn` Changes Requested | 合并被挡住 |
| 随后 | 作者补 YAML front matter 解析、`disableCompaction`、文档与测试 | 缺口在补 |
| 2026-09-23 ~ 2026-09-24（北京时间） | bot 复审 YAML 补丁与值域缺口 | COMMENT，未解除 jujn 的 Changes Requested |
| 2026-09-30 | 本文核对状态 | **仍为 Open** |

我 Approve 时验证过的行为（`HarnessAgentTest` / `SubagentDeclarationPhaseATest`）：

1. 父禁用 compaction，声明级提供自定义配置 → 子 Agent 使用声明覆盖
2. 声明未写 compaction，父禁用 → 子 Agent 继承禁用
3. 声明未写 compaction，父有自定义 `CompactionConfig` → 子 Agent 继承该配置

`jujn` 的 Changes Requested 并不是推翻这三类行为，而是指出当时修复面不完整：

1. **代码声明式**（Java Builder）已覆盖；**文件声明式**（`AgentSpecLoader` 解析 `subagents/*.md`）完全没读 `compaction`
2. 声明式无法稳定表达“单独禁用压缩”——只有覆盖配置不够，还要能显式 disable

后续提交补了 YAML 三态语义和 `SubagentDeclaration.disableCompaction()`。但从 GitHub 状态看，blocking review 仍未解除，PR **仍为 Open**。本文按这个事实写，不把它写成已合并。

## 先分清两条工厂路径

和 Hook 继承问题一样，先不要把范围说成“Markdown 不能配 compaction”。

| 创建方式 | 修改前 | PR #2378 目标 |
| ------ | ------ | ------------- |
| 内置 `general-purpose` | 已无条件继承父 compaction | 保持不变 |
| Java `SubagentDeclaration` | 无声明级配置，也不继承 | 可覆盖 / 可禁用 / 可继承 |
| 静态或动态 Markdown 声明 | 无 front matter 字段 | 三态 `compaction:` |
| 远程 Subagent | 不走本地子 Agent 构建 | 字段可被解析，但不消费 |
| 自定义 `SubagentFactory` | 由 factory 决定 | 不在本次范围 |

真正的修复边界仍是 `buildDeclaredFactory(...)`：框架自动构建本地 declared subagent 的那条路径。

## 第一阶段：Java Builder 声明级配置

最早合入方向是给 `SubagentDeclaration.Builder` 增加 compaction 入口，并在工厂里让声明级优先于父继承：

```java
SubagentDeclaration.builder()
    .name("researcher")
    .description("Long-running research worker")
    .compaction(
        CompactionConfig.builder()
            .triggerMessages(60)
            .keepMessages(20)
            .build())
    .build();
```

工厂侧的优先级可以概括成：

```text
decl 显式配置
  → 否则 decl 显式禁用
  → 否则父禁用
  → 否则父 CompactionConfig
  → 否则框架默认
```

后补的 `disableCompaction()` 让“单独禁用”也能用 Java API 表达。Builder 上的 compaction setter 与 disable setter 互相清空对方状态，避免链式调用顺序产生矛盾配置。

这一阶段已经能解释我 Approve 时验证的三类行为。但 Markdown 用户仍写不出同样的契约，这也是 `jujn` 卡住合并的核心原因。

## 第二阶段：YAML front matter 的三态语义

后续补丁把文件声明拉到同一套模型：`AgentSpecLoader.applyCompaction(...)` 解析 front matter 中的 `compaction`。

三态约定很干净：

| front matter | 含义 |
| ------------ | ---- |
| 字段缺席 | 继承父 Agent（含父禁用） |
| `compaction: false` | 本声明禁用 |
| `compaction: true` | 使用默认 compaction 配置覆盖继承 |
| `compaction:` + mapping | 用显式字段覆盖继承 |

mapping 支持的键大致包括：

```yaml
---
name: researcher
description: Long-running research worker
compaction:
  triggerMessages: 60
  triggerTokens: 120000
  keepMessages: 20
  keepTokens: 40000
  keepTokensMin: 8000
  keepTokensMax: 60000
  keepTokensRatio: 0.3
  reserved: 2000
  summaryPrompt: "Summarize the following conversation:\n{messages}"
  flushBeforeCompact: true
  offloadBeforeCompact: false
---
```

内部 `applyCompaction` 对未知键和类型错误抛 `IllegalArgumentException`，并带上 offending key；外层 `AgentSpecLoader.parse` 捕获它、记录 warning，忽略非法 compaction，保留声明并继承父配置。整数校验用 `doubleValue() == intValue()`，避免把 `3000000000` 这种超范围值静默截断成 `int`。

文档同步更新了 EN / ZH 的 harness subagent 说明，front matter 模板也写进了 loader / 类注释。到这一步，Java 声明和文件声明终于共用同一套语义。

## 工厂如何落地：声明优先，父配置兜底

本地 declared factory 的关键顺序可以读成：

```java
if (decl.isCompactionDisabled()) {
    sub.disableCompaction();
} else if (decl.getCompactionConfig() != null) {
    sub.compaction(decl.getCompactionConfig());
} else if (parentDisabled) {
    sub.disableCompaction();
} else if (parentConfig != null) {
    sub.compaction(parentConfig);
}
```

要点有三：

1. **声明级优先**。Issue 要的是 per-subagent 策略，不是强制统一继承。
2. **缺席才继承**。YAML 三态里的 absent，对应 Java 侧“既没 compaction 也没 disable”。
3. **`general-purpose` 仍无条件继承**。它不走 declaration override 通道，和“只有 declared subagent 可覆盖”的范围一致。

如果文档把标题写成很宽的 “per-subagent compaction config”，读者可能以为 ad-hoc general-purpose 也能单独配。实现并没有这么做；范围注释值得写一行。

## Review 时继续盯的四个边界

### 1. 无效 compaction 会不会拖垮整个 declaration 仓库

`AgentSpecLoader` 一次可能加载整个 `subagents/` 目录。早期 review 指出非法 compaction 可能导致整份声明被丢弃；当前补丁已在 `parse` 中捕获 `IllegalArgumentException`，记录 warning，仅忽略 compaction，保留其余声明并回退父配置。

`loader_ignoresMalformedCompactionWithoutDroppingAgent` 已覆盖未知键、类型错误和超范围整数。这项加载边界已有实现与回归；剩下要补的是值域校验。

### 2. Remote subagent 字段被静默忽略

远程声明（`url != null`）最终创建的是 `RemoteSubagentStub`，不会在本地装 compaction middleware。Loader 若仍接受 `compaction:`，用户会以为远程子任务也生效。

这不是功能回归，但是契约噪声。更干净的做法是：远程声明拒绝该字段，或在文档里明确“仅本地 declared subagent 生效”。当前实现偏“解析后不消费”，Review 应标成 info，而不是当成已支持。

### 3. `general-purpose` 仍无条件继承

这与 Hook 继承故事对称：内置路径早就复制父配置；这次只补声明式缺口。不要在 Review 里要求它突然支持独立 override，除非 Issue 明确要求。需要防的是文档口径比实现更宽。

### 4. 值域校验不足：负 `keepMessages`、缺 `{messages}` 的 `summaryPrompt`

类型校验通过，不等于配置可运行。

- `keepMessages < 0`：后续 `ConversationCompactor` 走 `subList` 时可能直接 `IndexOutOfBoundsException`
- `summaryPrompt` 缺少 `{messages}`：摘要调用可能丢对话内容，而不是显式失败

这两类值把配置错误推迟到压缩触发时。在 `applyCompaction` 阶段拒绝它们，才能让现有“无效 override → warning + 继承”的兜底真正起作用。

## 测试覆盖了什么

我 Approve 时关注的是工厂优先级，而不是 YAML 词法细节。相关测试大致落在：

- `SubagentDeclarationPhaseATest`：声明对象、loader 解析、disable / override 互斥
- `HarnessAgentTest`：declared factory 相对父配置的三类继承/覆盖

作者报告过定向命令：

```bash
mvn -pl agentscope-harness -am \
  -Dtest="HarnessAgentTest,SubagentDeclarationPhaseATest" \
  -Dsurefire.failIfNoSpecifiedTests=false test
```

YAML 补丁之后，还应额外盯：

- `compaction: false` / `true` / mapping / absent
- 未知键、非整数、超范围整数
- 负 `keepMessages`、缺占位符的 `summaryPrompt`
- remote 声明携带 `compaction` 时的行为
- 非法 compaction 是否影响同目录其他声明加载

本文没有把作者本机结果表述为我的全量复测；我验证过的是 Approve 当日那三类 override / inherit 行为。

## 和 Hook 继承复盘的对照

| 维度 | Hook 继承（#2996） | Compaction 配置（#2378） |
| ---- | ----------------- | ------------------------ |
| 缺口位置 | declared factory 漏传父 Hook | declared factory 漏传/漏覆盖 compaction |
| 默认策略 | 自动继承全部显式父 Hook | 缺席继承；声明可覆盖或禁用 |
| 额外风险 | Hook 工具绕过白名单 | 非法配置延后炸、remote 静默忽略 |
| 文档重点 | parent-only Hook 如何跳过子事件 | 三态语义与 general-purpose 范围 |

两边都提醒同一件事：看到“父配置复制给子 Agent”时，先问创建路径有几条，再问声明级是否需要比继承更强的控制。

## 合并前还建议钉住的最小补测

如果 maintainer 重新审查，我希望至少再看到这几条断言，而不是只重复工厂优先级：

```text
通过 AgentSpecLoader.parse(markdown, name, mainWorkspace) 验证：
1. 未知键 {trigger: 5}：声明保留，compaction override 被忽略（已有回归）
2. keepMessages: -1：补值域校验后，同样记录 warning 并继承父配置
3. summaryPrompt 缺 {messages}：补校验后，同样记录 warning 并继承父配置
```

未知键的回退已有回归；另外两类值域补测应沿用“声明保留、非法 override 忽略”的契约，避免把错误推迟到压缩运行时。

## Review 结论

PR #2378 修的是真实缺口：声明式 Subagent 不能表达独立 compaction 策略，而 `general-purpose` 路径早已继承父配置。Java Builder 阶段的 override / inherit disable / inherit custom 行为站得住，我也据此给过 Approve。

但时间线必须写完整：

1. 用户 Approve 验证了声明级优先与继承语义。
2. maintainer `jujn` 以“YAML 未解析 + 无法单独禁用”提出 Changes Requested。
3. 后续补丁补上了 `compaction: false|true|mapping` 与 `disableCompaction()`，三态语义清楚。
4. 截至 2026-09-30，GitHub 状态仍为 **Open**，不能写成已合并。

剩余最值得继续盯的，不是“能不能配”，而是“配错了会怎样”：无效块的加载失败面、remote 字段的静默忽略、以及负 `keepMessages` / 缺 `{messages}` 这类把错误推迟到运行时的值域漏洞。
