---
pubDatetime: 2026-09-07T08:00:00+08:00
modDatetime: 2026-09-30T12:00:00+08:00
title: "AgentScope Java Review 系列"
description: "AgentScope Java PR 审查：从复现、调用链追踪和测试验证，到明确可合并范围与后续风险。"
author: "Xiaoyu"
featured: true
draft: false
tags:
  - agentscope-java-review
  - AgentScope
  - Java
  - Code Review
---

AgentScope Java PR Review


## 系列文章

### 进程 / IO / 异步

1. [Harness Shell 管道死锁：并发 drain 与输出生命周期](/posts/agentscope-java-review/localfilesystem-pipe-deadlock/)
2. [Harness 异步 Memory Flush：响应延迟与丢弃语义](/posts/agentscope-java-review/harness-async-memory-flush/)
3. [legacy wait 丢失异步完成通知：inbox 与 TaskRepository](/posts/agentscope-java-review/legacy-wait-async-delivery/)

### Sandbox 并发与路由

4. [Sandbox 按 call 绑定隔离：跨 session 单槽踩踏](/posts/agentscope-java-review/sandbox-per-call-binding/)
5. [Sandbox Fallback：并发调用下的绑定与释放](/posts/agentscope-java-review/sandbox-fallback-lifecycle/)
6. [Sandbox Task Record：跨 call 的持久化路由](/posts/agentscope-java-review/sandbox-task-record-routing/)

### Subagent 配置继承

7. [声明式 Subagent 的 Hook 继承：治理能力与工具白名单](/posts/agentscope-java-review/declared-subagent-hook-inheritance/)
8. [声明式 Subagent 的独立 Compaction 配置](/posts/agentscope-java-review/subagent-compaction-config/)

### Workspace / State / Tracing

9. [Prompt 暴露正确的 Session Workspace 路径](/posts/agentscope-java-review/session-workspace-prompt/)
10. [迁移 version=0 行上的幽灵 CAS 冲突](/posts/agentscope-java-review/state-version0-phantom-cas/)
11. [Tracing Middleware 支持应用自有 OpenTelemetry SDK](/posts/agentscope-java-review/otel-app-owned-sdk/)

## 阅读地图

| 主题 | 核心问题 | Review 关注点 | PR |
| --- | --- | --- | --- |
| 进程与 IO | 子进程输出填满管道后互相等待 | 并发读取、超时回收、内存上限 | [#2839](https://github.com/agentscope-ai/agentscope-java/pull/2839) Merged |
| 异步记忆 | 主响应被第二次模型调用拖慢 | 有界队列、失败隔离、关闭语义 | [#2833](https://github.com/agentscope-ai/agentscope-java/pull/2833) Open |
| legacy wait | inbox 丢通知后永久等不到结果 | TaskRepository 回退、undelivered 恢复 | [#2797](https://github.com/agentscope-ai/agentscope-java/pull/2797) Open |
| Sandbox 绑定 | 跨 session 共享 agent 级单槽 | per-call RuntimeContext、release 归属 | [#2675](https://github.com/agentscope-ai/agentscope-java/pull/2675) Merged |
| Sandbox Fallback | context-free 读者仍踩单槽 | acquire/release 顺序、隔离边界 | [#2854](https://github.com/agentscope-ai/agentscope-java/pull/2854) Open |
| Task Record | call 结束后后台线程无法访问记录 | 路由边界、host 持久化 | [#2803](https://github.com/agentscope-ai/agentscope-java/pull/2803) Merged |
| Subagent Hook | 声明式子 Agent 绕过父级 Hook | 创建路径、Hook 工具、白名单 | [#2996](https://github.com/agentscope-ai/agentscope-java/pull/2996) Open |
| Compaction | 声明式子 Agent 无法独立配置压缩 | YAML 三态、校验与继承链 | [#2378](https://github.com/agentscope-ai/agentscope-java/pull/2378) Open |
| Workspace Prompt | prompt 广告 base、工具落在 session | 路径一致性、path-policy roots | [#3020](https://github.com/agentscope-ai/agentscope-java/pull/3020) Merged |
| State CAS | 迁移 DEFAULT 0 与「行不存在」哨兵冲突 | INSERT→UPDATE 自愈、多后端语义 | [#3165](https://github.com/agentscope-ai/agentscope-java/pull/3165) Merged |
| OTel SDK | Tracing 只能绑 GlobalOpenTelemetry | 注入构造、lazy global、Refs vs Fixes | [#3250](https://github.com/agentscope-ai/agentscope-java/pull/3250) Merged |

截至 2026-09-30：已合并 [#2675](https://github.com/agentscope-ai/agentscope-java/pull/2675)、[#2803](https://github.com/agentscope-ai/agentscope-java/pull/2803)、[#2839](https://github.com/agentscope-ai/agentscope-java/pull/2839)、[#3020](https://github.com/agentscope-ai/agentscope-java/pull/3020)、[#3165](https://github.com/agentscope-ai/agentscope-java/pull/3165)、[#3250](https://github.com/agentscope-ai/agentscope-java/pull/3250)；仍为 Open 的有 [#2378](https://github.com/agentscope-ai/agentscope-java/pull/2378)、[#2797](https://github.com/agentscope-ai/agentscope-java/pull/2797)、[#2833](https://github.com/agentscope-ai/agentscope-java/pull/2833)、[#2854](https://github.com/agentscope-ai/agentscope-java/pull/2854)、[#2996](https://github.com/agentscope-ai/agentscope-java/pull/2996)。
