# Notion CMS（第一阶段：双数据源）

本地 Markdown 与 Notion「随笔」数据库并行。未配置凭证时自动跳过 Notion，不影响现有文章构建。

## 1. Notion Integration

Notion 已改成 **Developer portal / Connections**，旧链接 `notion.so/my-integrations` 不可用。

任选其一：

1. 打开 [Developer portal · Connections](https://www.notion.so/developers/connections)（需登录且为 Workspace Owner）
2. 或：Notion 左侧 **Settings（设置）→ Connections（连接）**，开启 Developer Mode 后管理连接

然后：

1. **Build → Internal connections → Create a new connection**（内部连接）
2. 在 **Configuration** 里复制 **Installation access token**（即 `NOTION_TOKEN`）
3. 在 **Content access** 授权「随笔」数据库；或在 Notion 打开该库 → `•••` → **Connections → + Add connection**
4. 数据库 ID：浏览器地址里 `notion.so/` 后面、`?v=` 前面的 32 位十六进制（可带或不带连字符）

## 2. 本地环境变量

复制 `.env.example` 为 `.env`：

```bash
NOTION_TOKEN=secret_xxx
NOTION_DATABASE_ID=your-database-id
```

然后：

```bash
pnpm sync
pnpm dev
```

## 3. Notion 属性约定

| 属性 | 用途 |
| --- | --- |
| `title` | 标题 |
| `slug` | 建议填写；为空时会用标题自动生成 URL slug |
| `status` | 仅 `Published` 会发布 |
| `type` | 仅 `Post` 会发布 |
| `tags` | 标签 |
| `summary` | 列表摘要 / description |
| `date` | 发布日期（用于 `pubDatetime`，不是导入时间） |
| `category` | 可选 |
| `password` | 有值则**不发布**（第一阶段不实现前端解锁） |

## 4. Vercel 部署

在 Vercel Project → Settings → Environment Variables 配置：

- `NOTION_TOKEN`
- `NOTION_DATABASE_ID`
- `VERCEL_DEPLOY_HOOK_URL`（见下一节）
- `REDEPLOY_SECRET`（见下一节）

站点本身仍是静态构建；仅 `/api/redeploy` 走 Vercel Function。

## 5. Notion 发布后自动重新构建

目标：Notion 把 `status` 改成 `Published` 后，自动触发一次 Vercel 部署，构建时再从 Notion 拉最新文章。

### 5.1 创建 Deploy Hook

1. Vercel → Project → **Settings → Git → Deploy Hooks**
2. 新建 Hook（名称例如 `notion-publish`，分支选生产分支）
3. 复制生成的 URL，填到环境变量 `VERCEL_DEPLOY_HOOK_URL`

### 5.2 配置重建密钥

再设一个只给自己用的长随机串 `REDEPLOY_SECRET`（Vercel 环境变量 + 本地 `.env` 可选）。

对外暴露的是站点接口，而不是 Deploy Hook 原始 URL：

```http
POST https://你的域名/api/redeploy?secret=你的REDEPLOY_SECRET
```

也可用 Header：

```http
POST /api/redeploy
Authorization: Bearer 你的REDEPLOY_SECRET
```

成功返回 `{"ok":true,"triggered":true}`。60 秒内重复触发会返回 `202` + `debounced`，避免连点刷爆构建额度。

手动自测：

```bash
curl -X POST "https://你的域名/api/redeploy?secret=你的REDEPLOY_SECRET"
```

### 5.3 在 Notion 里接上自动化

在「随笔」数据库：

1. 打开 **Automations（自动化）**（或页面右上角 `⚡`）
2. 触发条件：`status` **改为** `Published`（也可再加 `type` 为 `Post`）
3. 动作：**Send webhook request / 发送 HTTP 请求**
   - Method: `POST`
   - URL: `https://你的域名/api/redeploy?secret=你的REDEPLOY_SECRET`
4. 保存后改一篇草稿为 Published，去 Vercel Deployments 确认是否出现新构建

若当前 Notion 套餐没有「发送 HTTP 请求」，可用：

- Make / Zapier：监听 Notion 状态变更 → POST 上述 URL
- 或暂时直接把 Deploy Hook URL 填进自动化（效果相同，但 Hook URL 会暴露在 Notion 侧）
- 也可在 Vercel 手动 **Redeploy**

### 5.4 预期延迟

不是 NotionNext 那种 ISR「访问即刷新」，而是：

`Published` → webhook → Vercel 构建（通常数分钟）→ 线上出现新文章

本地开发仍用 `pnpm sync` / `pnpm dev`，不会走这条 webhook。

## 6. URL 策略

- 本地 Markdown：仍为 `/posts/{目录}/{slug}/`
- Notion：`/posts/{slug}/`
- 若路径冲突，构建报错，需先改一侧 slug

## 限流说明

Notion API 大约每秒 3 次请求。本项目通过：

1. **page id 缓存**：未改动的文章不重渲
2. **限流 fetch**：并发约 2、请求间隔约 350ms，遇 429/529 按 `Retry-After` 退避重试
3. **API filter**：尽量只拉 Published + Post

若仍出现限流：不要反复 `pnpm sync --force`，等 1–2 分钟后再 `pnpm sync` / `pnpm dev`。

## 后续（未做）

- 密码文前端解锁
- 去掉本地 Markdown，只保留 Notion
- Mermaid / remark-toc 与 Notion HTML 渲染对齐
- Notion 官方 Webhook 签名校验（目前用共享 `REDEPLOY_SECRET`）
