---
pubDatetime: 2026-09-07T08:00:00+08:00
modDatetime: 2026-09-08T08:00:00+08:00
title: "AgentScope Java Review 系列"
description: "五次真实 AgentScope Java PR 审查：从复现、调用链追踪和测试验证，到明确可合并范围与后续风险。"
author: "xiaoyuuuuuupeng"
featured: true
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

这个系列整理了五次 AgentScope Java PR Review。重点不是复述 diff，而是记录一套可复用的方法：先建立真实调用链，再构造失败场景，核对修复边界与测试，最后把“本 PR 已解决”和“适合 follow-up”分开。

> 文章是对应审查日期的技术快照。PR 状态与代码可能继续变化，请以各篇文首的 GitHub 链接为准。

## 系列文章

1. [Harness Shell 管道死锁：并发 drain 与输出生命周期](/posts/agentscope-java-review/localfilesystem-pipe-deadlock/)
2. [Sandbox Fallback：并发调用下的绑定与释放](/posts/agentscope-java-review/sandbox-fallback-lifecycle/)
3. [Harness 异步 Memory Flush：响应延迟与丢弃语义](/posts/agentscope-java-review/harness-async-memory-flush/)
4. [Sandbox Task Record：跨 call 的持久化路由](/posts/agentscope-java-review/sandbox-task-record-routing/)
5. [声明式 Subagent 的 Hook 继承：治理能力与工具白名单](/posts/agentscope-java-review/declared-subagent-hook-inheritance/)

## 阅读地图

| 主题          | 核心问题                         | Review 关注点                   |
| ------------- | -------------------------------- | ------------------------------- |
| 进程与 IO     | 子进程输出填满管道后互相等待     | 并发读取、超时回收、内存上限    |
| Sandbox 并发  | 多个 call 共享 fallback 生命周期 | acquire/release 顺序、隔离边界  |
| 异步记忆      | 主响应被第二次模型调用拖慢       | 有界队列、失败隔离、关闭语义    |
| Task Record   | call 结束后后台线程无法访问记录  | 路由边界、host 持久化、回归测试 |
| Subagent Hook | 声明式子 Agent 绕过父级 Hook     | 创建路径、Hook 工具、白名单边界 |

截至 2026-09-08，[#2803](https://github.com/agentscope-ai/agentscope-java/pull/2803) 和 [#2839](https://github.com/agentscope-ai/agentscope-java/pull/2839) 已合并；[#2833](https://github.com/agentscope-ai/agentscope-java/pull/2833)、[#2854](https://github.com/agentscope-ai/agentscope-java/pull/2854) 和 [#2996](https://github.com/agentscope-ai/agentscope-java/pull/2996) 仍为 Open。
