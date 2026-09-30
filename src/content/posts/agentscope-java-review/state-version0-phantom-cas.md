---
pubDatetime: 2026-09-20T12:00:00+08:00
title: "as-java-review: 修复迁移 version=0 行上的幽灵 CAS 冲突"
description: "复盘 AgentScope Java PR #3165：ensureVersionColumn 用 DEFAULT 0 回填，与 getVersioned 的「行不存在」哨兵撞车，以及 INSERT 冲突后自愈到 version 1 的修法。"
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
> **PR**：[agentscope-ai/agentscope-java#3165](https://github.com/agentscope-ai/agentscope-java/pull/3165)  
> **Issue**：[\#3162 ensureVersionColumn() backfills version=0，与 getVersioned 哨兵冲突](https://github.com/agentscope-ai/agentscope-java/issues/3162)  
> **标题**：fix(state): resolve phantom CAS conflicts on version-0 migrated rows  
> **作者**：hexly666  
> **Review**：[Approve + 详细 LGTM](https://github.com/agentscope-ai/agentscope-java/pull/3165#pullrequestreview-5259811663)  
> **日期**：2026-09-20  

---

## 前言

这个 PR 动 8 个文件（约 +167 / -27），覆盖 MySQL / PostgreSQL / JDBC 三条 store。它修的是升级路径上的 **幽灵 CAS**：没有第二个写者，`saveIfVersion` 却报冲突；在 `FAIL` / `APPEND_MERGE` 策略下，session 会永久卡住。

根因不是 CAS 算法写错，而是 `ensureVersionColumn()` 用 `DEFAULT 0` 回填 version，而 `getVersioned()` 用 `version == 0` 表示「行不存在」。三处语义撞车之后，每个升级前已存在的 session 都会在下一轮对话踩雷。

本文记录：三个站点如何对不上、按 ConflictPolicy 的伤害差多少、INSERT 冲突 fallback 怎么自愈、为什么 JDBC 必须 savepoint / PG 可用 ON CONFLICT，以及我写进 Approve 的非阻塞 follow-up。

---

## 1. 先搞清上下文：version 列与 absent 哨兵

### 1.1 乐观锁写入路径

```text
ReActAgent.persistAgentStateCas()
  └─ store.getVersioned(slot, key)
       └─ VersionedState<>(state, version)
  └─ store.saveIfVersion(..., expectedVersion)
       ├─ expectedVersion == 0  → 认为行尚不存在 → INSERT
       └─ expectedVersion  > 0  → UPDATE ... WHERE version = ?
```

正常写入路径把新行写成 `version = 1`。`UNVERSIONED` 常量是 `-1L`，表示「无条件写 / 放弃 CAS」——和这次碰撞无关。

### 1.2 `0` 在三个站点的含义（修改前）

| 站点 | 对 `0` 的含义 |
|------|----------------|
| `ensureVersionColumn` ALTER DEFAULT | 存量行合法版本值 |
| `getVersioned` 无行 | 哨兵：行不存在 |
| `saveIfVersion(..., 0)` | 应走 INSERT（行尚不存在） |

因此，**单状态 CAS 正常写入从 version 1 起步**；`0` 会出现在 ALTER 回填上，也会合法存在于不走 CAS 的 list-valued states 行上。本文的碰撞针对单状态 CAS，不能把所有 version=0 行都当成错误数据。

### 1.3 谁会跑到这条路径

- 表由 2.0.2（或任何 pre-version 构建）创建，升级后构造 store 触发 `ensureVersionColumn()`
- 手建表、没有 version 列，同样被 ALTER 回填成 0
- 已确认落在 `MysqlAgentStateStore` / `PostgresAgentStateStore`；JDBC 共享「0 = absent」逻辑，但当时缺等价迁移（相关后续 issue 另说）

---

## 2. 旧代码有什么问题：升级即幽灵冲突

### 2.1 调用链

```text
升级重启
  └─ Store 构造 → ensureVersionColumn()
       └─ ALTER ... version BIGINT NOT NULL DEFAULT 0
            └─ 存量 agent_state 行全部变成 version=0

下一轮对话
  └─ getVersioned() → VersionedState(state, 0)   // 行在，version 却是哨兵值
       └─ saveIfVersion(..., expectedVersion=0)
            └─ insertIfAbsent(...)
                 └─ duplicate key → UNVERSIONED   // 幽灵冲突
```

等价 SQL（无需应用层）：

```sql
UPDATE agentscope_sessions
SET version = 0
WHERE session_id = ? AND state_key = 'agent_state';
-- 下一次 saveIfVersion(..., 0) 会尝试 INSERT 并撞主键
```

### 2.2 按 ConflictPolicy 的伤害

| 策略 | 升级后表现 |
|------|------------|
| `OVERWRITE`（默认，main 上） | 首轮误报警告后可自愈（依赖后续 unconditional 写） |
| `FAIL` | 直接 `ConcurrentSessionModificationException` |
| `APPEND_MERGE` | 反复读到 version=0 再 INSERT，**session 永久卡住** |

`APPEND_MERGE` 会再读 `latest.version()`，仍是 0，再走同一条 INSERT，永远写不进去。这比默认策略下的「首轮警告」严重一个数量级：会话不可恢复，除非人手跑 SQL。

Issue 还指出：在已发布的 2.0.3 jar 上，`OVERWRITE` 分支曾因 #3047 的反序列化问题直接炸；#3048 修掉崩溃后，根因仍在，只是默认策略变成「吓人但不致命」。所以 #3162 值得单独修，不能指望 #3047 顺带带走。

### 2.3 为什么不能只改 DEFAULT

把 ALTER 改成 `DEFAULT 1` 只能保护 **尚未迁移** 的部署。已经回填成 0 的生产库，若不做写入路径自愈，仍会幽灵冲突。Issue 建议的 `UPDATE ... SET version = 1 WHERE version = 0` 是离线迁移思路；PR 选择在 `saveIfVersion(0)` 上 insert-conflict fallback，让在线流量自己把行推到 1，免一次强制 DBA 脚本。

---

## 3. PR 如何修复

### 3.1 INSERT 冲突后 fallback UPDATE

```text
saveIfVersion(expectedVersion=0):
  1) INSERT IF ABSENT
  2) 若撞到已有行 → UPDATE ... WHERE version = 0
       ├─ 影响 1 行 → 成功，自愈到 version 1
       └─ 影响 0 行 → UNVERSIONED（真并发 / 已越过 0）
```

效果：

1. **已迁移的 version=0 行自愈到 1**，CAS 成功，无需单独数据迁移脚本。
2. **行已经 `>= 1`** 时，WHERE 匹配 0 行 → 仍报 `UNVERSIONED`，真并发不被 fallback 覆盖。
3. **新升级**：ALTER 改为 `DEFAULT 1`，不再制造新的 version-0 存量。

MySQL / PostgreSQL / JDBC 三条实现都接到了这条路径。并发语义保持：只有「看起来像 absent、其实是回填 0」的行会被推进。

### 3.2 为什么 JDBC 需要 savepoint

PostgreSQL（以及部分严格模式 JDBC 驱动）上，**失败的 INSERT 会 abort 当前事务**。若不做隔离，后续 `UPDATE ... WHERE version = 0` 根本执行不了——fallback 写在纸上，跑不起来。

因此：

- **JDBC 通用路径**：失败 INSERT 包在 savepoint 里，回滚到 savepoint 再 UPDATE。
- **Postgres 专用实现**：可用 `ON CONFLICT DO NOTHING`，避免「先炸再救」的语句失败语义。

这是审查时特别对齐过的细节：修复若不包含事务/冲突处理，在 PG 上等于没修。

### 3.3 不改「0 = absent」对外契约

PR 没有把 absent 哨兵改成 `-1` 或其它值——那样会牵动所有 store 与调用方。选择是：保留历史哨兵，让写入路径承认「DEFAULT 0 回填行」这一迁移现实。短期兼容性更好；代价是契约文档必须写清「存储中的 0 现在也可以被 CAS 推到 1」。

---

## 4. 我写进 Review 的 LGTM

合并前的 Approve 原文要点如下（中文复述，链接见文首）：

> LGTM — 我认为这个 PR 正确修复了 #3162 描述的幽灵 CAS。

主修复看起来站得住：

- `expectedVersion == 0` 先尝试 insert，再 fallback `UPDATE ... WHERE version = 0`。
- 已经推进到 `version >= 1` 的行仍受 CAS 保护，返回 `UNVERSIONED`，fallback 不会覆盖真并发更新。
- JDBC savepoint 对 PostgreSQL 这类「失败 INSERT 会 abort txn」的库是必要的，否则 fallback UPDATE 跑不了。
- 专用 PostgreSQL 实现用 `ON CONFLICT DO NOTHING` 绕开同一问题。
- 迁移 `ALTER` 改成 `DEFAULT 1`，避免新升级再造 version-0 行。

没有看到正确性上的 blocker。

---

## 5. 非阻塞 follow-up

三条都不挡合并，但契约/测试/DDL 整齐度还差半步：

### 5.1 Mongo 对 version=0 语义不一致

更新后的 `AgentStateStore` 契约允许「已存储的 version=0」CAS 推进到 1。`MongoAgentStateStore` 却把 `expectedVersion == 0` 处理成「仅当 version 字段不存在时匹配」。若库里真有显式 `version = 0` 文档，会直接 `UNVERSIONED`。

正常 Mongo 写入路径通常碰不到，所以不挡 #3165；但接口措辞与实现应对齐到 follow-up，否则文档读者会以为所有 store 行为一致。

### 5.2 PostgreSQL 缺对称回归

已有「version=0 成功 fallback」的用例；还应补「行已越过 0、必须仍返回 `UNVERSIONED`」的对称测试，把「自愈」和「真冲突」钉在同一后端上。只测成功路径，容易在以后 refactor 时把 WHERE 条件改松。

### 5.3 CREATE TABLE 仍 DEFAULT 0，与 ALTER DEFAULT 1 不对齐

常规单状态写入会显式写 version=1，所以多数路径不踩雷；但 DDL 两套默认值会让后人误读「0 到底是不是合法初值」。把 CREATE / ALTER / dialect 默认值收成同一语义，比再写一篇注释更干净。

oss-maintainer 也提醒：同一套 `getVersioned` 契约会被每个 store 读到；本次只修了 JDBC/MySQL/PostgreSQL 三件套。Redis 等其它实现若也能落到「version=0 歧义」，#3162 会换皮重现——值得单独扫一遍。

---

## 6. 如何排查：Review 检查清单

| 检查项 | 结论 |
|--------|------|
| ALTER DEFAULT 是否仍等于 absent 哨兵 | ✅ 改为 DEFAULT 1 |
| `saveIfVersion(0)` 是否能自愈 version=0 行 | ✅ INSERT 冲突 → UPDATE |
| 已 `>=1` 的行是否仍 UNVERSIONED | ✅ WHERE version=0 匹配不到 |
| PG/JDBC 失败 INSERT 是否弄脏事务 | ✅ savepoint / ON CONFLICT |
| Mongo/Redis 是否同契约 | ⚠️ follow-up |
| CREATE TABLE DEFAULT 是否与 ALTER 对齐 | ⚠️ follow-up |
| 对称「已越过 0」回归是否齐全 | ⚠️ PG 建议补 |

手工最小复现（修前）：

```sql
-- 模拟 ALTER 回填
UPDATE agentscope_sessions
SET version = 0
WHERE session_id = ? AND state_key = 'agent_state';
```

然后对该 session 再跑一轮会走 CAS 的对话：修前 `FAIL`/`APPEND_MERGE` 卡住；修后应静默推进到 version 1。

---

## 7. 测试与范围

三后端都应能证明：

| 场景 | 期望 |
|------|------|
| 回填 version=0 的 `agent_state` | `saveIfVersion(..., 0)` 成功并变为 1 |
| 已是 version≥1 | 同调用返回 `UNVERSIONED` |
| PG/JDBC 冲突 INSERT | 不弄脏事务，fallback 仍可执行 |

审查时 CI / License 等检查通过。合并后周边又冒出相关 issue（例如 `createIfNotExist=false` 仍 ALTER、Jdbc 缺迁移路径、无条件写返回别的 writer 的 version 等），说明 version 列升级面比单点 DEFAULT 更大——但 #3162 的幽灵 CAS 本身，被这条 insert-conflict fallback + DEFAULT 1 钉住了。

注意：list-valued states 走 `insertItems`、可不写 version 列，行上合法留 0 且不走 CAS。Issue 作者刻意把手工 `UPDATE` 限制在 `state_key = 'agent_state'`，follow-up 改 DDL 时也不要误伤这条旁路。

生产上若已经踩过 `APPEND_MERGE` 卡住，部署包含本 PR 的版本后，旧 version=0 行可在下一次成功的 `saveIfVersion(0)` 中自愈，无需强制手工迁移。若选择手工修复，Issue 给出的 SQL 仅针对 `agent_state`：

```sql
UPDATE agentscope_sessions
SET version = 1
WHERE state_key = 'agent_state' AND version = 0;
```

新流量会走 PR 的 fallback；旧卡死会话是否自动解冻，取决于下一次写入是否再进入 `expectedVersion=0` 分支。

---

## 8. Review 结论

最终 **Approve**。修复位置与 Issue 对得上：不改动「0 = absent」的历史哨兵，而是让写入路径承认「DEFAULT 0 回填行」这一迁移现实，并在真并发面前保持 CAS。

详细 LGTM 已写进 PR Review（见文首链接）；非阻塞三条（Mongo 语义、PG 对称测试、CREATE/ALTER DEFAULT 对齐）留作后续清理，不挡这次合并。

这次最值得复用的判断顺序：

1. 看到「升级后 CAS 狂报」时，先查 **迁移默认值是否等于 absent 哨兵**，再查并发。
2. 看到「INSERT if absent」时，问失败语句是否 **abort 事务**——PG/JDBC 的 savepoint / ON CONFLICT 不是锦上添花。
3. 改契约允许 version=0→1 时，扫一遍 **所有 store 实现**，Mongo/Redis 是否 silently 不一致。
4. 测自愈时，对称补一条「已越过 0 仍 UNVERSIONED」，否则只锁住了成功路径。
5. 评估 ConflictPolicy：默认策略「能自愈」不代表 `FAIL`/`APPEND_MERGE` 用户也可接受——升级 bug 的严重性要按最差策略算。
