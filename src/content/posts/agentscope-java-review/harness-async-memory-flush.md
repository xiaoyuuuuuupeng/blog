---
pubDatetime: 2026-08-28T08:00:00+08:00
title: "一次 Harness 异步 Memory Flush PR 的排查与 Review 实录"
description: "从响应尾部阻塞切入，审查异步 memory flush 的队列上限、丢弃语义、关闭行为与测试边界。"
author: "xiaoyuuuuuupeng"
featured: false
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

> 本文记录的是审查当日的代码与结论；PR 状态和代码行号可能继续变化，请以文首 GitHub 链接为准。
> **PR**：[agentscope-ai/agentscope-java#2833](https://github.com/agentscope-ai/agentscope-java/pull/2833)  
> **Issue**：[#2821](https://github.com/agentscope-ai/agentscope-java/issues/2821)  
> **标题**：fix(harness): support asynchronous memory flush  
> **作者**：guslegend0510  
> **Review**：[xiaoyuuuuuupeng 的 Approve + 讨论评论](https://github.com/agentscope-ai/agentscope-java/pull/2833)  
> **日期**：2026-08-28  

---

## 前言

这个 PR 动 8 个文件（约 +589 / -22），CI 全绿，测试覆盖也不错。但它修的是 Harness 用户很直观能感知的问题：**主模型已经答完了，对话还要卡一两分钟才结束**。

Issue #2821 的反馈很典型：开启长期记忆后，每次对话完成会同步卡在那里等待；用户用的是 `HarnessAgent`，不是旧版 `ReActAgent`。而 `ReActAgent.longTermMemoryAsyncRecord(true)` 虽然存在，但对 Harness 无效，且整段旧 API 已 `@Deprecated`。

本文记录：我们如何理解「两次 model 调用」、如何本地复现阻塞、PR 改了什么、Review 时发现了哪些设计 trade-off，以及与 qwen-code / gemini-cli 的差异。

---

## 1. 先搞清上下文：一次 `call()` 里其实有两次 LLM

用户只调了一次 `agent.call()`，但框架内部可能打 **两次** 模型：

| 次序 | 用途 | 用的模型 | 用户感知 |
|------|------|----------|----------|
| **第一次** | ReAct 主循环：思考、调工具、生成回复 | 主模型 | 这就是「助手回答」 |
| **第二次** | Memory flush：从对话里抽取值得长期记住的事实 | 记忆模型（默认同主模型） | 默认会拖住 `call()` 返回 |

第二次就是 Issue 里说的 **flush LLM**。它会把新事实追加到 `memory/YYYY-MM-DD.md`（日流水账），之后还有独立的 consolidation 流程合并进 `MEMORY.md`。

### 1.1 调用链（Harness）

```
HarnessAgent.call()
  └─ ReActAgent.buildAgentStream()     ← onAgent 中间件链
       ├─ 主 ReAct 循环（第一次 LLM）
       └─ MemoryFlushMiddleware        ← 默认 concatWith，等 flush 完成
            └─ MemoryFlushManager.flushMemories()
                 └─ model.stream()     ← 第二次 LLM（flush）
```

`MemoryFlushMiddleware` 注册在 `HarnessAgent.build()` 里，当 `memoryModel != null && !disableMemoryHooks` 时生效。

### 1.2 和旧版 ReActAgent 的对应关系

| | ReActAgent（旧） | HarnessAgent（新） |
|---|------------------|-------------------|
| 开关 | `longTermMemoryAsyncRecord(true)` | PR 新增 `MemoryConfig.asyncFlush(true)` |
| 实现类 | `StaticLongTermMemoryHook` | `MemoryFlushMiddleware` |
| 写入目标 | `LongTermMemory.record()`（如 Mem0） | `MemoryFlushManager` → `memory/YYYY-MM-DD.md` |
| 异步 scheduler | `newBoundedElastic(1, 3, "long-term-memory-record")` | PR 同样 `newBoundedElastic(1, 3, "memory-flush")` |

PR 本质上是把 ReAct 那条异步记录思路，补到 Harness 的 flush 管线上。

---

## 2. 旧代码有什么问题：文档写异步，实现是同步

### 2.1 实现：`concatWith` 阻塞响应流

修复前 `MemoryFlushMiddleware.onAgent()` 核心逻辑：

```java
return next.apply(input)
        .concatWith(
                Mono.defer(() -> doFlush(agent, rc))
                        .subscribeOn(Schedulers.boundedElastic())
                        ...
                        .then(Mono.<AgentEvent>empty()));
```

`concatWith` 的含义：**主响应事件发完之后，还要等 flush 这条 Mono 完成，整个 Flux 才算结束**。`call()` 会等到 Flux 结束才返回。

### 2.2 文档：却说 flush 是 fire-and-forget

`docs/v2/zh/docs/harness/memory.md` 的 「Flush 的三个触发点」 一节写着：

> Flush 和 offload 都是**异步执行**的：它们在响应流结束后通过 `doOnComplete` 以 fire-and-forget 方式启动，不会阻塞当前 `call()` 的返回。

类注释也写「Runs in onAgent's doOnComplete」——但默认路径明明是 `concatWith`。

**文档与代码不一致**，这是排查时的第一个 red flag，也是 Review 时建议作者顺手改文档的原因。

### 2.3 Issue #2821 的用户场景

- 版本 2.0.0 / 2.0.1 均有
- 使用 `HarnessAgent` + 长期记忆
- 对话完成后有时要等 **2–3 分钟**
- 期望：像旧 ReAct 一样能异步写记忆

维护者确认：Harness 2.0.1 确实没有对应的异步配置，本 PR 就是补这个能力。

---

## 3. 如何排查：我们的 Review 步骤

### 3.1 第一步：读 Issue + PR 描述，对齐问题定义

从 [#2821](https://github.com/agentscope-ai/agentscope-java/issues/2821) 和 [#2833](https://github.com/agentscope-ai/agentscope-java/pull/2833) 确认：

- 问题不是「第三方 memory 中间件」，而是 Harness 自带的 **per-call flush**
- 修复是 **opt-in**：`MemoryConfig.asyncFlush(true)`，默认仍为同步
- 只改 **路径 1**（per-call flush）；compaction / consolidation / transcript 语义不变

### 3.2 第二步：读 diff 核心三处

| 文件 | 改动 |
|------|------|
| `MemoryConfig.java` | 新增 `asyncFlush` 字段与 builder |
| `MemoryFlushMiddleware.java` | 同步/异步分支 + static scheduler |
| `HarnessAgent.java` | 把 `memoryConfig.asyncFlush()` 传给 middleware |

异步路径要点：

```java
if (asyncFlush) {
    return response.transformDeferredContextual(
            (events, contextView) ->
                    events.doOnComplete(() -> startAsyncFlush(agent, rc, contextView)));
}
```

- `doOnComplete` 时 **快照** `AgentState.getContext()`（defensive copy）
- 后台 `Mono.defer(() -> doFlush(rc, messages)).subscribeOn(ASYNC_FLUSH_SCHEDULER).subscribe()`
- 失败只记 warn，不影响已完成的响应

### 3.3 第三步：重点检查清单

| 检查项 | 结论 |
|--------|------|
| 默认行为是否不变 | ✅ `asyncFlush` 默认 `false`，仍 `concatWith` |
| 异步是否真不阻塞 | ✅ `MemoryFlushMiddlewareCompletionTest` + `HarnessAgentAsyncMemoryFlushTest` |
| 快照是否防后续 mutation | ✅ 有专门测试 |
| 进程级 static scheduler | ⚠️ 全 JVM 共享 `1 worker + 3 queue`，跨 Agent 可能 reject |
| 队列满是否丢 flush | ⚠️ Reactor `RejectedExecutionException`，静默丢记忆 |
| 文档前后一致 | ❌ 「When flush fires」旧句未改 |
| patch coverage | ~66.67%，reject 路径缺测试（非阻塞） |

### 3.4 第四步：本地复现（独立 worktree，不动当前分支）

在 `upstream/main` 上建 worktree `../asj-pr2833-repro`，写最小复现测试 `MemoryFlushBlockingReproTest`：

```powershell
cd ../asj-pr2833-repro
mvn -pl agentscope-harness spotless:apply
mvn -pl agentscope-harness -am test -Dtest=MemoryFlushBlockingReproTest
```

两个用例均 **通过**，证实 main 上默认行为：

1. **Middleware 层**：下游事件已发出，流在 memory model 完成前不 `complete`
2. **HarnessAgent.call() 层**：主模型 instant 返回，flush 挂着时 `call()` pending；release flush 后才完成

这直接对应 Issue #2821 的用户体感。

---

## 4. PR 如何修复：`asyncFlush` 语义

### 4.1 配置方式

```java
HarnessAgent.builder()
    ...
    .memory(MemoryConfig.builder()
        .asyncFlush(true)
        .build())
    .build();
```

### 4.2 同步 vs 异步

| 模式 | 主回复 | flush | `call()` 返回 |
|------|--------|-------|---------------|
| 默认 `asyncFlush=false` | 先完成 | 同步等 flush LLM | flush 结束后 |
| `asyncFlush=true` | 先完成 | 后台 fire-and-forget | 主回复后立刻 |

### 4.3 bounded scheduler 与丢弃

```java
private static final Scheduler ASYNC_FLUSH_SCHEDULER =
        Schedulers.newBoundedElastic(1, 3, "memory-flush");
```

| 参数 | 含义 |
|------|------|
| `1` | 同时只跑 1 个 flush |
| `3` | 最多再排队 3 个 |
| **第 5 个及以后** | `RejectedExecutionException` → warn 日志 → **该轮记忆不写** |

这与 `StaticLongTermMemoryHook` 的 `long-term-memory-record` scheduler **完全同一套路**。

### 4.4 和 `flushTrigger.throttled(...)` 的区别

Review 讨论中还澄清了一个易混点：

| 配置 | 管什么 |
|------|--------|
| `asyncFlush(true)` | flush **还做不做**不变；只改 **等不等它跑完** |
| `flushTrigger.throttled(Duration)` | 改 **多久 flush 一次**；很多轮 **直接跳过** flush |

两者可同时使用：降频 + 后台跑，减轻队列压力。

---

## 5. Review 结论：已解决 vs 待讨论

### 已解决（值得 Approve）

| 项 | 结论 |
|----|------|
| Harness 无 async flush 配置 | ✅ `MemoryConfig.asyncFlush(true)` |
| 主回复被 flush 拖住 | ✅ 异步路径不 `concatWith` |
| 默认语义 | ✅ 不变 |
| 失败隔离 | ✅ 后台失败不打爆已完成响应 |
| 测试 | ✅ 覆盖 #2821 核心场景 |
| CI | ✅ 全绿 |

### 待讨论（不挡 merge）

#### A. 进程级 shared scheduler

static scheduler 意味着 **全 JVM 共用** 一条 flush 队列，不是按 Agent / workspace / user 隔离。

不同 Agent 通常 **不共用** 同一个 `MEMORY.md`（workspace + `IsolationScope` 已隔离文件路径），因此「串行写文件防冲突」**不足以**解释为什么要跨 Agent 共享队列。

更实际的风险：**Agent A 的慢 flush 占用 worker，Agent B 的 flush 被 reject**。

#### B. 异步 + 慢模型 → 可能 silently 丢记忆

开了 `asyncFlush` 且记忆模型慢、或短时间多轮结束时：

- 队列满 → reject → 对应轮 **`memory/YYYY-MM-DD.md` 没写入**
- 主回复已返回，用户无感
- 不是整个长期记忆系统失效，是 **漏掉被拒绝的那几轮**

单用户、正常节奏一般 OK；多 Agent 同进程、高频连发需警惕。

#### C. 文档不一致

`memory.md` 「When flush fires」仍写 flush 默认 fire-and-forget，与代码不符。PR 加了 Example 7，但没改旧句。

---

## 6. 与 qwen-code、gemini-cli 对照

排查过程中还对比了另外两个 coding agent 项目的长期记忆策略，帮助理解 AgentScope 这套设计的「行业位置」。

### 6.1 总览

| 项目 | per-turn 自动写长期记忆 | 默认是否异步 | 丢弃策略 |
|------|-------------------------|--------------|----------|
| **AgentScope Harness**（本 PR 前） | 有（flush LLM） | **否** | N/A |
| **AgentScope + asyncFlush** | 有 | opt-in 异步 | `1+3` 满则 **hard reject** |
| **qwen-code** | 有（Managed Auto-Memory extract） | **是** | 按 project **单飞 + trailing 合并**，少 hard reject |
| **gemini-cli** | **无** per-turn flush | turn 内工具同步写 MD；Auto Memory 在 **启动时** 异步 | skip / 节流，非 per-turn 队列 |

### 6.2 qwen-code：extract 是什么、怎么调度

qwen-code **没有** AgentScope 那种「同进程再调一次 flush LLM」的路径，而是 **Managed Auto-Memory**：turn 结束后 **fork 记忆抽取子 agent**，读对话和现有 memory 文件，用工具写 topic 文件，再重建 `MEMORY.md`。

```
用户一轮结束 (client.ts)
  → runManagedAutoMemoryBackgroundTasks()     // fire-and-forget，不阻塞主回复
  → MemoryManager.scheduleExtract()
  → runExtract() → runAutoMemoryExtract()
  → runAutoMemoryExtractionByAgent()          // fork 子 agent
  → 写 ~/.qwen/projects/<project>/memory/...
  → rebuildManagedAutoMemoryIndex()           // 重建 MEMORY.md
  → scheduleDream()                           // 可选 consolidation（另有一套门槛）
```

核心文件：

| 文件 | 职责 |
|------|------|
| `packages/core/src/core/client.ts` | turn 结束触发 `scheduleExtract` |
| `packages/core/src/memory/manager.ts` | 调度：单飞、trailing、skip |
| `packages/core/src/memory/extract.ts` | cursor 增量、调用子 agent |
| `packages/core/src/memory/extractionAgentPlanner.ts` | fork 子 agent 的 prompt 与执行 |

#### 6.2.1 调度策略（不是 Reactor `1+3 reject`）

`MemoryManager.scheduleExtract()` 按 **projectRoot** 维度的状态机，而不是全局 static scheduler：

| 机制 | 行为 |
|------|------|
| **每 project 单飞** | `extractRunning`：同一 project 同时只跑 1 个 extract |
| **Trailing queue depth=1** | 正在跑时又来请求 → 最多 **再保留 1 个** trailing；若已有 trailing，**用新 params 覆盖旧的**（supersede） |
| **跑完当前再拉 trailing** | `runExtract` 的 `finally` 调 `startQueuedExtract()`，把 trailing 拉起来 |
| **主 agent 已写 memory** | `historyWritesToMemory()` → skip（`memory_tool`） |
| **内存压力过高** | `memory_pressure` → skip |
| **Dream** | 24h + 5 sessions 门槛、`consolidation.lock` 互斥（与 extract 独立） |

和 AgentScope 的关键差别：

- AgentScope 异步 flush：**1 运行 + 3 排队，第 5 个 `RejectedExecutionException`** → 该轮 flush **完全不执行**
- qwen extract：**1 运行 + 1 个可覆盖的 trailing** → 高频连聊时中间几轮 **不各自开 extract**，但 **不会无声 reject 掉「再跑一次」的机会**

#### 6.2.2 为什么说 trailing 是「合并」而不是「丢弃」

extract 带 **cursor**（`extract-cursor.json`），记录：

- `sessionId`
- `processedOffset`：上次成功处理到 history 的第几条

每次 extract 检查 `history.slice(startOffset)` 里是否有 **新的 user 消息**；子 agent 读的是 **当前完整对话上下文**（session cache-safe params），不是某一截固定快照。

因此 trailing 跑起来时，params 里的 `history` 已是 **最新全量**。中间轮虽然没各自启动 extract，但内容会进 trailing 那一次。

**时间线示例**（extract 很慢，用户 10 秒内连聊 4 轮）：

| 时间 | 事件 | 调度状态 |
|------|------|----------|
| T0 | 第 1 轮结束 | **Extract #1 开始**（history 含 msg1） |
| T1 | 第 2 轮结束 | #1 还在跑 → **trailing 入队**（history msg1–2） |
| T2 | 第 3 轮结束 | #1 还在跑 → **覆盖 trailing**（history msg1–3） |
| T3 | 第 4 轮结束 | #1 还在跑 → **再覆盖 trailing**（history msg1–4） |
| T30 | Extract #1 结束 | `startQueuedExtract()` → **Trailing 开跑**（history 已是 msg1–4） |

结果：没有 4 次独立 extract，也没有第 4 次被 reject；而是 **#1 抽一轮 + trailing 用最新 history 补抽**。配合 cursor，设计目标是 **最终一致**，不是每轮即时落盘。

#### 6.2.3 与 AgentScope 异步 flush 对照

| | AgentScope `asyncFlush` | qwen-code extract |
|---|-------------------------|-------------------|
| 执行体 | 同 middleware 调 memory model | **fork 子 agent** 读文件 + 写文件 |
| 队列 | 进程级 `1+3`，满则 **reject** | 每 project `1+1 trailing`，**覆盖合并** |
| 被拒绝/合并时 | 该轮 flush **不执行** | 中间轮 **合并进 trailing** |
| 增量 | 每轮 complete 点快照 messages | **cursor** + 最新 history |
| 默认 | 同步（opt-in 异步） | **默认异步** |

这也是为什么 Review 里说 qwen 策略 **比 AgentScope 的 hard reject 温和**——不是 queue 满就抛异常丢掉唯一任务，而是 **「少跑几次，最后一次用最新对话补抽」**。

### 6.3 gemini-cli：无 turn-end flush

- 长期记忆靠 agent **回合内** `write_file` 改 `MEMORY.md` / `GEMINI.md`（同步）
- **Auto Memory** 在 CLI **启动时** 扫 idle session 做抽取，产出 inbox patch，需用户审核
- 没有 AgentScope 式「turn 结束再调一次模型写记忆」

### 6.4 对我们 Review 的启示

AgentScope 的 `asyncFlush` / ReAct 的 `longTermMemoryAsyncRecord` 属于 **「turn 边界 + 同进程 LLM + 硬限流队列」** 一派；qwen 是 **「turn 边界 + fork 子 agent + 按 project 单飞/trailing 合并」**；gemini 则 **根本不在 turn 边界做自动抽取**。

若业务不能接受 silently 丢记忆：

- AgentScope：要么别开 `asyncFlush`，要么改进 scheduler（按 isolation key 拆分、失败重试、更大队列）
- qwen：高频连聊接受「合并成 trailing 一次 extract」的延迟；极端情况下仍可能因 skip（memory_pressure、memory_tool 等）漏抽
- gemini：依赖 turn 内工具写 MD，或启动时 Auto Memory + 用户审核 inbox

---

## 7. 对话里澄清的几个概念

Review 过程中和作者/读者对齐的几个问题，一并记入：

### Q：是「两次 call()」吗？

**不是。** 用户只调一次 `call()`；框架内部串了两次 `model.stream()`（主回复 + flush）。

### Q：`asyncFlush` 只作用于第二次吗？

**是。** 只改 per-call flush 的完成语义；主 ReAct 仍同步走完。

### Q：opt-in 是什么意思？

默认 **`asyncFlush=false`**，行为和现在完全一样（仍同步等 flush）。只有显式 `.asyncFlush(true)` 才后台跑。

### Q：flush LLM 是什么？

对话结束后，**单独再问一次记忆模型**「这轮有什么该长期记住的」，写入日流水账；不是主回复本身。

---

## 8. FAQ

### Q：不开 `asyncFlush` merge 这个 PR 会变快吗？

**不会。** 默认行为不变，仍同步等 flush。

### Q：开了 `asyncFlush` 就一定丢记忆吗？

**不会必然丢。** 只有队列满（1 运行 + 3 排队，第 5 个起 reject）或进程立刻退出（`close()` 不 await）时才可能漏写。

### Q：和 `longTermMemoryAsyncRecord` 完全一样吗？

**思路对齐**（bounded 异步 + fire-and-forget），但 **存储与调度不同**：

- ReAct：`LongTermMemory.record()` + 进程级 `newBoundedElastic(1,3)`
- Harness flush：`MemoryFlushManager` → 日流水账 + 同样 `1+3` reject
- qwen extract：fork 子 agent + 每 project 单飞/trailing（见 §6.2）

### Q：qwen 的 extract 为什么「不太会丢」？

不是不会丢，而是 **丢法不同**：中间轮合并进 trailing，用最新 history 补抽；AgentScope 异步则是队列满 **hard reject**，该轮 flush 完全不跑。见 §6.2.2 时间线。

### Q：为什么文档写异步实现却是同步？

历史文档/注释滞后；`concatWith` 是 2.x harness 的实际行为。本 PR 的 Example 7 开始纠正，但旧段落仍待改。

---

## 9. 小结

| 阶段 | 要点 |
|------|------|
| 理解上下文 | 一次 `call()` = 主 LLM + flush LLM；Harness 无 async 开关 → #2821 |
| 根因 | 默认 `concatWith` 同步等 flush；文档误写 fire-and-forget |
| 修复 | opt-in `asyncFlush(true)` + 快照 + static bounded scheduler |
| 复现 | worktree + `MemoryFlushBlockingReproTest`，可控慢模型 |
| Review | 默认不变 ✅；shared scheduler ⚠️；文档 ⚠️；与 qwen/gemini 对照（§6：qwen extract 单飞/trailing vs AgentScope reject） |

这是一个 **「用户痛点清晰、默认保守、opt-in 加速」** 的 PR。修 #2821 的方向正确，测试到位；进程级 scheduler 与文档一致性适合作为 follow-up 继续讨论。

---

## 附录：关键文件索引

| 路径 | 说明 |
|------|------|
| `agentscope-harness/.../MemoryFlushMiddleware.java` | flush 同步/异步分支 |
| `agentscope-harness/.../MemoryConfig.java` | `asyncFlush` 配置 |
| `agentscope-harness/.../MemoryFlushManager.java` | flush LLM 调用与写文件 |
| `agentscope-harness/.../MemoryFlushMiddlewareCompletionTest.java` | PR 回归测试 |
| `agentscope-harness/.../HarnessAgentAsyncMemoryFlushTest.java` | 端到端 wiring 测试 |
| `agentscope-core/.../StaticLongTermMemoryHook.java` | ReAct 旧版异步记录参考实现 |
| `docs/v2/zh/docs/harness/memory.md` | 文档（含待修正段落） |
| `qwen-code/packages/core/src/memory/manager.ts` | qwen extract 调度（单飞/trailing） |
| `qwen-code/packages/core/src/memory/extract.ts` | qwen cursor + extract 执行 |
| `AS-java-pr/blog/.../MemoryFlushBlockingReproTest`（worktree） | 本地 main 复现（未进 PR） |
