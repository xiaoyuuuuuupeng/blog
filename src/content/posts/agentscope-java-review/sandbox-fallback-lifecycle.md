---
pubDatetime: 2026-08-27T09:00:00+08:00
title: "一次 Sandbox Fallback 并发生命周期 PR 的排查与 Review 实录"
description: "围绕多 session 并发，分析 sandbox fallback 的绑定、释放顺序与仍需 follow-up 的隔离边界。"
author: "Xiaoyu"
featured: false
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

> 本文记录的是审查当日的代码与结论；PR 状态和代码行号可能继续变化，请以文首 GitHub 链接为准。
> **PR**：[agentscope-ai/agentscope-java#2854](https://github.com/agentscope-ai/agentscope-java/pull/2854)  
> **Issue**：#2849（延续 #2490）  
> **标题**：fix(sandbox): retain active fallback across concurrent calls  
> **作者**：Oxygen56  
> **Review**：[xiaoyuuuuuupeng 的 Approve + 行内 Suggestion](https://github.com/agentscope-ai/agentscope-java/pull/2854#discussion_r3868368441)  
> **日期**：2026-08-26 ~ 2026-08-27  

---

## 前言

这个 PR 只动 4 个文件（2 个生产 + 2 个测试），CI 全绿，单测是确定性的（无 `sleep`、无真实 sandbox backend）。但它修的是 **#2490 只修了一半** 的并发问题：工具调用已经 per-call 隔离了，**context-free 内部读者** 仍靠单槽 `volatile sandbox` fallback，多 session 并发时会出现 `No active sandbox`。

在 Agent 服务里，一个 `HarnessAgent` bean 上跑多个 `(userId, sessionId)` 是框架允许的（`serializeOnKey` 只串行同 session）。一旦用户 A 还在 stream、用户 B 先结束，MessageBus / 异步子 agent 等内部路径就可能踩雷——不是工具坏了，是 **fallback 被误清空**。

本文记录：上下文怎么理解、竞态案例、如何本地复现、PR 修了什么，以及还剩什么。

---

## 1. 先搞清上下文：两层 sandbox 解析

### 1.1 调用链

```
HarnessAgent.call / stream
  └─ SandboxLifecycleMiddleware.acquireForCall(ctx)
       ├─ ctx.put(SandboxAcquireResult, result)   ← 路径 ① per-call 绑定
       └─ filesystemProxy.setSandbox(sandbox)       ← 路径 ② fallback 字段
  └─ 工具执行 / 内部组件读文件
       └─ SandboxBackedFilesystem.requireSandbox(ctx)
            ├─ ① ctx 里有 SandboxAcquireResult → 用对的 sandbox ✅
            └─ ② 否则用 fallback 字段（volatile / 栈）⚠️
```

### 1.2 #2490 修了什么、没修什么

| 路径 | 谁在用 | #2490 之后 |
|------|--------|-----------|
| **① per-call** | `read_file`、`shell` 等工具 | ✅ 各 session 隔离 |
| **② fallback** | `WorkspaceMessageBus`、`WorkspaceAsyncToolRegistry`、部分 `WorkspaceTaskRepository` | ❌ 仍共享，last-writer-wins |

内部组件典型写法（**context-free**）：

```java
// WorkspaceMessageBus.java
private static final RuntimeContext RC = RuntimeContext.empty();

fs.write(RC, path, json);  // RC 里没有 SandboxAcquireResult
```

`requireSandbox` 只能走 fallback：

```java
private Sandbox requireSandbox(RuntimeContext runtimeContext) {
    Sandbox s = null;
    if (runtimeContext != null) {
        SandboxAcquireResult bound = runtimeContext.get(SandboxAcquireResult.class);
        if (bound != null) s = bound.getSandbox();
    }
    if (s == null) s = sandbox;  // fallback
    if (s == null) throw new SandboxConfigurationException("No active sandbox ...");
    return s;
}
```

---

## 2. 旧代码有什么问题：后 acquire 先 release → fallback 变 null

### 2.1 案例：小明和小红共用一个 Agent

两个不同 session 合法并发（`s1 != s2` 不互斥）。

| 步骤 | 事件 | 单槽 fallback（修前） |
|------|------|----------------------|
| 1 | 小明 A `acquireForCall` | `sbA` |
| 2 | 小红 B `acquireForCall` | `sbB`（覆盖） |
| 3 | 小红 B `releaseForCall` | `clearSandboxIfCurrent(sbB)` → field == sbB → **`null`** |
| 4 | 小明还在 stream，子 agent 完成 → `MessageBus.inboxPush` | `fs.write(empty RC, ...)` → fallback **null** → 💥 |

异常：

```
SandboxConfigurationException: No active sandbox — sandbox filesystem used outside of a call context
```

### 2.2 为什么 #2490 的 compare-and-clear 不够

`clearSandboxIfCurrent` 设计是：**只有 field 仍指向本 call 的 sandbox 时才清空**，防止 A release 时误清 B 的 binding。

但在「B 后 acquire、先 release」场景里，field **本来就指向 B 自己的 sandbox**，清空是「合法」的——单槽没有记忆「A 还在跑」。

### 2.3 第二个 bug：start 失败误清别人的 fallback

若 A、B 共用同一个 user-managed sandbox 对象，B 的 `start()` 在 `setSandbox` **之前**失败，旧代码 catch 里仍调用 `clearSandboxIfCurrent(sandbox)`，会把 A 已注册的 binding 清掉。PR 第二个 commit 用 `fallbackBound` 标志修掉。

---

## 3. 如何排查：我们的 Review 步骤

### 3.1 第一步：读核心 API

1. `SandboxBackedFilesystem.setSandbox` / `clearSandboxIfCurrent`
2. `SandboxLifecycleMiddleware.acquireForCall` / `releaseForCall`
3. 对照 PR 新增的单测

### 3.2 第二步：重点检查清单

| 检查项 | 结论 |
|--------|------|
| 同一 sandbox 重复绑定的引用计数 | ✅ `sharedSandboxRemainsBoundUntilEveryCallReleases` |
| 先 release 非当前 binding 是否会「复活」旧 sandbox | ✅ 不会，只删列表项 |
| `start()` / `getState()` 异常是否只清本 call 注册的 fallback | ✅ `fallbackBound` |
| context-free fallback 是否承担 session 隔离 | ❌ **未修**，仍看栈顶 |
| `setSandbox(null)` 清整栈 | ⚠️ 无生产调用，建议 follow-up（见 §8） |

### 3.3 第三步：跑回归测试

```powershell
git fetch upstream pull/2854/head:pr-2854
git checkout pr-2854

# 根目录先装 BOM（首次）
mvn -q install -DskipTests

cd agentscope-harness
mvn -q test "-Dtest=SandboxBackedFilesystemTest,SandboxLifecycleConcurrencyReproTest"
```

本地结果：**全部通过**（约 24s）。

### 3.4 在 main 上复现「修前会红」

只 cherry-pick 测试、不打补丁时，以下用例会 FAIL：

- `contextFreeCallUsesRemainingSandboxWhenLatestCallReleases`
- `failedSharedSandboxStartDoesNotRemoveActiveFallback`

最小手工复现（main 单槽逻辑）：

```java
var fs = new SandboxBackedFilesystem();
fs.setSandbox(sbA);
fs.setSandbox(sbB);
fs.clearSandboxIfCurrent(sbB);  // fallback = null
fs.execute(RuntimeContext.empty(), "cmd", null);  // 抛 SandboxConfigurationException
```

---

## 4. PR 如何修复

### 4.1 binding 栈替代单槽

```java
private final List<Sandbox> fallbackBindings = new ArrayList<>();

public synchronized void setSandbox(Sandbox sandbox) {
    fallbackBindings.add(sandbox);
    this.sandbox = sandbox;
}

public synchronized void clearSandboxIfCurrent(Sandbox expected) {
    for (int i = fallbackBindings.size() - 1; i >= 0; i--) {
        if (fallbackBindings.get(i) == expected) {
            fallbackBindings.remove(i);
            break;
        }
    }
    this.sandbox = fallbackBindings.isEmpty()
            ? null
            : fallbackBindings.get(fallbackBindings.size() - 1);
}
```

同样案例修后：

| 步骤 | 栈 | 栈顶 |
|------|-----|------|
| A acquire | `[sbA]` | sbA |
| B acquire | `[sbA, sbB]` | sbB |
| B release | `[sbA]` | **sbA** |
| 小明 MessageBus 写 inbox | fallback = sbA | **不崩** ✅ |

### 4.2 fallbackBound：start 失败不误清

```java
boolean fallbackBound = false;
try {
    sandbox.start();
    ctx.put(SandboxAcquireResult.class, result);
    filesystemProxy.setSandbox(sandbox);
    fallbackBound = true;
    log.debug("...", sandbox.getState() ...);
} catch (Exception e) {
    if (fallbackBound) {
        filesystemProxy.clearSandboxIfCurrent(sandbox);
    }
    ...
}
```

### 4.3 新增测试覆盖

| 测试 | 验证点 |
|------|--------|
| `contextFreeCallUsesRemainingSandboxWhenLatestCallReleases` | B release 后 fallback 回到 A |
| `releasingNonCurrentSandboxDoesNotRestoreItLater` | 删非栈顶不会复活 |
| `sharedSandboxRemainsBoundUntilEveryCallReleases` | 同对象两次 acquire 要 release 两次 |
| `failedSharedSandboxStartDoesNotRemoveActiveFallback` | B start 失败不清 A |
| `failureAfterFallbackRegistrationClearsOwnBinding` | getState 失败只清自己 |

---

## 5. 还没解决什么：fallback 仍可能「混 sandbox」

PR **故意收窄范围**，只修空窗崩溃，不做 session 路由。

### 5.1 案例：两人都在线时

| 时间 | 事件 | fallback 栈顶 |
|------|------|---------------|
| T1 | A、B 都在跑 | **sbB**（后 acquire） |
| T2 | 小明的子 agent `inboxPush(session-A, ...)` | context-free → 写到 **sbB** ⚠️ |

- 工具调用仍各用各的 context → **不串**
- MessageBus 等内部路径 → **可能串**（PR 前就有，不是新回归）

### 5.2 建议的 follow-up（未在本 PR 做）

**阶段 1**：fallback 从栈顶改成 `Map<SandboxIsolationKey, Sandbox>` + 引用计数，`requireSandbox` 按 `ctx.getSessionId()` 查。

**阶段 2**：`WorkspaceMessageBus.inboxPush(sessionId, ...)` 内部用 `RuntimeContext.builder().sessionId(sessionId).build()`，别用 `RC.empty()`。

**应用层 workaround**：每个 `(agentId, sessionId)` 单独缓存 `HarnessAgent`（issue #2849 原文）。

---

## 6. Review 结论

### 6.1 已解决 ✅

- 后 acquire 先 release 时 fallback **不再变 null**
- `start()` / `getState()` 失败 **不误清** 其他 call 的 binding
- 同 sandbox 重复绑定的引用计数语义正确
- #2490 的 per-call 隔离 **未被破坏**

### 6.2 未解决，建议 follow-up ⚠️

- context-free 读者仍只看 fallback **栈顶**，多 session 并发可能访问错误 sandbox
- `setSandbox(null)` 会 `fallbackBindings.clear()` 清整栈（无生产调用，但 API 语义危险）

### 6.3 最终表态

**LGTM / Approve** — 针对 #2849 报告的空窗问题，生命周期语义成立，测试可稳定复现；混 sandbox 与 `setSandbox(null)` 作为 non-blocking follow-up。

---

## 7. 附录：几个高频问题的答案

### Q：context-free 是什么？什么时候触发？

不是特殊 API，就是框架内部用 `RuntimeContext.empty()` 调 `fs.read/write`，例如：

- 子 agent 完成 → `SubagentsMiddleware` → `messageBus.inboxPush(sessionId, ...)`
- 等异步结果 → `WaitAsyncResultsTool` → `messageBus.inboxHasMessages`
- 孤儿任务清扫 → `WorkspaceTaskRepository.sweepOrphanedTasks`

Agent 正常跑起来且用到上述功能时就会触发；和用户直接调工具有关但不是同一条路。

### Q：并发下会有两个 sandbox 吗？

**会，而且应该有两个**（各 session 各一个）。工具走 per-call context 隔离；fallback 栈只是记住「还有谁在跑」，避免后结束的 call 把 fallback 清成 null。

### Q：PR 修完后 fallback 和 session 绑定了吗？

**没有。** release 时只删自己的 binding 并恢复栈顶；context-free 仍可能拿到别的 session 的 sandbox。要根治需 session-keyed map 或给内部调用传 context。

### Q：`sharedUserManagedManager` 测试 helper 有问题吗？

没有。故意让多个 acquire 返回同一 `userManaged` sandbox，模拟外部注入共享容器；`userManaged` 的 `release` 是 no-op，不会干扰 fallback 生命周期断言。

---

## 8. 小结

| 阶段 | 要点 |
|------|------|
| 理解上下文 | 两层解析：per-call（#2490）+ fallback（本 PR） |
| 根因 | 单槽 last-writer-wins；后 release 的 call 清空 field，先开始的 call 的 context-free 读者崩溃 |
| 修复 | `fallbackBindings` 栈 + `fallbackBound` |
| 复现 | PR 单测或 main 上手写 `setSandbox` / `clearSandboxIfCurrent` 序列 |
| Review | 生命周期语义 ✅；混 sandbox ❌（scope 外）；`setSandbox(null)` nit |
| 后续 | session-keyed fallback；MessageBus 传 sessionId；或 per-session Agent 缓存 |

这是一个「改动小、钉住 reported bug、边界写得清楚」的 follow-up PR。空窗修复值得合入；session 级 fallback 路由值得另开 issue/PR 跟踪。

---

*相关 Issue：[#2849](https://github.com/agentscope-ai/agentscope-java/issues/2849)*  
*前置修复：[#2490 / #2675 isolate sandbox binding per call](https://github.com/agentscope-ai/agentscope-java/pull/2675)*
