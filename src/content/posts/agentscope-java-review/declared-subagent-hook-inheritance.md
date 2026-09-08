---
pubDatetime: 2026-09-08T08:00:00+08:00
title: "声明式 Subagent 的 Hook 继承：一次 AgentScope Java PR Review"
description: "复盘 AgentScope Java PR #2996：声明式 Subagent 为什么会绕过父 Agent Hook，以及继承 Hook 后如何继续守住工具白名单。"
author: "xiaoyuuuuuupeng"
featured: false
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

> 本文记录的是 2026-09-08 审查时的代码与结论。PR 状态和实现可能继续变化，请以 GitHub 上的最新内容为准。<br>
> **PR**：[agentscope-ai/agentscope-java#2996](https://github.com/agentscope-ai/agentscope-java/pull/2996)<br>
> **Issue**：[#1578 声明的子 Agent 不会继承父 Agent hooks](https://github.com/agentscope-ai/agentscope-java/issues/1578)<br>
> **审查提交**：`af344c15babef34159ca1d8398c5bf09dcdfec23`<br>
> **Review**：[Approve + LGTM](https://github.com/agentscope-ai/agentscope-java/pull/2996#pullrequestreview-5136467848)

## 问题：父 Agent 的治理能力没有进入声明式 Subagent

Harness 允许在父 Agent 上注册 Hook：

```java
HarnessAgent.builder()
    .hook(new ToolGovernanceHook())
    .toolkit(toolkit)
    .workspace(workspace)
    .build();
```

Hook 可以监听 Agent 和工具事件，也可以在工具调用前修改参数。实际项目会用它实现：

- 工具权限治理
- HITL 人工确认
- 审计日志
- 调用预算
- 参数校验或改写

父 Agent 如果把任务委派给 Subagent，治理规则通常也应该继续生效。否则父 Agent 本身受控，声明式 Subagent 却能直接执行工具，委派路径就形成了治理缺口。

Issue #1578 给出的例子是：父 Agent 配置了工具确认 Hook，声明式 Subagent 只允许调用 `query_logs`。预期 `query_logs` 仍会触发父 Hook，修改前却不会。

## 先分清四种 Subagent 创建方式

这次问题很容易被概括成“Markdown Subagent 不继承 Hook”，但范围比 Markdown 更大。

| 创建方式                   | 修改前              | PR #2996 |
| -------------------------- | ------------------- | -------- |
| 内置 `general-purpose`     | 已继承父 Hook       | 保持不变 |
| Java `SubagentDeclaration` | 未继承              | 修复     |
| 静态或动态 Markdown 声明   | 未继承              | 修复     |
| 自定义 `SubagentFactory`   | 由 factory 自己决定 | 保持不变 |

Java 声明和 Markdown 声明最终都进入 `buildDeclaredFactory(...)`。因此真正的边界是“框架自动构建的 declared subagent”，不是“代码创建”与“Markdown 创建”。

远程 Subagent 只创建 `RemoteSubagentStub`，不走本地子 Agent 的 Hook 安装；自定义 factory 仍由使用者决定如何构建，也不在这次修改范围内。

## 根因：两条工厂路径少传了一份配置

内置 `general-purpose` 工厂原来已经做了两件事：

```java
final List<Hook> capturedHooks = List.copyOf(b.hooks);

// 构建子 Agent 时
sub.hooks(capturedHooks);
return sub.build();
```

其中：

- `b` 是父 `HarnessAgent.Builder`
- `capturedHooks` 是父构建器上显式配置的 Hook 快照
- `sub` 是正在创建的子 Agent 构建器

声明式 Subagent 的工厂复制了父 Agent 的 model、toolkit、memory、middleware、执行超时等配置，却漏掉了 Hook。结果是父子使用不同的 Hook 集合，子 Agent 的 `PreCall`、`PreActing` 和 `PostActing` 等事件不会进入父 Hook。

这不是 Hook 调度器失效，也不是 `RuntimeContext` 没传。`DefaultAgentManager` 在调用子 Agent 时已经基于父 Context 构造子 Context，并替换子任务的 `sessionId` 和 `userId`。缺失发生在更早的构建阶段：子 Agent 根本没有安装父 Hook。

## 第一处核心修改：把父 Hook 装到 declared subagent

修复直接补齐了声明式工厂：

```java
final List<Hook> capturedHooks = List.copyOf(b.hooks);

// ...构建 declared subagent

sub.middlewares(capturedMiddlewares);
sub.hooks(capturedHooks);
return sub.build(decl.getTools());
```

`List.copyOf` 复制的是列表结构，不会复制 Hook 实例。这样做有两个效果：

1. 后续修改父 Builder 的列表，不会改变已捕获的列表内容。
2. 父子仍使用相同的 Hook 实例，沿用原有优先级和去重语义。

`sub.hooks(capturedHooks)` 才是 Issue #1578 的直接修复。之后子 Agent 调用 `query_logs` 时，父级治理 Hook 也能收到子 Agent 的事件。

## 为什么不能只加 `sub.hooks(...)`

Hook 不只是事件监听器，它还可以通过 `Hook.tools()` 提供工具：

```java
interface Hook {
    default List<Object> tools() {
        return List.of();
    }
}
```

如果只是把 Hook 传给子 Agent，Hook 提供的全部工具也会被注册。假设声明式 Subagent 只允许：

```yaml
tools:
  - query_logs
```

而父 Hook 同时贡献了 `query_logs` 和 `delete_logs`，直接继承会把 `delete_logs` 重新带入子 Agent，绕过声明的工具白名单。

因此这个 PR 除了修复 Hook 继承，还必须解决一个配套问题：**继承 Hook 的行为，但不能绕过子 Agent 的工具边界。**

## 第二处核心修改：先过滤 Hook 工具，再安装

PR 在 `ReActAgent.Builder` 新增了构建入口：

```java
public ReActAgent build(Consumer<Toolkit> hookToolFilter) {
    Toolkit agentToolkit = this.toolkit.copy();

    if (hookToolFilter == null) {
        registerToolsFromHooks(agentToolkit);
    } else {
        Toolkit hookTools = new Toolkit();
        registerToolsFromHooks(hookTools);
        hookToolFilter.accept(hookTools);

        for (String toolName : hookTools.getToolNames()) {
            agentToolkit.registerAgentTool(hookTools.getTool(toolName));
        }
    }

    // ...继续构建 ReActAgent
}
```

流程变成：

```text
读取 Hook.tools()
  → 注册到临时 hookTools
  → 应用 declared tools 白名单
  → 应用子 workspace 的 tools.json
  → 把剩余工具安装到正式 agentToolkit
```

临时 Toolkit 还有一个实际作用：正式 Toolkit 可能配置为禁止运行时删除工具。构建阶段先在临时对象中完成过滤，可以避免“删除被禁止，受限工具又被保留下来”。

`HarnessAgent` 侧调用 `inner.build(...)` 时，同时应用两层规则：

- `decl.getTools()`：Subagent 声明的继承工具名单
- `resolvedToolsConfig`：子工作区的 `tools.json` allow/deny 策略

声明中的工具列表为空时，仍然会执行 workspace 工具策略；子 Agent 自己的 Harness 平台工具也按现有规则保留。

## 是否应该默认继承所有父 Hook

这次 PR 选择了自动继承父 Builder 上显式配置的全部 Hook，而且没有新增开关。

这个默认值对治理类 Hook 是合理的。权限、HITL、审计和预算如果允许子 Agent自行跳过，就很容易被任务委派绕开。

但并非所有 Hook 都天然适合父子共享。例如只负责顶层 UI 展示或父流程统计的 Hook，处理子事件后可能重复展示或重复计数。当前可以在 Hook 中根据事件携带的 Agent 身份决定是否跳过：

```java
public <T extends HookEvent> Mono<T> onEvent(T event) {
    if (!"parent".equals(event.getAgent().getName())) {
        return Mono.just(event);
    }

    // 仅处理父 Agent 事件
    return handleParentEvent(event);
}
```

Review 中对此留下了一条非阻塞建议：文档应明确 declared subagent 会继承全部显式父 Hook，并说明 parent-only Hook 应如何跳过子事件。这个契约比再增加一个继承开关更值得先写清楚。

## `Consumer<Toolkit>` 的 API 边界

`Consumer<Toolkit>` 在功能上可以完成需求，但它比文档描述的“过滤器”能力更宽。调用方拿到可变 Toolkit 后，不仅能删除工具，还能增加或替换工具：

```java
hookToolFilter.accept(hookTools);
```

当前规则只需要回答“这个工具名保留还是丢弃”，更窄的标准库接口会更直接：

```java
public ReActAgent build(Predicate<String> hookToolFilter)
```

对应的构建逻辑只允许做 keep/drop 决策：

```java
for (String toolName : hookTools.getToolNames()) {
    if (hookToolFilter.test(toolName)) {
        agentToolkit.registerAgentTool(hookTools.getTool(toolName));
    }
}
```

这不是本 PR 的功能错误，也没有作为合并条件。Review 将它记录为非阻塞 suggestion：既然新增的是 public API，最好让类型本身表达最小权限，而不是只靠 Javadoc 约束调用者。

## 测试覆盖了什么

PR 共修改 5 个文件，新增 680 行、删除 3 行，其中 616 行是测试。覆盖的主要场景包括：

- Java 声明、静态 Markdown 和动态 Markdown
- `general-purpose` 原有行为不回归
- Hook 顺序与去重
- 子 Agent 事件携带正确的 Agent 身份
- `PreCall` 实际改写工具参数
- Hook 提供的 `AgentTool` 和注解工具
- declared tools 白名单过滤
- `tools.json` allow/deny
- 正式 Toolkit 禁止删除工具时，构建期过滤仍然生效
- 工具 metadata、executor 和 chunk callback 保留

审查时 GitHub 上的 Linux、Windows、Codecov、License 和 CLA 检查均通过。PR 作者还报告了多组定向测试；其中 core 全量测试的两个错误来自 Windows 符号链接权限，并在相同 main 提交上复现。本文没有把作者的本地结果表述为我的本机复测。

## Review 结论

这次修改解决了一个真实的治理缺口：父 Agent 明确安装了 Hook，框架自动创建的 declared subagent 却没有继承。修复位置与 Issue 对得上，三种声明来源共用同一个工厂，工具白名单也没有因为 Hook 继承而失效。

最终提交了 `Approve`，整体意见为 `LGTM`，并留下两条非阻塞建议：

1. 文档明确全部显式父 Hook 的继承语义，以及 parent-only Hook 的过滤方式。
2. 考虑用 `Predicate<String>` 收窄新增的 public 过滤接口。

这次 Review 最值得复用的判断顺序是：看到“把父配置复制给子 Agent”时，先确认哪些创建路径共用这段工厂；看到“继承 Hook”时，再确认 Hook 是否还会带入工具、状态或其他能力。只检查 `sub.hooks(capturedHooks)` 这一行，会漏掉工具权限这半个问题。
