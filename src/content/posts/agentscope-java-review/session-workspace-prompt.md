---
pubDatetime: 2026-09-17T16:00:00+08:00
title: "as-java-review: 让 Prompt 暴露正确的 Session Workspace 路径"
description: "复盘 AgentScope Java PR #3020：session isolation 下 prompt 仍广告 base workspace，模型按错路径写产物，以及如何与 NamespaceFactory 对齐。"
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
> **PR**：[agentscope-ai/agentscope-java#3020](https://github.com/agentscope-ai/agentscope-java/pull/3020)  
> **Issue**：[\#2941 无沙箱环境运行时，运行 skill 脚本技能的产物读取不到](https://github.com/agentscope-ai/agentscope-java/issues/2941)  
> **标题**：fix(harness): expose session workspace in prompt  
> **作者**：ningmao-hlyz  
> **Review**：[先 Changes Requested](https://github.com/agentscope-ai/agentscope-java/pull/3020#pullrequestreview-5174101179)，后 [Approve — 「LGTM.本地复测过了」](https://github.com/agentscope-ai/agentscope-java/pull/3020#pullrequestreview-5197185017)  
> **日期**：2026-09-11 Changes Requested；2026-09-14 Approve；2026-09-17 合并  

---

## 前言

这个 PR 动 7 个文件（约 +154 / -19），Approve 当日核对 CI 全绿，定向复测 24 个通过。它修的是一类「两边各自正确、合在一起就错」的问题：开启 session isolation 后，相对路径 file tools 已经解析到 session namespace（如 `/workspace/session-1`），但 `WorkspaceContextMiddleware` 仍向模型广告 base workspace（`/workspace`）。

Issue #2941 的现场很典型：无沙箱、单 `HarnessAgent` 多用户并发、按 session 隔离；模型按 prompt 跑 skill / 写 artifact，再用 file tools 找不到。更糟时会跨 session 翻找同名文件，隔离语义被 prompt 误导冲掉。

本文记录：四条路径语义怎么拆、根因在哪、第一轮为什么 Changes Requested、作者如何把绝对/相对路径落到同一文件，以及本地复测时核对过的边界。

---

## 1. 先搞清上下文：谁在说路径，谁在解析路径

### 1.1 四条路径语义

| 角色 | 修改前看到的根 | 谁消费 |
|------|----------------|--------|
| Workspace prompt | `/workspace`（base） | 模型规划 skill / shell / write |
| AgentStateStore context 段 | 同样 base | 模型读「当前 session 落在哪」 |
| 相对路径 file tools | `/workspace/session-1` | `write_file` / `read_file` / `list_file` |
| path-policy roots | base workspace | 允许/拒绝哪些绝对前缀 |

前两行是「告诉模型写哪里」，第三行是「工具实际写哪里」。修 prompt 只动前两行广告；policy roots 仍用 base，避免把 session 目录误当成「额外根」塞进 Additional roots。

### 1.2 调用链（本地 overlay + session isolation）

```text
HarnessAgent.call / stream
  └─ WorkspaceContextMiddleware
       └─ buildWorkspaceSection(rc)
            ├─ session context：广告 workspace 根
            └─ workspace paragraph：广告 workspace 根
  └─ 模型按广告路径规划
       ├─ write_file / read_file / list_file
       │    └─ FilesystemTool → WorkspacePathNormalizer → LocalFilesystem(+namespace)
       └─ shell / skill exec（cwd / 绝对路径按自己的规则）
```

sandbox、remote filesystem、shell cwd 行为不在这次改动范围内。PR 明确只纠正 **模型看到的路径**，并复用已有 namespace 推导，而不是另开一套路径规则。

### 1.3 Issue #2941 的用户场景

配置大致是：

```java
HarnessAgent.builder()
    .workspace("/workspace")
    // session isolation 开启
    .build();
```

用户说「帮我用 docx 技能生成测试 Word」。模型会：

1. `load_skill` 读 `SKILL.md`
2. `write_file` 生成 `gen_test.py`（相对路径 → 落到 session namespace）
3. `exec`：`python /workspace/gen_test.py /workspace/test.docx`（绝对路径来自 prompt）
4. 找不到文件 → 多轮翻找其他 session → 产物写到 base → `list_file` 只看 session 目录 → 仍找不到

临时绕过是关掉默认 workspace context、自己拼 `/workspace/<session>`。能跑通，说明框架本该在 middleware 里做这件事。

---

## 2. 旧代码有什么问题：广告路径没有走 NamespaceFactory

### 2.1 运行时已有单一真相来源

本地 overlay 在操作时已经通过 namespace factory 把相对路径接到 session 下。运行时数据路径也有统一入口：

```java
WorkspaceManager.resolveRuntimeDataPath(rc, "")
```

`WorkspaceContextMiddleware` 却直接拿 `workspaceManager.getWorkspace()`（base）去拼 session context 与 workspace 段落。模型收到的是「无租户根」，工具执行的是「本 call 的 session 根」。

### 2.2 这不是 tool bug，是契约分裂

相对路径 file tools「正确」落到 session；prompt「正确」复述了 builder 里配置的 `/workspace`。两边各自按自己的局部契约工作，合在一起就让模型把产物写到工具看不见的地方。

修复目标因此很窄：**让广告路径与操作时的 NamespaceFactory 同源**，而不是放宽 `list_file` 去扫 base，也不是关掉 isolation。

---

## 3. PR 如何修复

### 3.1 推导 per-call 有效 workspace

```java
Path workspace = workspaceManager.getWorkspace();
AbstractFilesystem filesystem = workspaceManager.getFilesystem();
Path effectiveWorkspace =
    detectLocalUpper(filesystem) != null
        ? workspaceManager.resolveRuntimeDataPath(rc, "")
        : workspace;
```

要点：

1. **单一真相来源**：广告路径跟 `resolveRuntimeDataPath` 共用 namespace factory，不另写一套 `sessionId` 拼接。
2. **只改本地 overlay**：sandbox / remote 仍广告 base，行为与改前一致。
3. **两处一起改**：AgentStateStore context 段与 Workspace prompt 段都传 `effectiveWorkspace`，避免「一段对、一段错」。

### 3.2 path-policy roots 仍用 base

session 目录是 namespace 前缀，不是独立「额外根」。若把 effective 路径塞进 Additional roots，prompt 会再次把模型往重复嵌套上引。Knowledge block 也仍相对 **base** 列举（知识库共享、不进 session overlay）——这是有意保留，不是漏改。

### 3.3 复用，而不是重写路径规则

作者选择复用 `WorkspaceManager.resolveRuntimeDataPath`，而不是在 middleware 里手拼 `workspace.resolve(sessionId)`。好处是：namespace factory 以后若改成 user+session、或做 id sanitisation（相关 #2952），广告路径会跟着走，不会再分叉一次。

---

## 4. Changes Requested：广告对了，归一化还要对上

### 4.1 第一轮为什么不直接 Approve

第一轮审查我提了 **Changes Requested**。原因不是「该不该广告 session 路径」，而是：

> 广告 `/workspace/session-1` 之后，`WorkspacePathNormalizer` 仍按 base `/workspace` 剥前缀。

模型若听话地调用：

```text
write_file("/workspace/session-1/artifact.txt")
```

归一化剥掉 `/workspace`，得到 `session-1/artifact.txt`；`LocalFilesystem` 再按当前 namespace 前缀一次，最终落成：

```text
/workspace/session-1/session-1/artifact.txt
```

相对路径 `artifact.txt` 却正确写到 `/workspace/session-1/artifact.txt`。于是 **绝对路径与相对路径打到不同文件**；shell 用广告的绝对路径去读，也对不上。

### 4.2 这个 gap 以前就在，新 prompt 把它显式化了

改 prompt 前，模型很少主动构造 `/workspace/session-1/...`。新广告一上线，这条路径就变成默认行为。只改字符串、不改 normalizer，等于把隐性 bug 显式化。

要求是：

- 绝对路径与相对路径解析到同一文件
- 用带 `RuntimeContext` 的归一化，**先剥当前 session 的 namespaced 前缀**，再考虑 unscoped base
- 加 `FilesystemTool` / HarnessAgent 端到端回归，断言不出现 `session-1/session-1/...`

### 4.3 作者怎么收口

后续把 `normalize(path, rc)` 接进 `FilesystemTool` / `ArtifactDeliveryTool`，并补了 `sessionIsolation_absoluteAndRelativeWorkspacePathsResolveToSameFile`。负向断言「双层 session 目录不得存在」尤其有价值——这才是 Changes Requested 要锁住的契约。

一参 `normalize(String)` 委托空 `RuntimeContext` 的路径被标成 `@Deprecated`。生产调用点都走带 `rc` 的重载，比「靠 Javadoc 提醒」便宜。

---

## 5. 如何排查：Review 检查清单

| 检查项 | 结论 |
|--------|------|
| 广告路径是否与 `resolveRuntimeDataPath` 同源 | ✅ |
| AgentStateStore context 与 Workspace 段是否一致 | ✅ |
| path-policy roots 是否仍用 base | ✅ |
| 绝对 / 相对是否同文件、无双层 session | ✅（CR 后补） |
| knowledge block 是否故意保持 base | ✅ intentional |
| sandbox / remote / shell 是否被误改 | ✅ 未改行为 |
| 关闭 isolation 时 prompt 是否行为保持 | ✅ 有回归 |

### 5.1 本地复测命令

```powershell
mvn -pl agentscope-harness -am `
  '-Dtest=WorkspaceContextMiddlewarePathBoundsTest,FilesystemToolTest' `
  '-Dsurefire.failIfNoSpecifiedTests=false' test
```

2026-09-14 在 head `11d3a165` 上复测：`WorkspaceContextMiddlewarePathBoundsTest` 4 个、`FilesystemToolTest` 20 个，合计 **24 tests**，0 failures / 0 errors。这组测试包含绝对/相对路径同落点的关键回归；它不是全量测试结果。路径归一化类改动里，Windows 构建是否绿也值得看一眼——作者后续 rebase 后 Windows check 通过。

### 5.2 修前可手工对齐的两条断言

不必起完整 Agent，也能把「广告 vs 解析」钉死：

```text
# 1) prompt 段（修前）
effective 广告 == base workspace          // 错

# 2) file tool（修前/后都对相对路径）
相对 "a.txt" → /workspace/session-1/a.txt // 对

# 3) 广告绝对路径 + 旧 normalizer（CR 指出的坑）
"/workspace/session-1/a.txt"
  → strip base → "session-1/a.txt"
  → +namespace → /workspace/session-1/session-1/a.txt  // 双层
```

修后 (1) 与 (2)(3) 的落点必须重合；负向断言「`session-1/session-1` 不得存在」比只 assert 字符串包含 `session-1` 更硬。

---

## 6. 测试覆盖了什么

与本修复直接相关的契约：

- prompt 在 session isolation 下广告 `.../session-1`，且 Additional roots 不吞掉 workspace
- 绝对 / 相对路径 round-trip 到同一文件，无 `session-1/session-1`
- 关闭 isolation 时 prompt 行为保持（常见单租户配置不回归）
- sandbox / shell 相关用例不因广告路径改动而漂移
- `FilesystemTool` / `ArtifactDeliveryTool` 生产路径传入 `RuntimeContext`

oss-maintainer 的非阻塞讨论（knowledge 是否同 bug 类、hostile session id、multi-segment namespace）大多被标成 deferred 或 intentional，不挡合并。跨 session 绝对路径（例如在 `session-1` 上下文里喂 `/workspace/session-2/x.txt`）仍可能经 unscoped fallback 落到错误物理文件——当前 prompt 路径碰不到，但 javadoc 里写清契约更稳。

---

## 7. 合并过程里还经历了什么

PR 中途撞过 main 冲突，作者 rebase 后继续推进。oss-maintainer 多轮 COMMENT 把一参 overload 的危险、knowledge 是否同 bug 类、hostile session id 等钉成线程；作者用 `@Deprecated`、注释与测试收口后，线程关闭，最终人类 Approve + 维护者合并。

时间线对我这边来说是两段：

1. **2026-09-11**：Changes Requested —— 广告正确但会制造双层目录。
2. **2026-09-14**：Approve —— 「LGTM.本地复测过了」；之后于 2026-09-17 合并。

中间还有一次 merge conflict 提醒与 Windows 路径相关的 CI 关注点。对路径归一化 PR，**跨平台 check 绿**和「负向断言双层目录」几乎同等重要。

---

## 8. Review 结论

最终提交了 **Approve**，意见是：「LGTM.本地复测过了」。

修复形状是对的：不是单独 patch 一句 prompt，而是让广告路径与操作时的 NamespaceFactory 同源，并把 `RuntimeContext` 贯穿 `norm(...)`。Changes Requested 那一轮把「广告正确」推进到「绝对/相对同落点」，避免合并后模型刚听话就踩双层目录。

这次最值得复用的判断顺序：

1. 看到「prompt 路径不对」时，先问 **工具解析根** 是什么，再问广告要不要对齐。
2. 改广告为绝对 session 路径时，立刻检查 **path normalizer 是否按同一 namespace 剥前缀**。
3. path-policy roots、knowledge、sandbox/shell 是否应跟 effective workspace 走，要逐项问「共享还是隔离」，不能默认全改。
4. 回归至少同时锁住「广告字符串」和「绝对/相对同文件」；只测 prompt 文本不够。
