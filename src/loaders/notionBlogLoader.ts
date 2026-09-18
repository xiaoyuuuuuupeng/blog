import type { Loader, LoaderContext } from "astro/loaders";
import {
  notionLoader,
  type NotionLoaderOptions,
} from "@astro-notion/loader";
import { getLocalEnv } from "@/utils/loadLocalEnv";
import { createNotionRateLimitedFetch } from "@/utils/notionRateLimitedFetch";

type StoreEntry = Parameters<LoaderContext["store"]["set"]>[0];

function env(name: string): string | undefined {
  return getLocalEnv(name);
}

function asString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "plain_text" in item) {
          return String((item as { plain_text: unknown }).plain_text ?? "");
        }
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.plain_text === "string") return obj.plain_text.trim();
    if ("title" in obj) return asString(obj.title);
    if ("rich_text" in obj) return asString(obj.rich_text);
    if ("name" in obj && typeof obj.name === "string") return obj.name.trim();
    if ("select" in obj) return asString(obj.select);
    if ("status" in obj) return asString(obj.status);
    if ("multi_select" in obj && Array.isArray(obj.multi_select)) {
      return obj.multi_select
        .map(item => asString(item))
        .filter(Boolean)
        .join(",");
    }
  }
  return "";
}

function pickProp(
  properties: Record<string, unknown>,
  names: string[]
): unknown {
  for (const name of names) {
    if (
      Object.prototype.hasOwnProperty.call(properties, name) &&
      properties[name] != null &&
      properties[name] !== ""
    ) {
      return properties[name];
    }
  }
  return undefined;
}

function shouldSkipEntry(
  entry: StoreEntry,
  logger: LoaderContext["logger"]
): boolean {
  const data = entry.data as { properties?: Record<string, unknown> };
  const properties = data.properties ?? {};

  const password = asString(
    pickProp(properties, ["password", "Password", "密码"])
  );
  if (password) {
    logger.info(`Skip password-protected Notion page ${entry.id.slice(0, 8)}`);
    return true;
  }

  const status = asString(
    pickProp(properties, ["status", "Status", "状态"])
  );
  if (status && status !== "Published") {
    return true;
  }

  const type = asString(pickProp(properties, ["type", "Type", "类型"]));
  if (type && type !== "Post") {
    return true;
  }

  return false;
}

/**
 * Prefer keeping Notion page UUIDs as store ids so `@astro-notion/loader`
 * can reuse digests/cache. URL slugs are applied later in `getAllPosts()`.
 *
 * Remapping store ids to slug previously busted the cache every sync and
 * re-rendered ~100+ pages in parallel → Notion rate limits.
 */
export function notionBlogLoader(
  options: Partial<NotionLoaderOptions> = {}
): Loader {
  return {
    name: "notion-blog-loader",
    async load(context) {
      const auth = options.auth ?? env("NOTION_TOKEN");
      const database_id = options.database_id ?? env("NOTION_DATABASE_ID");

      if (!auth || !database_id) {
        context.logger.info(
          "Notion CMS skipped: set NOTION_TOKEN and NOTION_DATABASE_ID to enable."
        );
        return;
      }

      // Narrow the query to Published posts when possible (fewer block fetches).
      const filteredOptions: Partial<NotionLoaderOptions> = {
        ...options,
        auth,
        database_id,
        collectionName: "notion-posts",
        imageSavePath: options.imageSavePath ?? "assets/images/notion",
        // Queue Notion HTTP calls (~3 req/s) even when the loader renders in parallel.
        fetch: options.fetch ?? createNotionRateLimitedFetch(),
        filter:
          options.filter ??
          ({
            and: [
              {
                property: "status",
                status: { equals: "Published" },
              },
              {
                property: "type",
                select: { equals: "Post" },
              },
            ],
          } as NotionLoaderOptions["filter"]),
      };

      const runInner = async (loaderOptions: Partial<NotionLoaderOptions>) => {
        const inner = notionLoader(loaderOptions as NotionLoaderOptions);
        await inner.load!(context);
      };

      try {
        await runInner(filteredOptions);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isRateLimited =
          message.includes("rate limited") || message.includes("rate_limited");
        const isFilterError =
          message.includes("filter") ||
          message.includes("Could not find property") ||
          message.includes("is expected to be");

        if (isRateLimited) {
          context.logger.warn(
            "Notion API rate limited — keeping existing Notion cache if any. Wait 1–2 minutes before syncing again (avoid --force)."
          );
          return;
        }

        if (isFilterError && !options.filter) {
          context.logger.warn(
            `Notion filter for status/type failed (${message}). Retrying without API filter.`
          );
          try {
            await runInner({
              ...filteredOptions,
              filter: undefined,
            });
          } catch (retryError) {
            const retryMessage =
              retryError instanceof Error
                ? retryError.message
                : String(retryError);
            if (
              retryMessage.includes("rate limited") ||
              retryMessage.includes("rate_limited")
            ) {
              context.logger.warn(
                "Notion API rate limited — keeping existing Notion cache if any."
              );
              return;
            }
            throw retryError;
          }
        } else {
          throw error;
        }
      }

      // Drop non-publishable pages from the store; keep page UUID ids for cache.
      let kept = 0;
      for (const pageId of [...context.store.keys()]) {
        const entry = context.store.get(pageId);
        if (!entry) continue;
        if (shouldSkipEntry(entry, context.logger)) {
          context.store.delete(pageId);
          continue;
        }
        kept += 1;
      }

      context.logger.info(
        `Notion CMS ready: ${kept} post(s) cached by page id (slugs applied at read time)`
      );
    },
  };
}
