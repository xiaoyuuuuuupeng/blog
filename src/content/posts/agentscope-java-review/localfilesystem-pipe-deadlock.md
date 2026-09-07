---
pubDatetime: 2026-08-27T08:00:00+08:00
title: "一次 Harness Shell 管道死锁 PR 的排查与 Review 实录"
description: "从进程管道死锁的复现出发，拆解并发 drain、超时回收、输出上限与回归测试的审查方法。"
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
> **PR**：[agentscope-ai/agentscope-java#2839](https://github.com/agentscope-ai/agentscope-java/pull/2839)  
> **Issue**：#2838  
> **标题**：fix(harness): prevent pipe deadlock in LocalFilesystemWithShell.execute  
> **作者**：zzz-ghost  
> **Review**：[xiaoyuuuuuupeng 的 Approve + follow-up 评论](https://github.com/agentscope-ai/agentscope-java/pull/2839#pullrequestreview-5026157579)  
> **日期**：2026-08-26 ~ 2026-08-27  

---

## 前言

这个 PR 只有 2 个文件、大约 +88 / -3 行，CI 全绿，回归测试也很直观。但它修的是一类**非常经典、又极易被忽略**的 bug：父进程 `waitFor` 子进程的同时，没有人读 stdout/stderr 管道，导致双方互相等待。

在 Agent / Coding 工具链里，shell 命令输出稍大（日志、`cat` 大文件、循环 `echo`）就会触发。Harness 本地开发模式下，`LocalFilesystemWithShell` 正是跑 shell 的后端——这条路径一旦死锁，Agent 会把「本来 0.4 秒能跑完的命令」误报成 **exit 124 超时**，用户体验极差。

本文记录：我们如何理解上下文、如何排查与本地复现、如何做 Code Review、PR 解决了什么，以及还剩什么。

---

## 1. 先搞清上下文：`LocalFilesystemWithShell` 是什么

它不是 Agent 直接调用的「工具类」，而是 **Harness 本地文件系统的后端实现**。

调用链大致如下：

```
HarnessAgent
  └─ ShellExecuteTool          ← Agent 能调用的 shell 工具
       └─ AbstractSandboxFilesystem.execute()
            ├─ LocalFilesystemWithShell   ← 本地：真机磁盘 + ProcessBuilder
            └─ SandboxBackedFilesystem    ← 远程/沙箱环境
```

`LocalFilesystemWithShell` 继承 `LocalFilesystem`（读/写/列目录），并实现 `AbstractSandboxFilesystem`，额外提供 `execute()`：在本机用 `cmd.exe /c` 或 `sh -c` 跑命令。

类注释里也写得很直白——**无沙箱、无隔离**，适合本地开发和 CI，但要谨慎使用：

```java
/**
 * Filesystem with unrestricted local shell command execution.
 * ...
 * <p><b>WARNING:</b> This implementation grants agents BOTH direct filesystem access AND unrestricted
 * shell execution on your local machine.
 */
public class LocalFilesystemWithShell extends LocalFilesystem implements AbstractSandboxFilesystem {
```

同类问题在 `agentscope-core` 的 `ShellCommandTool` 里**早已修过**；Harness 这条路径被漏掉了，于是有了 #2838 / #2839。

---

## 2. 旧代码有什么问题：管道死锁

### 2.1 旧写法

修复前的核心逻辑（简化）：

```java
Process proc = pb.start();

boolean finished = proc.waitFor(effectiveTimeout, TimeUnit.SECONDS);

String stdout = new String(proc.getInputStream().readAllBytes(), outputCharset);
String stderr = new String(proc.getErrorStream().readAllBytes(), outputCharset);

if (!finished) {
    proc.destroyForcibly();
    return new ExecuteResponse(msg, 124, false);  // 误报为超时
}
```

顺序是：**先等进程结束，再读流**。

### 2.2 什么时候会出问题

当子进程在退出前写出的数据**累计超过 OS 管道缓冲**时：

| 平台 | 管道缓冲（约） |
|------|----------------|
| Windows | ~4 KB |
| Linux（默认） | ~64 KB |

此时会发生：

```
子进程：write() → 管道满 → 阻塞，等父进程读
父进程：waitFor() → 等子进程退出
```

双方互相等——**经典管道死锁**。

### 2.3 「不是有 `waitFor(timeout)` 吗，为什么还会死锁？」

这是 review 过程中最常问的一点，值得单独说明。

`waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)` **不会让父进程永远挂死**——超时到了会返回 `false`，然后 `destroyForcibly()`。但在这整个超时窗口里：

- 子进程已经堵在 `write()` 上，**不可能正常退出**
- 父进程一直在 `waitFor`，**不会去读管道**
- 最终表现：一个本可亚秒级完成的命令，被拖到 60s（或配置的 timeout）后被强杀，**误报 exit 124**

所以：**超时是逃生阀，不是解药**。死锁发生在等待期间；超时只是最后把卡住的进程砍掉。

### 2.4 小输出为什么没事

若子进程在退出前写出的总量**不超过管道缓冲**，管道装得下，子进程能写完并正常退出，`waitFor` 返回 `true`，再 `readAllBytes()` 也来得及——**不会触发死锁**。

---

## 3. 如何排查：我们的 Review 步骤

### 3.1 第一步：读 PR diff，对照已有修复

PR 描述写明：mirrors the fix already applied to `ShellCommandTool`。因此我们：

1. 读 `LocalFilesystemWithShell.execute()`、`drainAsync()`、`joinQuietly()`
2. 对照 `agentscope-core` 里 `ShellCommandTool.executeCommand()` 的异步读流逻辑

`ShellCommandTool` 的关键注释（core 里早已存在）：

```java
// CRITICAL FIX: Start asynchronous stream readers immediately to prevent pipe buffer deadlock
stdoutFuture = STREAM_READER_POOL.submit(
        new StreamReader(process.getInputStream(), "stdout", effectiveCharset));
stderrFuture = STREAM_READER_POOL.submit(
        new StreamReader(process.getErrorStream(), "stderr", effectiveCharset));

boolean completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
```

思路一致：**先启动 reader，再 waitFor**。

### 3.2 第二步：重点检查清单

| 检查项 | 结论 |
|--------|------|
| 超时后 `destroyForcibly()` 与 drainer 退出次序 | PR 改为超时先 kill，再 join，顺序正确 |
| join 超时后是否并发读 BAOS | **仍有风险**（见下文 follow-up A） |
| 大输出是否在截断前无界积累 | **仍有风险**（见下文 follow-up B） |
| stdout + stderr 是否都有 drainer | 有，两条都有 |
| CI | 最新全绿；早先失败为无关 flaky test |

### 3.3 第三步：核对 CI 失败日志

作者称早先两次 `build (ubuntu-latest)` 失败是既有 flaky test。我们读了失败日志，确认是：

- `HarnessAgentDynamicHookBuilderTest` / `HarnessAgentSubagentStreamTest`
- `JUnitException: Failed to close extension context`
- `DirectoryNotEmptyException` on `@TempDir`

与本次改动无关；作者归因成立。

### 3.4 第四步：跑回归测试

```powershell
git checkout fix/2838-execute-pipe-deadlock   # PR 分支

# 若依赖未装，先 build core
mvn -q -pl agentscope-core,agentscope-harness -am install -DskipTests

mvn -q -pl agentscope-harness `
  "-Dtest=LocalFilesystemWithShellTest#execute_outputLargerThanOsPipeBufferCompletesWithoutDeadlock" test
```

Windows 上结果：**通过**（exit 0，亚秒级完成）。

---

## 4. 如何本地复现（不影响 master 分支）

我们写了一个**独立于 git 仓库**的小 demo，放在 `%TEMP%\pipe-deadlock-repro\PipeDeadlockDemo.java`，不改任何分支即可对比「修前 / 修后」。

### 4.1 运行方式

```powershell
cd $env:TEMP\pipe-deadlock-repro
javac -encoding UTF-8 PipeDeadlockDemo.java

# 旧写法：先 waitFor 再读 → 约 8s 超时，打印 DEADLOCK
java PipeDeadlockDemo broken

# PR 写法：边 drain 边 waitFor → 亚秒级 OK
java PipeDeadlockDemo fixed
```

### 4.2 核心对比代码

**broken（旧 LocalFilesystemWithShell 模式）：**

```java
static void runBroken(Process proc) throws Exception {
    boolean finished = proc.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
    if (!finished) {
        proc.destroyForcibly();
        System.out.println(
                "DEADLOCK reproduced: waitFor timed out (exit would be 124). "
                        + "Child blocked on full pipe; parent blocked in waitFor.");
        return;
    }
    byte[] out = proc.getInputStream().readAllBytes();
    // ...
}
```

**fixed（PR 模式）：**

```java
static void runFixed(Process proc) throws Exception {
    ByteArrayOutputStream stdout = new ByteArrayOutputStream();
    Thread tOut = drain(proc.getInputStream(), stdout);

    boolean finished = proc.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
    if (!finished) {
        proc.destroyForcibly();
    }
    tOut.join(5000);

    System.out.printf("OK: exit=%d stdoutBytes=%d%n", proc.exitValue(), stdout.size());
}
```

### 4.3 实测结果（Windows）

| 模式 | elapsed | 现象 |
|------|---------|------|
| `broken` | ~8051 ms | `DEADLOCK reproduced`，exit 124 语义 |
| `fixed` | ~135 ms | `OK: exit=0 stdoutBytes=72000` |

测试命令打出约 4000 行 × 16 字符 ≈ 66–72 KB，超过 Windows ~4KB 管道缓冲。

---

## 5. PR 如何修复：drainer 是什么

### 5.1 新流程

PR 在 `ProcessBuilder.start()` 之后立刻：

1. 创建两个 `ByteArrayOutputStream`（stdout / stderr）
2. 启动两条 **daemon drainer 线程**，持续 `read` 管道 → `write` 进 BAOS
3. 主线程 `waitFor(timeout)`
4. 超时则 `destroyForcibly()`，再 `join` 两条 drainer
5. 从 BAOS 取字符串，拼输出、截断、返回

关键代码（PR 分支）：

```java
Process proc = pb.start();

ByteArrayOutputStream stdoutBuf = new ByteArrayOutputStream();
ByteArrayOutputStream stderrBuf = new ByteArrayOutputStream();
Thread stdoutDrainer = drainAsync(proc.getInputStream(), stdoutBuf);
Thread stderrDrainer = drainAsync(proc.getErrorStream(), stderrBuf);

boolean finished = proc.waitFor(effectiveTimeout, TimeUnit.SECONDS);
if (!finished) {
    proc.destroyForcibly();
}
joinQuietly(stdoutDrainer);
joinQuietly(stderrDrainer);

String stdout = stdoutBuf.toString(outputCharset);
String stderr = stderrBuf.toString(outputCharset);
```

**drainer** = 「排水」线程：不停从子进程 stdout/stderr 读数据，倒进内存缓冲，避免管道写满。

### 5.2 为什么这样能解决死锁

```
旧：主线程 waitFor（干等）     子线程：无
    → 管道满 → 双堵

新：主线程 waitFor              drainer：边读边 write 到 BAOS
    → 管道被及时掏空 → 子进程能写完退出 → waitFor 很快返回 true
```

`destroyForcibly()` + `join` 是**超时保护**和**收尾**，不是防死锁的核心；防死锁靠的是 **drain 与 waitFor 并行**。

### 5.3 回归测试

PR 新增 `execute_outputLargerThanOsPipeBufferCompletesWithoutDeadlock`：

```java
@Test
void execute_outputLargerThanOsPipeBufferCompletesWithoutDeadlock(@TempDir Path tempDir) {
    int lines = 4000;
    String payload = "0123456789abcdef";
    boolean windows = System.getProperty("os.name").toLowerCase().contains("win");
    String command = windows
            ? "for /l %i in (1,1," + lines + ") do @echo " + payload
            : "i=0; while [ \"$i\" -lt " + lines + " ]; do echo " + payload + "; i=$((i+1)); done";

    LocalFilesystemWithShell fs = new LocalFilesystemWithShell(tempDir);
    ExecuteResponse resp = fs.execute(null, command, 60);

    assertEquals(0, resp.exitCode());
    assertFalse(resp.truncated());
    assertEquals(lines, resp.output().split(payload, -1).length - 1);
}
```

---

## 6. Review 结论：解决了什么，还没解决什么

### 6.1 已解决 ✅

- **管道死锁**：并发排空 stdout/stderr
- **误报 exit 124**：大输出命令能正常完成
- **与 ShellCommandTool 意图对齐**：核心思路一致（wait 前/期间异步读）

### 6.2 未解决，建议 follow-up ⚠️

我们称之为 **A / B** 两个缺口（不是 Git 分支名，是审查项编号）。

#### A. join 超时后仍可能并发写 BAOS

```java
private static void joinQuietly(Thread t) {
    try {
        t.join(DRAIN_JOIN_TIMEOUT_MILLIS);  // 5 秒到了就返回，不检查 isAlive
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    }
}
// 随后立刻：stdoutBuf.toString(outputCharset)
```

`join(5s)` 到期时 drainer **可能还活着**，主线程却对非线程安全的 `ByteArrayOutputStream` 做 `toString()` → 数据竞争。

`ShellCommandTool` 更稳：用 `Future.get(timeout)`，超时 `cancel(true)` 并**丢弃**未完成结果，主线程不碰还在写的 buffer。

#### B. 引流仍无界（maxOutputBytes 是后置的）

drainer 无界 `write` 进 BAOS；`maxOutputBytes`（默认 100_000）只在拼完 `outputStr` **之后**截断。超大输出可能在截断前就 **OOM**。

修死后锁后，大输出从「死锁伪超时」变成「能跑完并在堆上攒满」，OOM 风险反而更容易暴露。

`ShellCommandTool` 也没有 `maxOutputBytes`，`StringBuilder` 同样无界——core 侧问题更裸。

### 6.3 建议的改法（给 follow-up PR）

**引流封顶：**

```java
while ((n = in.read(chunk)) != -1) {
    int room = maxBytes - buf.size();
    if (room > 0) {
        buf.write(chunk, 0, Math.min(n, room));
    }
    // room <= 0：继续 read，不再 write → 不堵管道、堆不涨
}
```

**Reader 收尾（最小改法）：**

```java
t.join(5000);
if (t.isAlive()) {
    t.interrupt();
    // 不信任 buf，超时路径当空串或丢弃
}
```

**更齐的做法：** 对齐 `ShellCommandTool` 的 `Future.get` + `cancel(true)`。

---

## 7. 横向对比：gemini-cli / qwen-code 怎么做

| | gemini-cli | qwen-code | harness（本 PR 后） | ShellCommandTool |
|--|------------|-----------|---------------------|------------------|
| 边跑边读 | ✅ | ✅ | ✅ | ✅ |
| 管道死锁 | 已避免 | 已避免 | 已避免 | 已避免 |
| 引流时内存上限 | ✅ ~16MB 环形留尾 | ✅ 默认 64MB，超限继续读但丢弃 | ❌ 后置截断 | ❌ 无 cap |
| 超时 | 无输出 inactivity | 墙钟 120s | 墙钟 120s | 墙钟 |

成熟产品的共同做法：**异步 drain 的同时限制捕获缓冲**；超限仍读管道（或环形覆盖），避免堵死 + OOM。

要求 harness 在 `drainAsync` 里应用 `maxOutputBytes`，与业界一致，不是额外刁难。

---

## 8. 附录：几个高频问题的答案

### Q：`Future.get(timeout)` 为什么比 `join` + 共享 BAOS 更安全？

`StreamReader` 在**线程内部的局部** `StringBuilder` 里攒数据，读完才 `return String`。主线程 `future.get(5s)`：

- **成功**：拿到的是已完成、不可变的 String，没有并发写
- **超时**：`cancel(true)`，返回 `""`，**不用**未完成 buffer

`join` + 共享 BAOS 则是：超时后主线程和 drainer 可能**同时**碰同一块可变内存。

对齐的是 **ShellCommandTool 的收尾安全语义**，不是要求 harness 整类重写。

### Q：`maxOutputBytes` 后置为什么仍会 OOM？

因为截断发生在「已经全部读进堆」之后。引流阶段 buffer 无上限，几 GB 输出会在截断逻辑运行前就撑爆堆。

### Q：小输出为什么旧代码也能用？

管道缓冲装得下时，子进程能正常退出，`waitFor` 返回后再读也来得及——只有**累计输出超过缓冲**才死锁。

---

## 9. 小结

| 阶段 | 要点 |
|------|------|
| 理解上下文 | `LocalFilesystemWithShell` 是 harness 本地 shell 后端，不是 Agent 工具本身 |
| 根因 | wait-then-read + 管道缓冲有限 → 经典死锁；`waitFor(timeout)` 只限时不读流 |
| 修复 | drainer 线程并发排空 + 超时先 kill 再 join |
| 复现 | 独立 `PipeDeadlockDemo` 或模块单测，不改 master |
| Review | 对照 ShellCommandTool；查 CI；跑测试；发现 A/B 缺口 |
| 后续 | follow-up：引流封顶、reader 收尾对齐 core → 见 **§10**（#2850 / #2853 现状） |

这是一个「改动小、价值高、边界清晰」的 PR。死锁修复值得合入；A/B 作为工程化补强，值得跟踪但不一定要挡在本次合并之外——取决于维护者对安全基线的要求。

---

## 10. 后续进展与现状（2026-08-27 更新）

Review 提交后，作者与社区按我们预期的 **「Approve → Issue → Follow-up PR」** 路径推进。本节记录当前状态，并说明开源 PR 里常见的协作模式——便于第一次参与 review 的读者理解「接下来会发生什么」。

### 10.1 时间线

```
#2838  Bug 报告（管道死锁）
   ↓
#2839  修死锁（zzz-ghost）                    ← 本文主体；已 Approve，待 merge
   ↓  Review follow-up A/B
#2850  Issue 跟踪输出捕获生命周期问题          ← 作者回复 "Filed #2850"
   ↓
#2853  实现 A/B + 测试 + 进程清理（guslegend0510） ← Depends on #2839
```

### 10.2 各 PR / Issue 当前状态

| 链接 | 状态（2026-08-27） | 说明 |
|------|-------------------|------|
| [#2839](https://github.com/agentscope-ai/agentscope-java/pull/2839) | **Open**，已有 2 个 Approve（dailingtao、xiaoyuuuuuupeng） | 死锁修复；**尚未 merge 到 main** |
| [#2850](https://github.com/agentscope-ai/agentscope-java/issues/2850) | Issue | 跟踪 #2839 review 提出的 follow-up（引流封顶、Future 收尾等） |
| [#2853](https://github.com/agentscope-ai/agentscope-java/pull/2853) | **Open**，0 review，CI 基本绿 | follow-up 实现 PR；**依赖 #2839** |

作者在 [#2839 评论](https://github.com/agentscope-ai/agentscope-java/pull/2839#issuecomment-5422699059) 回复：

> Thanks! Filed #2850 to track these — will send a follow-up PR once this one lands.

随后 guslegend0510 提交了 [#2853](https://github.com/agentscope-ai/agentscope-java/pull/2853)，并在 PR 描述中 `@` 关联 #2839。

### 10.3 #2853 做了什么（对应我们的 follow-up A/B）

[#2853 Summary](https://github.com/agentscope-ai/agentscope-java/pull/2853) 声称：

| 我们的 follow-up | #2853 对应项 |
|------------------|--------------|
| **B** 引流时按 `maxOutputBytes` 封顶，继续 drain | Bound stdout/stderr capture while continuing to drain excess bytes |
| **A** 对齐 `ShellCommandTool` 的 reader 收尾 | Replace raw drainer-thread joins with `Future`-based completion；超时 cancel、关流 |
| 可选 stderr / 双流测试 | large stdout、stderr、dual-stream、bounded-capture、timeout、interruption 等测试 |
| — | 额外：共享 teardown deadline、exit 124 语义、interrupt 恢复、进程树 best-effort cleanup |

作者仍列出 **Draft follow-ups**（标记 ready 前待处理）：

- 意外 `IOException` 应传播，而非把 partial capture 当成功
- 进程树 cleanup 范围需澄清（`ProcessHandle.descendants()` 在父进程退出后无法保证）

### 10.4 「Depends on #2839」是什么意思

这叫 **stacked / dependent PR（叠 PR）**：

1. #2853 的代码建立在 #2839 之上；分支里**暂时包含** #2839 的死锁修复 commit（与 #2839 重复）
2. #2839 **未 merge** 时，#2853 对 `main` 的 diff 会混入 prerequisite 改动
3. 惯例 merge 顺序：**先合 #2839 → rebase #2853 去掉重复 commit → 再合 #2853**

#2853 描述中写明：

> After #2839 is merged, the branch will be rebased and the duplicate prerequisite commit will be dropped.

### 10.5 开源 PR 协作模式（给第一次 review 的读者）

你**不需要是 maintainer** 也能做有价值的 review。典型角色：

| 角色 | 在本事件里 |
|------|-----------|
| **贡献者 A**（zzz-ghost） | 提 #2839，收到 review 后开 #2850 |
| **Reviewer**（你） | Approve #2839 + 行内 nit → 推动 follow-up |
| **贡献者 B**（guslegend0510） | 接 #2850，开 #2853 实现 A/B |
| **维护者**（如 dailingtao） | Approve、决定 merge 顺序 |

Review 的三种表态：

- **Comment**：只讨论
- **Approve**：同意合并（#2839 已用）
- **Request changes**：认为必须改完才能合（方案一才用）

**Approve 不等于「以后不能再提意见」**——follow-up 可以另开 PR，正是 #2853 在做的事。

### 10.6 现在该不该 review #2853？

| 时机 | 建议 |
|------|------|
| **现在** | 可以看 diff、发 **Comment** 做早期反馈；重点看相对 #2839 **增量**的 commit（`bound shell capture` 等） |
| **#2839 merge + #2853 rebase 后** | 再 **正式 Approve** #2853；此时 diff 干净、无重复 commit |
| **作者处理完 draft follow-ups 后** | 若 IOException / 进程树 cleanup 仍开放，需决定是否 Accept 或再开 issue |

暂不建议在 #2839 未 merge、#2853 未 rebase 时急着 Approve #2853。

可选的占位 Comment（英文）：

```text
Thanks for picking up the #2839 follow-ups in #2850.

I'll do a full review once #2839 lands and this branch is rebased onto main.
For now, the bounded capture + Future-based teardown direction looks aligned with the review notes.
```

### 10.7 更新后的小结

| 阶段 | 状态 |
|------|------|
| #2839 死锁修复 | Approve 完成，**等待 merge** |
| follow-up A/B | **#2850 + #2853 已启动** |
| #2853 正式 review | **建议等 #2839 merge 且 rebase 后** |
| 博客 / 审查纪要 | 本文与 `reviews/PR-2839-pipe-deadlock-review.zh.md` 可继续跟踪 #2853 |

---

*相关文档：`AS-java-pr/reviews/PR-2839-pipe-deadlock-review.zh.md`（中英审查纪要）*  
*独立复现：`%TEMP%\pipe-deadlock-repro\PipeDeadlockDemo.java`*  
*后续 PR：[#2853 fix(harness): bound LocalFilesystemWithShell output capture](https://github.com/agentscope-ai/agentscope-java/pull/2853)*
