---
pubDatetime: 2026-09-02T08:00:00+08:00
title: "一次 Sandbox 下 Task Record 维护失败 PR 的排查与 Review 实录"
description: "梳理 call 生命周期外的任务记录读写，验证 host workspace 路由、后台维护线程与回归测试。"
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
>
> 更新：PR #2803 已于 2026-09-05 合并。
> **PR**：[agentscope-ai/agentscope-java#2803](https://github.com/agentscope-ai/agentscope-java/pull/2803)  
> **Issue**：[#2743](https://github.com/agentscope-ai/agentscope-java/issues/2743)  
> **标题**：fix(harness): route task records around the per-call sandbox proxy  
> **作者**：birdie7761  
> **Review**：LGTM（包含整体意见与逐文件备注）  
> **日期**：2026-09-02  

---

## 前言

这个 PR 动 5 个文件（约 +357 / -4），其中生产逻辑大约只有 **49 行**，其余是测试与 Javadoc。CI 全绿，合并准备度很高，却卡在「还没有人类 Review」。

它修的问题不那么「用户一眼能看出来」：不是主回复卡住，而是 **sandbox 模式下，agent call 已经结束之后，后台任务台账读写全部失败**——心跳刷不了、孤儿任务标不成 FAILED、迟到启动的异步任务甚至读不到自己的 record。

本文记录：我们如何理解 Task Record 与 Sandbox 的生命周期差异、bug 到底在哪个时间点发生、本地如何复现、PR 如何把 `agents/.../tasks/*.json` 从 sandbox 容器改写到 host workspace，以及 Review 时核对过的路由边界。

---

## 1. 先搞清上下文：两套生命周期叠在一起

要理解 #2743，先分清两样东西。

### 1.1 Task Record 是什么？

Task Record 是 **后台任务的持久化台账**，落在 workspace 相对路径：

```
agents/<agentId>/tasks/<sessionId>.json
```

JSON 里是 `taskId → TaskRecord` 的 map，字段包括状态（`PENDING` / `RUNNING` / `COMPLETED` / `FAILED`）、结果、错误信息、`lastUpdatedAt` 等。

它的作用：

| 用途 | 说明 |
|------|------|
| 跨 call 查状态 | Agent 已回复用户，后台任务可能还在跑 |
| 跨节点可见 | 配了 `RemoteFilesystemSpec` 时，别的节点也能读 |
| 孤儿检测 | sweeper 靠 `lastUpdatedAt` 判断「是不是没人管了」 |
| 取消 / 完成回调 | cancel 标志、terminal 状态都写在这里 |

内存里的 `BackgroundTask`（`CompletableFuture`）只是本机缓存；**Task Record 才是权威真相来源**。

### 1.2 Sandbox 是什么？`SandboxBackedFilesystem` 又是什么？

Sandbox 是 **每次 agent call 期间临时租用的隔离执行环境**（常见是容器）。Agent 在里面读写代码、跑 shell——安全、隔离。

`SandboxBackedFilesystem` 可以理解成 **沙箱文件系统的代理**：

```
Agent 想读写的文件
        │
        ▼
SandboxBackedFilesystem（进程内常驻代理）
        │  转发给
        ▼
Sandbox（临时容器）
        │
        ▼
容器内 /workspace/... 文件
```

生命周期由 `SandboxLifecycleMiddleware` 管：

```
acquireForCall()  → 注入 live sandbox
  … agent call …
releaseForCall()  → sandbox = null（代理还在，会议室钥匙没了）
```

类比：

| 概念 | 类比 |
|------|------|
| Host workspace | 公司办公室文件柜（一直在） |
| Sandbox | 临时租的会议室（call 期间开，call 结束锁门） |
| SandboxBackedFilesystem | 会议室的钥匙（没会议室就打不开） |

### 1.3 后台还有谁在读写 Task Record？

`WorkspaceTaskRepository` 启动时（生产环境）会开：

```
① 任务执行线程池（ws-task-*）
   └── 真正跑异步 LocalTask / RemoteTask

② 定时调度线程（ws-task-maint-*）
   ├── 每 30 秒：heartbeat → 刷新 RUNNING 的 lastUpdatedAt
   └── 每 5 分钟：orphan sweeper → 超时没心跳则标 FAILED
```

**关键矛盾**：Task Record 是 **跨 call** 的编排元数据；Sandbox 是 **per-call** 的。维护线程和迟到启动的任务，往往跑在 **call 已经结束、sandbox 已经释放** 之后。

```
时间 ──────────────────────────────────────────────────────────►

     │◄── Agent Call ──►│                    │
     │  sandbox 活着     │  sandbox = null    │  后台线程还在跑
     │                   │                    │
  acquireForCall    releaseForCall      heartbeat / sweeper / 任务线程
                         ↑
                    【问题从这里开始】
```

---

## 2. 旧代码有什么问题：三种失败模式

配置了 sandbox filesystem 时，`WorkspaceManager` 读写 Task Record 会走：

```
WorkspaceManager
  → SandboxBackedFilesystem.read / upload / glob
  → 要求 live sandbox
  → call 外：SandboxConfigurationException("No active sandbox …")
```

也就是说，旧代码把 task JSON **当成普通 agent 工作文件**，错误地一起推进了 sandbox 容器。

### 2.1 Orphan sweeper（每 5 分钟）

`listAllTaskRecords` 里无保护地调用 `filesystem.glob()` → 抛异常 → 整轮 sweep abort。

结果：**真正孤儿任务永远标不成 `FAILED`**。

### 2.2 Heartbeat（每 30 秒）

`updateStatus` → `persistTaskMap` 走 sandbox FS → 异常被 `heartbeat()` 的 `catch` 打成 `debug` 吞掉。

结果：**任务其实还在跑，但 `lastUpdatedAt` 永不刷新**（看起来像静默失败）。

### 2.3 Async local task 迟到启动

上一个 call 提交了任务，call 结束释放 sandbox 后，线程池里的 supplier 才开始跑。第一步就要 `readTaskRecord` → 同样抛。

结果：**任务根本启动不了**（测试里的 `task supplier never started`）。

### 2.4 一个具体时间线

```
10:00  用户：「帮我跑个耗时任务」
10:00  Agent call 开始，sandbox 启动
10:01  putTask → Task Record 写成 RUNNING（此时可能成功）
10:02  Agent 回复「好的，已在后台运行」→ call 结束，sandbox 释放
10:02  任务还在跑……
10:02:30  heartbeat 想更新 lastUpdatedAt → ❌ 写失败
10:07  sweeper 想扫孤儿 → ❌ glob 失败
10:12  record 里 lastUpdatedAt 还是 10:01；sweeper 也读不到 → 状态卡在 RUNNING
```

### 2.5 这不是「进程挂了」

需要把两种场景分开：

| 场景 | sweeper 能跑吗 | 旧代码能标 FAILED 吗 |
|------|---------------|---------------------|
| 整个 JVM crash | ❌ 不能 | ❌ 不能（另一类问题：要靠多节点 / 重启） |
| 进程活着，call 结束，sandbox 释放 | ✅ 能跑 | ❌ **不能（#2743 / 本 PR）** |

PR 修的是第二种：**进程还活着、维护线程也在跑，但因为 sandbox 已释放而读写失败**。

---

## 3. 如何排查：我们的 Review 步骤

### 3.1 第一步：读 Issue + PR 描述，对齐问题定义

从 [#2743](https://github.com/agentscope-ai/agentscope-java/issues/2743) 和 [#2803](https://github.com/agentscope-ai/agentscope-java/pull/2803) 确认：

- 根因是 **per-call sandbox proxy** 与 **cross-call task metadata** 生命周期不匹配
- 修复边界：只改 Task Record 的读 / 写 / glob，不改 agent 在 call 内对代码文件的 sandbox IO
- 显式 prefix route（例如 `agents/` 挂持久 backend）必须继续尊重，不能 silent fallback 到 host

### 3.2 第二步：读 diff 核心几处

| 文件 | 改动 |
|------|------|
| `WorkspaceManager.java` | `taskRecordsRouteToLiveSandbox` + 读/写/glob 三处分支（核心） |
| `CompositeFilesystem.java` | 新增 `filesystemFor(path)` |
| `RoutedSandboxFilesystem.java` | 新增 `backendFor(path)` |
| `WorkspaceTaskRepository.java` | Javadoc 补充 sandbox 行为 |
| `WorkspaceTaskRepositorySandboxMaintenanceTest.java` | 3 个回归用例（+305） |

判定逻辑：

```java
private boolean taskRecordsRouteToLiveSandbox(String relPath) {
    AbstractFilesystem fs = this.filesystem;
    if (fs instanceof RoutedSandboxFilesystem routed) {
        fs = routed.backendFor(relPath);
    }
    return fs instanceof SandboxBackedFilesystem;
}
```

设计要点：

- 只匹配 **`SandboxBackedFilesystem`**，不是 `AbstractSandboxFilesystem`——避免误伤只提供 `execute()` 的持久 backend
- 通过 `backendFor` 尊重最长前缀 route

### 3.3 第三步：画出两条路径

```
agents/<agentId>/tasks/<sessionId>.json
                │
                ▼
    taskRecordsRouteToLiveSandbox(rel)?
                │
       ┌────────┴────────┐
       │ YES             │ NO
       ▼                 ▼
  Host workspace    原有 filesystem 路径
  (readFileQuietly  (readWithOverride /
   / writeLocalFile) writeUtf8WorkspaceRelative)
                         │
                         ▼
              例：agents/ 有显式 persistent route
              → MapFs / RemoteFS 等仍服务该路径
```

逻辑路径字符串 **不变**，变的是 **物理写到哪里**：

| | 修复前 | 修复后（sandbox proxy 命中时） |
|---|--------|-------------------------------|
| 路径 | `agents/.../tasks/sess.json` | 同一个相对路径 |
| 落盘 | 试图写进 **sandbox 容器** | 写进 **host workspace 根目录下同名文件** |

「和没配 sandbox filesystem 时一样」：当 `filesystem == null` 时，本来就走 `writeLocalFile`；本 PR 让 sandbox 模式下的 Task Record **也走这条 host 直写路径**。

### 3.4 第四步：重点检查清单

对照 ranking 里的 20 分钟 Review 清单：

| 检查项 | 结论 |
|--------|------|
| 最长前缀 route 不被 host fallback 绕过 | ✅ `backendFor` + 第 3 个测试 |
| 读路径校验 | ✅ host 读仍 `requireSafeRelativePath` |
| 写路径校验 | ✅ `writeLocalFile` 有 `startsWith(workspace)` |
| 锁语义 | ✅ 仍经 `pathLocks` / `readTaskMapLocked` |
| `HarnessAgent` 实际组装形态 | ✅ 裸 `SandboxBackedFilesystem` 或 `RoutedSandboxFilesystem`，都能命中 |
| `RemoteFilesystemSpec` | ✅ backend 不是 sandbox proxy，走原路径 |
| 文档 checklist 未勾 | ⚠️ 内部路由修复，可接受 |

### 3.5 第五步：本地复现

```powershell
cd agentscope-java
gh pr checkout 2803 --repo agentscope-ai/agentscope-java
# 分支：fix/2743-sandbox-task-record-maintenance

cd agentscope-harness
mvn test -Dtest=WorkspaceTaskRepositorySandboxMaintenanceTest
```

结果：**3/3 通过**。

测试用 **从未注入 sandbox 的 `SandboxBackedFilesystem`** 模拟 call 外状态，并把 record seed 在 host `@TempDir` 上——这正是 `releaseForCall` 之后的现实。

| 测试 | 验证点 |
|------|--------|
| `orphanSweep_marksOrphanFailed_outsideCallContext` | sweeper 能把 stale RUNNING 标 FAILED |
| `heartbeat_refreshesLastUpdatedAt_outsideCallContext` | async supplier 能启动 + heartbeat 能刷新时间戳 |
| `routedPersistentBackend_stillServesTaskRecords` | 显式 `agents/` route 时不 silent 落到 host |

PR 描述里的 TDD 证据：前两个用例在 main 上是红的（`expected FAILED but was RUNNING` / `task supplier never started`），修完变绿。

---

## 4. PR 如何修复：绕过 per-call sandbox proxy

### 4.1 三处 IO 入口统一分支

1. **`readTaskMap`**：sandbox proxy → `readFileQuietly(workspace.resolve(requireSafeRelativePath(rel)))`
2. **`persistTaskMap`**：sandbox proxy → `writeLocalFile(rel, serialized)`（atomic temp→rename）
3. **`listAllTaskRecords`**：sandbox proxy → **跳过** `filesystem.glob()`，只靠 host `Files.list` 枚举（原有 union 的下半段）

配套暴露查询 API（零行为变更）：

- `CompositeFilesystem.filesystemFor(path)`
- `RoutedSandboxFilesystem.backendFor(path)` → 委托 composite

### 4.2 Call 内 vs Call 外

| 场景 | Agent 读写代码 / 跑脚本 | Task Record |
|------|-------------------------|-------------|
| Call 内 | 仍走 sandbox 容器 | 走 host（本 PR 后一致） |
| Call 外 | sandbox 不可用 | 走 host，heartbeat / sweeper 正常 |

Call 内也把 Task Record 落到 host，是 **有意为之**：否则 call 内写进容器、call 外维护线程在 host 上读，会立刻出现「写了找不到」。跨 call 的元数据从一开始就不该进临时容器。

### 4.3 一张图总结

```
                    agents/test-agent/tasks/sess.json
                              │
              ┌───────────────┴───────────────┐
              │                               │
        Agent call 内                   Agent call 外
    （读写代码、跑脚本）              （heartbeat / sweeper）
              │                               │
              ▼                               ▼
      SandboxBackedFilesystem          PR 修复后：
      → sandbox 容器内文件              直接写 host workspace
      （临时、call 结束就没了）         （持久、进程活着就能读写）
```

---

## 5. Review 结论：已解决 vs 非阻塞备注

### 已解决（值得 Approve）

| 项 | 结论 |
|----|------|
| call 外 orphan sweeper 失败 | ✅ 跳过 sandbox glob + host 落盘 |
| call 外 heartbeat 静默失败 | ✅ host `writeLocalFile` |
| async task 起不来 | ✅ host `readTaskMap` |
| 显式 `agents/` persistent route | ✅ `backendFor` + 契约测试 |
| 路径安全 / 锁 | ✅ 读校验 + write 边界 + per-file lock |
| 测试证据 | ✅ TDD red→green，三场景锁定 |
| CI | ✅ License / Module Sync / ubuntu / windows / codecov patch 全绿 |

### 非阻塞（不挡 merge）

#### A. `persistTaskMap` 写侧与读侧略不对称

读 host 分支显式 `requireSafeRelativePath`；写 host 分支直接 `writeLocalFile(rel)`。  
`rel` 来自 `taskRecordPath`，且 `writeLocalFile` 有 `startsWith(workspace)`，风险很低——可记作 nit。

#### B. 文档 checklist 未勾

本次是内部路由修复，Javadoc 已补；公开文档未更新可接受。

#### C. 进程 crash 仍不在本 PR 范围

JVM 挂了 → `ws-task-maint` 也没了 → 本机 sweeper 跑不了。那要靠多节点共享存储上的 sweeper，或进程重启后的扫描。本 PR 正确收窄在「进程活着但 sandbox 已释放」。

---

## 6. 对话里澄清的几个概念

排查过程中反复对齐的问题，一并记入：

### Q：是不是用户 call 以后会开一个线程专门维护 Task Record？

**大方向对。** 更精确地说是两类后台活动：

1. **任务执行线程**：跑 `LocalTaskRunSpec` 的 supplier，读写 Task Record 更新状态  
2. **维护定时线程**：heartbeat（30s）+ orphan sweeper（5min）

两者都可能在 call 结束后继续碰 Task Record。

### Q：Sandbox 情况下 call 结束、sandbox 释放后，维护线程就会写失败？

**是（旧代码）。** 走 `SandboxBackedFilesystem` 就会抛 `No active sandbox`；heartbeat 被 debug 吞掉，sweeper 的 glob 直接 abort。

### Q：改写到 host 的文件是不是 `agents/<agentId>/tasks/<sessionId>.json`？

**是。** 相对路径不变；从「写进 sandbox 容器里的同名路径」改成「写进 host workspace 根下的同名路径」。

### Q：`SandboxBackedFilesystem` 是干什么的？

把文件 / shell 操作转发给 **临时 sandbox** 的代理。适合 call 内的隔离执行；**不适合**跨 call 的编排元数据。

### Q：orphan sweeper 每 5 分钟，但进程停了还是标不了 FAILED？

**对。** 进程没了就没人跑 sweeper。那是另一类可靠性问题；本 bug 是 **进程还在、sweeper 也触发了，但 IO 失败**。

---

## 7. FAQ

### Q：没开 sandbox 会中招吗？

**不会。** `filesystem == null` 时本来就写 host；Remote / 其它非 `SandboxBackedFilesystem` backend 也不会命中 `taskRecordsRouteToLiveSandbox`。

### Q：Agent 在 call 里改代码还会进 sandbox 吗？

**会。** 本 PR 只特判 Task Record 三条路径；call 内普通文件 IO / `execute` 仍走 sandbox。

### Q：如果配置了 `agents/` 显式持久化路由呢？

Task Record **继续走那个持久 backend**，不会 silent 落到 host。第三个测试专门锁这个契约。

### Q：修完以后旧的「只在 sandbox 容器里」的 task JSON 怎么办？

旧路径在 call 之间本来就读不到（这也是 bug 本身）。修复后新写入统一在 host（或显式 route）；没有复杂迁移逻辑，范围合理。

### Q：生产改动真的只有几十行吗？

**是。** 核心在 `WorkspaceManager` 的判定 + 三处分支；`filesystemFor` / `backendFor` 是薄封装；大头是回归测试。

---

## 8. Review 时可粘贴的评论骨架

（完整英文稿见 [`2026-09-02-2803-review-comments-draft.md`](./2026-09-02-2803-review-comments-draft.md)）

**整体 Approve 要点**：根因匹配、三入口都改到、route 契约有测试、本地 + CI 绿、一个非阻塞 nit（写侧 `requireSafeRelativePath`）。

**逐文件要点**：

| 文件 | 评论角度 |
|------|----------|
| `CompositeFilesystem` | 零行为变更暴露路由查询 |
| `RoutedSandboxFilesystem` | `backendFor` 防止误判显式 mount |
| `WorkspaceTaskRepository` | Javadoc 说明「不进 sandbox」例外 |
| `WorkspaceManager` | 只匹配 `SandboxBackedFilesystem`；glob 守卫；读安全；写 nit |
| Test | outside-call 建模准；latch 双职责；routed contract 锁回归风险 |

---

## 9. 小结

| 阶段 | 要点 |
|------|------|
| 理解上下文 | Task Record 跨 call；Sandbox per-call；维护线程在 call 外跑 |
| 根因 | Task JSON 错误走 `SandboxBackedFilesystem`，call 外抛 `No active sandbox` |
| 三种失败 | sweeper abort / heartbeat 静默失败 / async supplier 起不来 |
| 修复 | 命中 sandbox proxy 时 Task Record 改写 host（与 `filesystem==null` 同路径） |
| 边界 | 显式 `agents/` route 仍优先；普通 agent 文件仍走 sandbox |
| 复现 | `WorkspaceTaskRepositorySandboxMaintenanceTest`，3/3 绿 |
| Review | LGTM；非阻塞 nit 写侧 path normalize；文档 checklist 可接受 |

这是一个 **「生命周期边界画清楚、改动面极小、测试把三种失败模式钉死」** 的 PR。方向正确，适合作为 Harness committer 练习「先对齐概念再读 diff」的范例。

---

## 附录：关键文件索引

| 路径 | 说明 |
|------|------|
| `agentscope-harness/.../workspace/WorkspaceManager.java` | Task Record 路由判定与三处 IO 分支 |
| `agentscope-harness/.../filesystem/CompositeFilesystem.java` | `filesystemFor` |
| `agentscope-harness/.../filesystem/RoutedSandboxFilesystem.java` | `backendFor` |
| `agentscope-harness/.../filesystem/sandbox/SandboxBackedFilesystem.java` | per-call proxy；`requireSandbox` 抛错处 |
| `agentscope-harness/.../middleware/SandboxLifecycleMiddleware.java` | `acquireForCall` / `releaseForCall` |
| `agentscope-harness/.../subagent/task/WorkspaceTaskRepository.java` | heartbeat / sweeper / putTask |
| `agentscope-harness/.../subagent/task/TaskRecord.java` | 台账字段定义 |
| `agentscope-harness/.../subagent/task/WorkspaceTaskRepositorySandboxMaintenanceTest.java` | PR 回归测试 |
| `agentscope-harness/.../HarnessAgent.java` | 组装 `SandboxBackedFilesystem` / `RoutedSandboxFilesystem` |
| `AS-java-pr/2026-09-01-harness-pr-ranking.md` | 本 PR 的 20 分钟 Review 清单 |
| Review 评论草稿 | 未纳入本系列公开文章 |
