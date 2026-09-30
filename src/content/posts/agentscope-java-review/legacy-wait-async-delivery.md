---
pubDatetime: 2026-08-22T08:00:00+08:00
modDatetime: 2026-09-30T12:00:00+08:00
title: "修复 legacy wait 丢失异步任务完成通知"
description: "复盘 AgentScope Java PR #2797：legacy wait_async_results 为何只盯 inbox，以及回退 TaskRepository 后仍未覆盖的 terminal-but-undelivered 缺口。"
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
> **PR**：[agentscope-ai/agentscope-java#2797](https://github.com/agentscope-ai/agentscope-java/pull/2797)（审查时仍为 **OPEN**）  
> **Issue**：[\#2791](https://github.com/agentscope-ai/agentscope-java/issues/2791)  
> **标题**：fix(harness): recover lost async task completions in legacy wait  
> **作者**：Daihonghui  
> **Review**：[xiaoyuuuuuupeng — Changes Requested](https://github.com/agentscope-ai/agentscope-java/pull/2797#pullrequestreview-5109570247)  
> **日期**：2026-09-04（Review）；2026-09-30 核对，PR 仍为 Open  

---

## 前言

这个 PR 动 2 个文件（约 +207 / -25），主战场是 `WaitAsyncResultsTool`。它针对 Issue #2791：异步子 agent 其实已经在 `TaskRepository` 里变成 terminal，但 **legacy `wait_async_results` 只盯 inbox 通知链**，任一环丢消息，主 agent 就会空等、撞上连续空 wait 预算，最后陷入「既拿不到结果、又不让再 wait」的硬停滞。

PR 的方向对：inbox 仍作快路径，丢通知时回退权威 `TaskRepository`，返回真实 result/error 并 `mark delivered`。审查当日我给的是 **Changes Requested**，不是 Approve——主路径有明显改进，但 #2791 的一条关键复现（**wait 开始前已 terminal、结果未 delivered**）仍被现有 snapshot 语义排除在外。

本文记录：权威状态与派生通知的差别、PR 改了什么、为什么还不能关 #2791，以及合并前建议补的 recover 顺序。

---

## 1. 先搞清上下文：两种 wait 语义

### 1.1 `wait_async_results` 的两条模式

| 模式 | 触发条件 | 意图 |
|------|----------|------|
| **legacy / ANY** | 不传 `task_ids`，且非 `wait_all` | 等「任意一个」完成通知，拿到结果就返回 |
| **barrier** | 显式 `task_ids` 或 `wait_all=true` | 等指定集合全部 terminal |

#2791 / 本 PR 动的是 **legacy ANY**。barrier 路径本来就会在 poll 里重读任务状态；legacy 却长期把「有没有 inbox 消息」当成「任务完没完」。

### 1.2 通知链 ≠ 任务状态

子任务完成时，理想链路是：

```text
subtask terminal
  → TaskRepository completionCallback
  → MessageBus inbox push
  → InboxMiddleware 在下一轮 LLM 前注入
  → 模型看到结果
```

`WaitAsyncResultsTool` 在 legacy 模式下还会每约 3s 轮询 `inboxHasMessages`。问题是：**这条链是派生信号，中间有多处可断**。

Issue 列出的典型断点：

- 另一次 `setCompletionCallback` 覆盖了 inbox push（字段赋值，非 listener 列表）
- `putTask` 与 callback 注册之间的竞态：任务已 terminal，回调永远不会触发
- inbox 消息被消费，但注入落到「需要它的那一轮」之后

权威事实在 `TaskRepository` 的 `TaskStatus.isTerminal()`。inbox 空，只说明「通知没到」，不说明「任务还在跑」。

### 1.3 `MAX_CONSECUTIVE_EMPTY_WAITS` 如何放大缺陷

连续空 wait 次数打到预算（常量为 2）后，工具拒绝再 wait，并引导模型去 `task_list` / `task_output(block=false)`。设计本意是防止模型滥用轮询；但在「通知链断、任务其实已完」时，**空 wait 是工具观察错误的症状**，拒绝 wait 只会把对话推进死胡同。

---

## 2. 旧代码有什么问题：只观察派生信号

### 2.1 legacy 轮询在看什么

修复前（示意）：

```text
wait_async_results (legacy)
  ├─ 可选：开始前看一眼是否还有 non-terminal
  └─ loop:
       if inboxHasMessages(sessionId) → 返回「结果将自动注入」类承诺
       else sleep ~3s
       until timeout / budget
```

对比 barrier：

```text
wait_async_results (barrier)
  └─ loop:
       对每个 taskId getTask / 检查 isTerminal
       全齐则 format 结果并返回
```

同一工具、两种模式，**观察对象不一致**。legacy 把「通知到达」当成「任务完成」；通知丢失时，工具无法区分「还在跑」和「已经跑完但没人告诉我」。

### 2.2 用户可见症状（无异常栈）

| 现象 | 说明 |
|------|------|
| 空等到满 timeout（常见 60s） | `TaskRepository` 已是 `COMPLETED`，inbox 空 |
| 连续空 wait 后硬拒绝 | 预算耗尽，对话无法靠 wait 前进 |
| 「会自动注入」的承诺落空 | 工具返回 side-channel 承诺，本轮注入链并未兑现 |

没有抛异常，所以排障要对照：**仓库状态 vs 工具返回文案 vs inbox 是否为空**。

---

## 3. PR 如何修复

### 3.1 设计摘要

PR 描述的兼容策略：

1. wait 开始时 **snapshot 当前 non-terminal** 任务集合  
2. **inbox 仍是第一快路径**  
3. 跟踪集合中的任务若在仓库里变成 terminal → **fallback 读 `TaskRepository`**  
4. 返回实际 result/error（含取消），并 **mark delivered**  
5. 保留 legacy ANY（一个完成即可返回）、不改 `task_ids` / `wait_all` barrier  

示意：

```text
legacy wait start
  waitSet = snapshotNonTerminalTaskIds(session)
  loop:
    if inboxHasMessages → fast path（保持原语义）
    else if findFirstTerminalIn(waitSet, TaskRepository) → formatTerminalResults + markDelivered
    else sleep / until timeout
```

方向正确：把权威状态拉回观察集合，inbox 降级为加速通道，而不是唯一正确性依赖。

### 3.2 测试面

PR 侧声称：

- 改生产代码前复现：核心回归会超时失败  
- `WaitAsyncResultsToolTest` 等合计多组用例通过（描述中 23 / 54）  
- Spotless 通过  

单测覆盖了：inbox 快路径、历史已完成任务的排除、失败/取消返回等。这些对「通知丢失但任务在 wait **期间**变 terminal」很有用。

---

## 4. Review：为什么是 Changes Requested

主 fallback 值得合入方向上的肯定；但审查时仍有 **一个会直接挡住「Fixes #2791」** 的缺口，外加两个会削弱正确性/性能声明的次要点。

### 4.1 缺口：wait 开始前已 terminal、结果未 delivered

PR 用 `snapshotNonTerminalTaskIds` **排除 wait 开始前已是 terminal 的任务**。动机可以理解：避免把「很久以前就完成、且早已 delivered」的历史任务再次吐给模型，破坏 ANY 语义。

但 #2791 的真实复现里，存在：

```text
任务已 terminal
结果尚未 delivered（inbox 推送丢了 / 回调被覆盖 / 注册竞态）
此时才进入 legacy wait
```

按当前 snapshot：

| 步骤 | 行为 | 结果 |
|------|------|------|
| 1 | 拍 non-terminal 快照 | 该任务 **不在 waitSet** |
| 2 | inbox 空 | 快路径无消息 |
| 3 | repository fallback 只扫 waitSet | **看不到** 这个已完成任务 |
| 4 | 若会话里已无其它 non-terminal | 工具可能报告「都完成了」却 **不返回丢失的结果** |

也就是说：通知丢失发生在 wait **之前**，本 PR 的 fallback **够不着**。Issue 标题里的 stall / 丢结果，这条路径仍在。

#### 建议修法

在拍 non-terminal snapshot **之前**，先 recover **terminal-but-undelivered**：

```text
1. findPendingDeliveries(session)（或等价 delivery 元数据）
2. 若有未投递的 terminal 结果 → 直接 format 返回并 mark delivered
3. 再 snapshotNonTerminalTaskIds，进入 inbox + repository 循环
```

仓库里已有 `findPendingDeliveries` / delivery 元数据，正好区分：

- 历史已投递 → 不应再返回  
- terminal 但未投递 → **正是 #2791 要救的结果**

没有这一步，PR 不宜宣称关闭 #2791。

### 4.2 consecutive-wait budget 耗尽会跳过 repository recovery

预算检查若仍排在 repository 恢复 **之前**，会出现：

```text
任务其实已 terminal（或可从 pending deliveries 恢复）
但工具先因 MAX_CONSECUTIVE_EMPTY_WAITS 拒绝 wait
→ 权威状态根本没机会被读到
```

建议：在 legacy 的内联预算检查**拒绝之前**，先咨询 `TaskRepository` / pending deliveries；有可交付结果就返回，而不是直接拒绝。`rejectIfWaitBudgetExhausted` 是 barrier 路径的 helper，本文指出的缺口在 legacy 路径。

否则「观察权威状态」的修复，会在预算边界再次塌回旧行为。

### 4.3 初始 repository snapshot 抢在首次 inbox check 前

PR 声称 inbox 是 fast path，但若 wait 入口先做一次完整 `listTasks`（或等价全量扫描）再碰 inbox：

- repository / workspace 抖动时，**快路径被拖慢甚至失败**  
- 「inbox 优先」在延迟与故障域上不成立  

更稳的顺序：

```text
1. 先 inboxHasMessages；有消息则走原快路径，不依赖 repository
2. inbox 空时 recover terminal-but-undelivered（见 4.1）
3. 无可交付结果时再检查 wait budget
4. 再建立 waitSet，进入带 repository fallback 的 loop
```

全量 `listTasks` 放在每 tick 里也有成本问题（maintainer bot 也提到可用 `getTask` 点查替代 `waitSet × tasks` 二重扫描）；那是优化项。审查优先项是：**不要让 snapshot 破坏 inbox 快路径的故障隔离**。

---

## 5. 如何排查与本地验证

### 5.1 Review 检查清单

| 检查项 | 审查日结论 |
|--------|------------|
| legacy 是否在 poll 中回退 `TaskRepository` | ✅ 方向对 |
| 是否返回真实 result/error 并 mark delivered | ✅ |
| ANY / `wait_all` / `task_ids` 语义是否保持 | ✅ 声明合理 |
| wait 前 terminal-but-undelivered 是否可恢复 | ❌ 被 non-terminal snapshot 排除 |
| budget 耗尽前是否仍尝试 recovery | ❌ / 存疑，需补 |
| inbox 是否在 repository 全量工作之前真正优先 | ⚠️ snapshot 时机不当 |

### 5.2 建议补的回归（最小）

确定性场景，不依赖真实 LLM：

```text
1. 写入一个 COMPLETED 且 undelivered 的 TaskRecord
2. inbox 保持为空
3. 调用 legacy wait_async_results（无 task_ids）
4. 断言：返回该任务结果，且 delivered 被标记
5. 再 wait 一次：不应重复返回已投递历史任务
```

另两条：

- 连续空 wait 已耗尽预算，但仓库里有可交付 terminal → 应返回结果，而非 budget 拒绝文案  
- inbox 已有消息时，即使强制 `listTasks` 抛错，快路径仍应成功（证明 inbox 故障隔离）

### 5.3 本地命令（合入修复后）

```powershell
git fetch upstream pull/2797/head:pr-2797
git checkout pr-2797

mvn -q install -DskipTests
mvn -pl agentscope-harness -q test `
  "-Dtest=WaitAsyncResultsToolTest,WorkspaceTaskRepositoryTest,WorkspaceTaskRepositoryDeliveryTest"
```

---

## 6. 遗留风险与范围外项

即使补上 4.1–4.3，仍建议心里有数：

| 风险 | 说明 |
|------|------|
| callback 覆盖 | `setCompletionCallback` 仍是单字段赋值；治本应改 listener 列表（Issue 次要建议） |
| 单次 snapshot | wait 开始后新 spawn 的子任务不在 waitSet；超时可能「眼看着完成却等不到」——若属有意，应在 Javadoc 写清 |
| timeout 精度 | deadline 检查位于 probe 之后，最后一轮可能超出调用方 timeout 一轮 probe 的耗时；并非固定多等 3s |
| barrier 与 legacy 双轨 | barrier 已更接近正确语义；长期是否收敛两条路径，是产品决策，不是本 PR 必须一次做完 |

本 PR 的合理范围：**legacy 丢通知时能靠仓库自救**。审查要求的是：自救集合必须覆盖 **undelivered terminal**，不能只用 non-terminal snapshot 偷懒。

---

## 7. Review 结论

### 7.1 已改进 ✅

- 承认 inbox 是派生信号，引入 `TaskRepository` fallback  
- 保留 inbox 快路径与 legacy ANY / barrier 兼容面  
- 返回真实 terminal 结果并 mark delivered，避免空洞承诺  
- 测试开始钉住「wait 期间变 terminal」类丢失

### 7.2 阻塞项与另外两条建议 ⚠️

1. **阻塞项**：先 recover terminal-but-undelivered（`findPendingDeliveries`），再拍 non-terminal snapshot  
2. **次要建议**：budget 耗尽前仍尝试 repository / pending recovery  
3. **次要建议**：inbox 快路径不要被入口处的 repository snapshot 拖慢或导致失败  

### 7.3 最终表态

**Changes Requested** — 回退权威仓库是对的，也明显缓解「wait 过程中完成但通知丢失」；但 #2791 仍包含「完成发生在 wait 之前且未投递」的路径，当前实现会报完成却不交回丢失结果。先补 terminal-before-wait 的阻塞缺口，并评估 budget/inbox 两条建议，再谈 Approve 与关闭 Issue。

审查意见要点（当日）：

> Falling back to authoritative TaskRepository state is the right direction.  
> A task that becomes terminal before legacy wait starts is excluded from the non-terminal snapshot, even when its result has not been delivered.  
> Please recover terminal-but-undelivered tasks before taking the non-terminal snapshot.  
> Repository recovery is bypassed after the consecutive-wait budget is exhausted;  
> the initial repository snapshot runs before the first inbox check.

---

## 8. 小结

| 阶段 | 要点 |
|------|------|
| 上下文 | legacy wait 盯 inbox；权威状态在 `TaskRepository` |
| 根因 | 观察派生通知；链断则空等 + 预算硬拒绝 |
| PR 做法 | non-terminal snapshot + inbox 快路径 + 仓库 fallback + mark delivered |
| Review | 方向 ✅；wait 前 undelivered terminal ❌；budget / snapshot 顺序 ⚠️ |
| 建议 | `findPendingDeliveries` 先行；拒绝前再读仓库；inbox 真正优先 |
| 状态 | OPEN + Changes Requested（以 GitHub 为准） |

这是一篇「主路径值得做、Issue 关闭条件还没满足」的审查记录。合入价值在于把正确性从 side-channel 拉回任务状态；在补齐 terminal-but-undelivered 之前，不宜把 #2791 标成已修复。

---

*相关 Issue：[#2791](https://github.com/agentscope-ai/agentscope-java/issues/2791)*  
*PR（审查时未合并）：[#2797](https://github.com/agentscope-ai/agentscope-java/pull/2797)*
