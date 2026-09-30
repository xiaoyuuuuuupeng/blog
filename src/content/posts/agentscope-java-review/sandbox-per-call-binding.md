---
pubDatetime: 2026-08-24T10:00:00+08:00
title: "as-java-review: 修复并发下的 Sandbox 按 call 绑定隔离"
description: "复盘 AgentScope Java PR #2675：agent 级单槽 sandbox 在跨 session 并发下如何互相踩踏，以及如何把绑定迁到 per-call RuntimeContext。"
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
> **PR**：[agentscope-ai/agentscope-java#2675](https://github.com/agentscope-ai/agentscope-java/pull/2675)  
> **Issue**：[\#2490](https://github.com/agentscope-ai/agentscope-java/issues/2490)  
> **标题**：fix(harness): isolate sandbox binding per call to fix concurrent corruption  
> **作者**：larry-zy  
> **Review**：[xiaoyuuuuuupeng 的 LGTM 评论](https://github.com/agentscope-ai/agentscope-java/pull/2675#issuecomment-5393489021)（普通评论，非正式 Approve；正式 Approve 来自 jujn）  
> **日期**：2026-08-24  

---

## 前言

这个 PR 动 3 个文件（约 +293 / -19），CI 相关单测全绿，合并于 2026-08-24。它修的是 **同一 `HarnessAgent` bean 上跨 session 并发时，sandbox 绑定互相踩踏**。

表面症状有两类：

1. call A 的工具读写打到 session B 的 sandbox；
2. call A 结束 `release` 时，把仍在跑的 sibling call 的 sandbox 拆掉。

根因不是 sandbox 容器本身坏了，而是 **agent 级单槽** 存了「当前 sandbox」——并发合法时，单槽必然 last-writer-wins。

本文记录：串行边界到底保了什么、竞态怎么发生、PR 如何把绑定迁到 `RuntimeContext`，以及为什么这只是 #2490 的前半段（后半段见 [#2854 fallback 生命周期](/posts/agentscope-java-review/sandbox-fallback-lifecycle/)）。

---

## 1. 先搞清上下文：谁会并发、谁必须串行

### 1.1 `serializeOnKey` 只串行同 session

`AgentBase` 用 `serializeOnKey` 保证同一 `(userId, sessionId)` 不会并行跑两轮 call。跨 session 则 **允许并发**——这是框架设计，不是 bug。

因此服务端常见形态是：

```text
一个 HarnessAgent bean
  ├─ session-A：小明正在 stream / 调工具
  └─ session-B：小红几乎同时 call
```

两个 call 各自应该有自己的 sandbox。共享的只能是 agent 配置、middleware 实例本身，**不能是「当前 sandbox」这个可变槽位**。

### 1.2 旧绑定落在两处 agent 级状态

修复前，生命周期大致是：

```text
SandboxLifecycleMiddleware.acquireForCall
  ├─ manager.acquire(...) → Sandbox
  ├─ currentAcquireResult.set(result)     ← AtomicReference，agent 级单槽
  └─ filesystemProxy.setSandbox(sandbox)  ← volatile sandbox，agent 级单槽

工具 / 文件系统
  └─ 读 currentAcquireResult 或 volatile sandbox

SandboxLifecycleMiddleware.releaseForCall
  ├─ currentAcquireResult.getAndSet(null)  ← 取出并清空共享槽
  ├─ sandboxManager.persistState(result, ...)
  ├─ sandboxManager.release(result)
  ├─ result.getLease().close()
  └─ filesystemProxy.setSandbox(null)     ← 直接清空单槽
```

`SandboxBackedFilesystem` 作为常驻代理，把读写转发到「当前」sandbox。代理常驻没问题；**把「当前」定义成一个 agent 级字段，才是并发死结**。

---

## 2. 旧代码有什么问题：合法交错会踩踏

### 2.1 案例：A.acquire → B.acquire → A.use → A.release

这是 PR 单测钉住的交错，也是真实服务里最容易出现的顺序。

| 步骤 | 事件 | `currentAcquireResult` / `volatile sandbox` |
|------|------|---------------------------------------------|
| 1 | A `acquireForCall` | `sbA` |
| 2 | B `acquireForCall` | **`sbB`（覆盖 A）** |
| 3 | A 调 `read_file` / `shell` | 读到 **`sbB`** 💥 |
| 4 | A `releaseForCall` | 释放并清空 → 可能拆掉 **`sbB`**，B 还在用 💥 |

两类失败对应 Issue #2490：

| 失败模式 | 用户可见后果 |
|----------|--------------|
| **误用 sibling sandbox** | 文件读写串 session；权限/隔离被打破 |
| **误 release sibling** | B 后续 I/O 失败、容器被提前回收、`No active sandbox` |

注意：同 session 不会走到这步——`serializeOnKey` 已经挡住。踩踏只发生在 **跨 session 合法并发**。

### 2.2 为什么「各自 acquire」不够

看起来每个 call 都 `acquire` 了自己的 sandbox，但 **binding 写回了一个共享槽**。acquire 得到的是正确对象；之后谁覆盖槽位、谁按槽位 release，才决定工具实际打到哪里。

等价于：

```java
// 伪代码：旧语义
AtomicReference<SandboxAcquireResult> slot = ...;

void acquire(call) {
    SandboxAcquireResult r = manager.acquire(...);
    slot.set(r);                 // last writer wins
    fs.setSandbox(r.getSandbox());
}

void use(call) {
    Sandbox s = slot.get().getSandbox(); // 可能是别人的
}

void release(call) {
    SandboxAcquireResult r = slot.get(); // 可能是别人的
    manager.release(r);
    fs.setSandbox(null);                 // 无条件清空
}
```

没有 per-call 身份，就无法回答「这次 release 该不该动这个槽」。

---

## 3. 如何排查：Review 步骤

### 3.1 读核心 API

1. `SandboxLifecycleMiddleware.acquireForCall` / `releaseForCall`
2. `SandboxBackedFilesystem.setSandbox` / `requireSandbox` / 新增的 `clearSandboxIfCurrent`
3. `AgentBase.serializeOnKey` 的串行 key：确认 bug 边界是跨 session，不是同 session 重入
4. PR 新增 `SandboxLifecycleConcurrencyReproTest`

### 3.2 检查清单

| 检查项 | 结论 |
|--------|------|
| 工具路径是否优先读 `RuntimeContext` 上的 `SandboxAcquireResult` | ✅ 本 PR 核心 |
| `releaseForCall` 是否只释放本 call 绑过的 result | ✅ 从 ctx 读回自己的 binding |
| A release 是否会无条件 `setSandbox(null)` 清掉 B | ✅ 改为 `clearSandboxIfCurrent(sbA)` |
| context-free 内部读者是否仍靠 volatile fallback | ⚠️ 保留；本 PR 只防误清，不做 session 路由 |
| 同 session 串行路径是否被破坏 | ✅ 行为兼容 |

### 3.3 本地回归

```powershell
git fetch upstream pull/2675/head:pr-2675
git checkout pr-2675

mvn -q install -DskipTests
mvn -pl agentscope-harness -q test `
  "-Dtest=SandboxLifecycleConcurrencyReproTest,SandboxBackedFilesystemTest,SandboxLifecycleMiddlewareCallbackTest"
```

PR 描述：相关测试 **18 run / 0 failures**。

---

## 4. PR 如何修复

### 4.1 主路径：绑定到 `RuntimeContext`（per-call）

```java
// acquireForCall
SandboxAcquireResult result = manager.acquire(...);
ctx.put(SandboxAcquireResult.class, result);
filesystemProxy.setSandbox(result.getSandbox()); // fallback 仍写，见下节

// 工具 / requireSandbox
SandboxAcquireResult bound = runtimeContext.get(SandboxAcquireResult.class);
if (bound != null) {
    return bound.getSandbox(); // 各 call 各用各的
}
```

关键不变量：

- **谁 acquire，谁把 result 放进自己的 ctx**
- **谁 release，谁从自己的 ctx 取回 result**
- 跨 session 并发时，ctx 不同 → binding 不共享

### 4.2 `releaseForCall` 只拆自己的 sandbox

```java
// 绑定清理片段；省略持久化、异常日志与 lease 收尾
SandboxAcquireResult mine = ctx.get(SandboxAcquireResult.class);
if (mine != null) {
    ctx.put(SandboxAcquireResult.class, null);
    filesystemProxy.clearSandboxIfCurrent(mine.getSandbox());
    sandboxManager.release(mine);
}
```

对比旧逻辑「读 agent 级 AtomicReference 再 release」：现在释放对象与本 call 身份一致，不会误拆 sibling。

### 4.3 volatile 保留作 context-free fallback

内部组件（如 `WorkspaceMessageBus`）常用 `RuntimeContext.empty()` 读写文件，ctx 里没有 `SandboxAcquireResult`，只能走 fallback 字段：

```java
private Sandbox requireSandbox(RuntimeContext runtimeContext) {
    Sandbox s = null;
    if (runtimeContext != null) {
        SandboxAcquireResult bound = runtimeContext.get(SandboxAcquireResult.class);
        if (bound != null) s = bound.getSandbox();
    }
    if (s == null) s = sandbox; // volatile fallback
    if (s == null) throw new SandboxConfigurationException("No active sandbox ...");
    return s;
}
```

本 PR **没有删除** 这条路径，只改维护方式：用 synchronized compare-and-clear，避免 A release 时误清 B 刚写上的 fallback。

```java
public synchronized void clearSandboxIfCurrent(Sandbox expected) {
    if (this.sandbox == expected) {
        this.sandbox = null;
    }
}
```

语义：

| 场景 | 行为 |
|------|------|
| field 仍是本 call 的 sandbox | 清空 ✅ |
| field 已被 sibling 覆盖成别的 sandbox | **不动** ✅ |
| 两个 call 先后 release | 各自只清「仍指向自己」的那一次 |

这能挡住「A release 拆掉 B 的 fallback」，但挡不住「B 后 acquire、先 release 把单槽清成 null」——那是 [#2854](/posts/agentscope-java-review/sandbox-fallback-lifecycle/) 用 binding 栈修的空窗问题。本 PR 是前半段：**工具路径隔离**；#2854 是后半段：**fallback 生命周期**。

### 4.4 测试钉住的交错

`SandboxLifecycleConcurrencyReproTest` 确定性驱动：

```text
A.acquire → B.acquire → A.use → A.release
```

断言三点：

1. A 的 use 打到 `sbA`，不是 `sbB`
2. A release 只影响 A
3. B 的 sandbox 在 A release 后仍可用

没有 `sleep`、不依赖真实 sandbox backend，适合做回归哨兵。

---

## 5. 还没解决什么

### 5.1 fallback 仍是单槽

工具路径修好了；context-free 仍看 `volatile sandbox`。多 session 同时在线时：

- 后 acquire 的 call 覆盖 fallback → 内部读者可能读到「别人的」sandbox
- 后 release 且 field 指向自己 → 仍可把 fallback 清成 null（#2854 场景）

本 PR 的 compare-and-clear **故意收窄范围**：先消灭「工具串 sandbox / 误拆 sibling」，不宣称修完所有 fallback 竞态。

### 5.2 和后续 PR 的关系

| PR | 修什么 |
|----|--------|
| **#2675（本文）** | per-call `RuntimeContext` 绑定；release 只动自己；fallback compare-and-clear |
| **[#2854](/posts/agentscope-java-review/sandbox-fallback-lifecycle/)** | fallback 从单槽改 binding 栈，避免后 release 清空先开始的 call |
| 建议 follow-up | session-keyed fallback，或给 MessageBus 等内部路径传真实 context |

读本系列时建议按时间线：**#2675 → #2854**。

---

## 6. Review 结论

### 6.1 已解决 ✅

- 跨 session 并发下，工具执行不再共享 agent 级 `AtomicReference` 槽
- `releaseForCall` 只释放本 call 的 sandbox
- A release 不会无条件 `setSandbox(null)` 清掉 sibling 的 fallback
- 单测覆盖关键交错，可稳定回归

### 6.2 未解决 / 已知边界 ⚠️

- context-free fallback 仍可能 last-writer-wins 或被后结束的 call 清成 null
- 完整「空窗 + 混 sandbox」要到 #2854 及后续 session 路由

### 6.3 最终表态

**LGTM（普通评论）** — 方向正确：把可变 binding 从 agent 级迁到 call 级。对 #2490 报告的工具路径踩踏，修复成立；fallback 残留问题应作为 follow-up，而不是堵本次合并。

审查当日评论原文：

> LGTM. This fixes the sandbox race by binding each sandbox to its own call context.

---

## 7. 附录：几个高频问题

### Q：同 session 会不会也踩踏？

不会走这条竞态。同 `(userId, sessionId)` 被 `serializeOnKey` 串行；#2490 的触发条件是 **跨 session 共用一个 agent bean**。

### Q：为什么还要保留 volatile fallback？

因为有一批内部路径故意用空 `RuntimeContext`（MessageBus inbox、部分异步组件）。立刻删掉 fallback 会大面积炸掉；本 PR 选择 **工具路径正确 + fallback 尽量别误清**，把彻底化留给后续。

### Q：`clearSandboxIfCurrent` 和 #2854 的栈是一回事吗？

不是。本 PR 的 compare-and-clear 仍是 **单槽**；#2854 改成 **binding 列表 + 栈顶**，解决「B 后进先出把 field 清 null」的空窗。两者叠加才覆盖 #2490 系列的两层问题。

### Q：生产上如何规避？

短期：确认工具路径走 per-call（本 PR 合入后默认如此）。  
中期：合入 #2854。  
长期：每个 `(agentId, sessionId)` 单独缓存 agent，或给 fallback 做 session key。

---

## 8. 小结

| 阶段 | 要点 |
|------|------|
| 上下文 | 跨 session 并发合法；旧代码用 agent 级单槽存 sandbox |
| 根因 | acquire/use/release 都读写同一槽 → 误用 sibling / 误拆 sibling |
| 修复 | `SandboxAcquireResult` 绑 `RuntimeContext`；`releaseForCall` 只释自己；fallback `clearSandboxIfCurrent` |
| 测试 | `SandboxLifecycleConcurrencyReproTest` 钉住 A→B→A.use→A.release |
| Review | LGTM 普通评论；工具隔离 ✅；fallback 完整生命周期留给 #2854 |
| 后续 | 读 [sandbox-fallback-lifecycle](/posts/agentscope-java-review/sandbox-fallback-lifecycle/) |

这是一次「边界清楚、测试对准交错、不假装一次修完所有层」的 harness bugfix。per-call 绑定是正确的第一刀；读完它再看 #2854，整条 sandbox 并发故事才完整。

---

*相关 Issue：[#2490](https://github.com/agentscope-ai/agentscope-java/issues/2490)*  
*后续修复：[#2854 retain active fallback across concurrent calls](https://github.com/agentscope-ai/agentscope-java/pull/2854)*
