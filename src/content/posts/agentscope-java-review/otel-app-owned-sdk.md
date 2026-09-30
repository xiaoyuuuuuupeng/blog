---
pubDatetime: 2026-09-29T16:00:00+08:00
title: "as-java-review: Tracing Middleware 支持应用自有 OpenTelemetry SDK"
description: "复盘 AgentScope Java PR #3250：OtelTracingMiddleware 为何被 GlobalOpenTelemetry 绑死，以及注入调用方 SDK 后如何保持 lazy global 与 Reactor hook 语义。"
author: "Xiaoyu"
featured: false
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

> 本文记录的是 2026-09-28 审查时的代码与结论。PR 于 2026-09-29 合并，细节仍以 GitHub 为准。<br>
> **PR**：[agentscope-ai/agentscope-java#3250](https://github.com/agentscope-ai/agentscope-java/pull/3250)（**MERGED** 2026-09-29）<br>
> **Issue**：[Refs #3229](https://github.com/agentscope-ai/agentscope-java/issues/3229)（注意：应使用 Refs，不是 Fixes）<br>
> **作者**：mvanhorn<br>
> **Review**：[Approve + LGTM（2026-09-28）](https://github.com/agentscope-ai/agentscope-java/pull/3250#pullrequestreview-5333327262)

## 问题：Tracing 只能走 GlobalOpenTelemetry

`OtelTracingMiddleware` 原先只有无参构造：

```java
public OtelTracingMiddleware() {
    // tracer 一律来自 GlobalOpenTelemetry
}
```

三个 hook 取 tracer 时，实际都落在全局 SDK：

```java
Tracer tracer = GlobalOpenTelemetry.getTracer("io.agentscope");
```

这对“进程里只有 AgentScope 负责装 OpenTelemetry”的应用够用。一旦应用自己持有 SDK——例如业务侧已经 `OpenTelemetrySdk.builder()...buildAndRegisterGlobal()`，或根本不打算注册 global，只想把 AgentScope span 打进自己的 exporter / processor——中间件就没有选择权。

Issue #3229 来自更具体的冲突现场：应用同时使用 AgentScope 与 AliyunJavaAgent / StudioManager 一类路径。报告里的现象是：

- 自托管 agent-studio 侧通过 `StudioManager` 期望看到 trace
- 某些集成会替换或干扰 `TracerRegistry.get()` 的返回值
- 关掉 AgentScope instrumentation 后导出恢复，但 UI 可展开调用树又可能丢失

用户要的直接能力很清楚：**给 `OtelTracingMiddleware` 一个受支持的 OpenTelemetry / Tracer 注入口**，让 span 记在应用自有 SDK 上，而不是只能绑 `GlobalOpenTelemetry`。

## 这个 PR 解决了什么，刻意没解决什么

| 诉求 | #3250 | 说明 |
| ---- | ----- | ---- |
| 中间件使用调用方 SDK | 已解决 | 新增非空构造 `OtelTracingMiddleware(OpenTelemetry)` |
| 不替换 / 不注册 global | 已解决 | caller-owned lifecycle，不碰 `GlobalOpenTelemetry` |
| 无参构造兼容旧行为 | 已解决 | 仍 lazy lookup global |
| Reactor 上下文传播 | 保持 | 两构造都 once-per-JVM 注册 hook，并补文档 |
| `StudioManager` / `TracerRegistry.get()` 共存 | **未解决** | 本 PR 不改那条路径 |

因此 Issue 关联必须是 **Refs #3229**，不能是 **Fixes #3229**。我在 Approve 时明确提醒作者：PR 描述和 commit message 都要改掉 Fixes，让 #3229 继续保持 Open，直到 StudioManager 路径真正被处理。

## 修复：注入 SDK，而不是再包一层 Provider

PR 的主接口非常克制，只加了一个构造器：

```java
public OtelTracingMiddleware(OpenTelemetry openTelemetry) {
    this.openTelemetry =
        Objects.requireNonNull(openTelemetry, "openTelemetry must not be null");
    this.tracer = this.openTelemetry.getTracer(INSTRUMENTATION_NAME);
    registerReactorHook();
}

public OtelTracingMiddleware() {
    this.openTelemetry = null;
    this.tracer = null; // hook 执行时再查 GlobalOpenTelemetry
    registerReactorHook();
}
```

设计选择值得展开：

1. **注入的是 `OpenTelemetry`，不是自定义 `TracerProvider` 接口。** 少一个抽象，调用方直接复用官方 SDK 类型。
2. **生命周期归调用方。** 中间件不 `close()` SDK，也不 `buildAndRegisterGlobal()`。
3. **app-owned 路径在构造期缓存 `io.agentscope` tracer。** 避免每次 hook 重复 lookup；测试钉住“只解析一次”。
4. **无参路径继续 lazy。** 允许先 `new OtelTracingMiddleware()`，稍后应用再注册 global；第一次真正打 span 时才取值。

`getTracer()` 的分支可以读成：

```java
private Tracer getTracer() {
    if (openTelemetry != null) {
        return tracer; // caller-owned
    }
    return GlobalOpenTelemetry.getTracer(INSTRUMENTATION_NAME);
}
```

三个已有 hook（agent / model / tool 一类事件）都改走 `getTracer()`，父上下文传播、attributes、cancel、error status 行为保持不变。没有额外 builder，也没有 test-only seam。

## 为什么无参构造必须继续 lazy

如果无参构造也在 `<init>` 里立刻：

```java
this.tracer = GlobalOpenTelemetry.getTracer("io.agentscope");
```

会出现一类真实时序问题：中间件作为 Spring Bean / 静态字段更早创建，而 global SDK 更晚才 `registerGlobal`。构造期拿到的可能是 noop，之后即使 global 就绪，中间件仍握着旧 tracer。

PR 保留 lazy lookup，并有回归测试覆盖 **late global registration**：

```text
1. new OtelTracingMiddleware()
2. 应用稍后 registerGlobal(sdk)
3. 触发 hook
4. span 应进入刚注册的 SDK，而不是构造期 noop
```

注入构造则相反：调用方在传入那一刻就明确了 SDK，构造期缓存 tracer 是正确且更便宜的。

## Reactor ContextPropagationOperator：两构造都注册，但只包装“之后组装”的 operator

两个构造都会走 once-per-JVM 的：

```java
ContextPropagationOperator.registerOnEachOperator();
```

这不是疏忽。AgentScope 的 tracing 依赖 Reactor 上下文跨 scheduler 传播；只给 app-owned 路径跳过 hook，跨线程嵌套 span 会丢父上下文。

早期 review 指出文档缺口后，作者补了三层说明：

1. 类 / 构造器 Javadoc
2. EN middleware 文档
3. ZH middleware 文档

最终措辞还精确了一点：hook **只包装注册之后组装出来的** `Flux` / `Mono`。注册前已经建好的 publisher，不会自动获得上下文传播。

这是 `ContextPropagationOperator` 的真实语义，不是 AgentScope 私有限制。文档写清楚后，调用方就不会误以为“只要 new 了中间件，进程里所有历史流都会被追溯”。

一次注册、两构造共享，也意味着：即使用的是 app-owned SDK 记 span，Reactor hook 仍然是 JVM 级副作用。它包装的是操作符组装，不是某个具体 SDK；谁负责记 span，仍由 `getTracer()` 决定。

## 调用方怎么用

应用自有 SDK：

```java
OpenTelemetrySdk sdk = OpenTelemetrySdk.builder()
    .setTracerProvider(provider)
    .build(); // 注意：这里可以不 registerGlobal

HarnessAgent.builder()
    .middleware(new OtelTracingMiddleware(sdk))
    .build();
```

继续使用全局 SDK：

```java
HarnessAgent.builder()
    .middleware(new OtelTracingMiddleware())
    .build();
```

两条路径不应互相踩：

- 注入构造 **不得** 调用 `GlobalOpenTelemetry.set(...)` 或替换已有 global
- 无参构造 **不得** 要求调用方先注入
- 同一 JVM 可以先有 app-owned middleware，再有另一条仍走 global 的旧代码；测试用隔离 SDK 验证 span 不会串台

## 和 StudioManager 冲突怎么并存

#3229 的原始报告并不只是“我想注入 SDK”。更大的背景是：

```text
应用进程
  ├─ AgentScope OtelTracingMiddleware  → 原先只认 GlobalOpenTelemetry
  ├─ AliyunJavaAgent / 其他探测       → 可能改 TracerRegistry / global
  └─ StudioManager（自托管 studio）   → 期望读到完整调用树
```

如果中间件只能写 global，应用几乎只有三条路：

1. 让 AgentScope 独占 global，第三方探测让路
2. 关掉 AgentScope instrumentation，保住导出，但可能丢 UI 树
3. 自己 fork / 反射替换 middleware

PR #3250 提供的是第 4 条：AgentScope span 打进调用方 SDK，global 留给别人或干脆不注册。这对“应用已经有一条 OpenTelemetry 管道”的集成是正确切口。

它仍然解决不了 StudioManager 自己怎么取 tracer。如果 Studio 侧继续调用 `TracerRegistry.get()`，而第三方又替换了返回值，UI 缺树的问题还会在。这也是 Refs 而不是 Fixes 的技术理由：middleware 可注入 ≠ 整条观测链路可共存。

## 为什么不加 Tracer 直接注入或 Provider SPI

Review 过程里很容易想到更“灵活”的 API：

```java
new OtelTracingMiddleware(Tracer tracer);
new OtelTracingMiddleware(TracerProvider provider);
OtelTracingMiddleware.builder().openTelemetry(sdk).build();
```

这次 PR 刻意没加。理由很实际：

1. 现有 hook 已经固定使用 instrumentation name `io.agentscope`。从 `OpenTelemetry` 取 tracer，比让调用方手传任意 `Tracer` 更难配错名字。
2. 多一个 SPI / builder，测试矩阵和文档都会涨，但对 #3229 的即时诉求没有增量。
3. 官方 `OpenTelemetry` 已经是稳定门面；再包一层 Provider 只是把标准类型翻译成项目类型。

在“能注入自有 SDK”已经成立时，继续加缝是过度设计。后续若 StudioManager 也要统一选 tracer，再在更高层收敛入口，而不是先把 middleware 做成万能工厂。

## 测试覆盖了什么

`OtelTracingMiddlewareTest` 在审查头上是 19/19。真正有价值的不是“能 new 出来”，而是这些隔离与时序：

| 场景 | 为什么重要 |
| ---- | ---------- |
| 注入 SDK 隔离 | span 只进调用方 SDK，不依赖也不污染 global |
| 跨 scheduler 嵌套 | Reactor hook 仍能串起父子 span |
| late global registration | 无参构造 lazy 语义不被提前缓存破坏 |
| noop SDK | 无 exporter 时也不应抛错或泄漏上下文 |
| error status | 异常路径仍正确标记 span |
| cancel | 取消订阅时 span 结束语义保持 |

作者本地没有宣称跑过全量 `mvn test`，但定向中间件测试和后续 CI（含 Windows build）在合并前已绿。PR 体量约 +440 / -12，改动集中在 middleware、测试与文档，没有顺手重画 Studio 上报链路。

跨 scheduler 嵌套测试尤其关键：它同时验证了“app-owned tracer 仍能挂父 span”和“Reactor hook 没有因为换构造器而失效”。如果只测单线程 `Mono.just`，很容易漏掉 hook 注册时序问题。

## Review 关注点与落地情况

### 1. 注入构造是否偷偷改 global

这是 #3229 用户最怕的。LGTM 的前提就是：caller-owned SDK 只用于 `getTracer()`，生命周期不接管，也不注册 global。审查头满足这一点。

### 2. Reactor hook 是否被低估成“实现细节”

第一轮 review 要求文档披露 JVM 级 hook；第二轮要求写清“只影响注册后组装的 operator”。作者两轮都补了，最终头上的文档与行为一致。

### 3. app-owned tracer 是否每次 hook 都 lookup

后续提交改为构造期缓存，并加测试钉住单次解析。无参路径保持 lazy，两边语义分开，没有用一个缓存策略打平两种构造。

### 4. Issue 关闭语义

功能上这是 #3229 的必要一步，但不是充分一步。`StudioManager`、`TracerRegistry.get()`、AliyunJavaAgent 替换返回值这些报告路径原封不动。把关联写成 Fixes，会在合并时错误关闭 Issue，让“UI 调用树 / Studio 共存”从看板消失。

我 Approve 时的结论可以压缩成四句：

1. LGTM
2. 注入构造使用调用方 SDK，不替换 global
3. 无参构造保持 lazy global lookup；Reactor hook 时机已文档化
4. 请把 `Fixes #3229` 改成 `Refs #3229`

## 合并后还留下什么

PR #3250 在 2026-09-29 合并，中间件层终于有了受支持的 app-owned SDK 入口。对大多数“我想把 AgentScope span 打进自己的 OpenTelemetry 管道”的应用，这条路已经够用。

仍开放的是 Issue #3229 后半段：

- StudioManager 自托管上报是否继续绕 `TracerRegistry`
- 与第三方 Agent 探测并存时，调用树 UI 为什么会丢
- 是否还需要在更高层（不只是 `OtelTracingMiddleware`）统一 tracer 选择

把这些问题留在 Refs 关联的 Issue 里，比在一个 middleware 构造器 PR 里顺手“修完”更诚实。

## Review 结论

这次修改是小而正确的 API 扩展：用一个非空 `OpenTelemetry` 构造器解开对 `GlobalOpenTelemetry` 的硬绑定，同时保住无参构造的懒加载兼容性，并把 Reactor hook 的 once-per-JVM 副作用写进文档。

我的审查意见是 **Approve / LGTM**，附加的唯一流程要求是 Issue 关联用 **Refs #3229** 而非 Fixes。PR 已于 2026-09-29 合并；StudioManager 共存问题应继续在 #3229 跟踪，而不是被这次合并悄悄关掉。
