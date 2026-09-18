import { getCollection, type CollectionEntry } from "astro:content";
import config from "@/config";
import { BLOG_PATH } from "@/content.config";
import { getLocalEnv } from "./loadLocalEnv";
import { slugifyStr } from "./slugify";

function hasNotionCredentials(): boolean {
  return Boolean(
    getLocalEnv("NOTION_TOKEN") && getLocalEnv("NOTION_DATABASE_ID")
  );
}

export type LocalPost = CollectionEntry<"posts">;
export type NotionPost = CollectionEntry<"notionPosts">;

/** Shared post shape used by list/detail pages after Notion adaptation. */
export type BlogPost = LocalPost | AdaptedNotionPost;

export type PostData = LocalPost["data"] & {
  category?: string;
};

export type AdaptedNotionPost = Omit<NotionPost, "id" | "data" | "collection"> & {
  id: string;
  collection: "notionPosts";
  data: PostData;
};

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
        if (item && typeof item === "object" && "name" in item) {
          return String((item as { name: unknown }).name ?? "");
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
    if ("multi_select" in obj) return asString(obj.multi_select);
    if ("date" in obj) return asString(obj.date);
    if ("start" in obj) return asString(obj.start);
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

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    // Raw Notion date property: { type: "date", date: { start, end, time_zone } }
    if ("date" in obj && obj.date != null) {
      return parseDate(obj.date);
    }
    if ("start" in obj) {
      return parseDate(obj.start);
    }
  }
  return null;
}

function resolvePubDatetime(
  properties: Record<string, unknown>,
  entry: NotionPost
): Date {
  const dateValue = pickProp(properties, [
    "date",
    "Date",
    "日期",
    "pubDate",
    "PubDate",
    "发布时间",
  ]);
  const fromProp = parseDate(dateValue);
  if (fromProp) return fromProp;

  // Fall back to Notion page timestamps — never use "now" (import/sync time).
  const pageData = entry.data as Record<string, unknown>;
  const fromCreated = parseDate(pageData.created_time);
  if (fromCreated) return fromCreated;

  const fromEdited = parseDate(pageData.last_edited_time);
  if (fromEdited) return fromEdited;

  return new Date(0);
}

function adaptNotionPost(entry: NotionPost): AdaptedNotionPost | null {
  const properties = (entry.data.properties ?? {}) as Record<string, unknown>;

  const password = asString(
    pickProp(properties, ["password", "Password", "密码"])
  );
  if (password) return null;

  const status = asString(pickProp(properties, ["status", "Status", "状态"]));
  if (status && status !== "Published") return null;

  const type = asString(pickProp(properties, ["type", "Type", "类型"]));
  if (type && type !== "Post") return null;

  const title =
    asString(pickProp(properties, ["title", "Title", "Name", "名称"])) ||
    "Untitled";
  let slug =
    asString(pickProp(properties, ["slug", "Slug", "URL", "url"])) ||
    slugifyStr(title) ||
    `notion-${entry.id.replace(/-/g, "").slice(0, 8)}`;
  const summary = asString(
    pickProp(properties, [
      "summary",
      "Summary",
      "description",
      "Description",
      "摘要",
    ])
  );
  const category = asString(
    pickProp(properties, ["category", "Category", "分类"])
  );
  const tagsRaw = pickProp(properties, ["tags", "Tags", "标签"]);
  let tags: string[] = [];
  if (Array.isArray(tagsRaw)) {
    tags = tagsRaw
      .map(tag => asString(tag))
      .flatMap(tag => tag.split(","))
      .map(tag => tag.trim())
      .filter(Boolean);
  } else if (tagsRaw && typeof tagsRaw === "object" && "multi_select" in (tagsRaw as object)) {
    tags = asString(tagsRaw)
      .split(",")
      .map(tag => tag.trim())
      .filter(Boolean);
  } else {
    const single = asString(tagsRaw);
    tags = single ? [single] : ["others"];
  }

  const pubDatetime = resolvePubDatetime(properties, entry);

  // Prefer Notion last_edited_time for "updated", not sync time.
  const modDatetime =
    parseDate((entry.data as Record<string, unknown>).last_edited_time) ?? null;

  return {
    ...entry,
    id: slug,
    collection: "notionPosts",
    data: {
      author: config.site.author,
      pubDatetime,
      modDatetime,
      title,
      featured: false,
      draft: false,
      tags: tags.length > 0 ? tags : ["others"],
      description: summary || title,
      hideEditPost: true,
      ...(category ? { category } : {}),
    },
  };
}

function localRouteKey(post: LocalPost): string {
  const segments =
    post.filePath
      ?.replace(BLOG_PATH, "")
      .split("/")
      .filter(path => path !== "")
      .filter(path => !path.startsWith("_"))
      .slice(0, -1)
      .map(segment => slugifyStr(segment)) ?? [];
  const idParts = post.id.split("/");
  const slug = idParts.length > 0 ? String(idParts[idParts.length - 1]) : post.id;
  return segments.length > 0 ? [...segments, slug].join("/") : slug;
}

function assertNoRouteCollisions(local: LocalPost[], notion: BlogPost[]) {
  const localKeys = new Map(local.map(post => [localRouteKey(post), post.id]));
  for (const post of notion) {
    const key = post.id;
    const conflict = localKeys.get(key);
    if (conflict) {
      throw new Error(
        `[notion-cms] Route collision on /posts/${key}/ between local "${conflict}" and Notion slug "${post.id}".`
      );
    }
  }
}

/**
 * Local Markdown posts + Notion CMS posts (when credentials are configured).
 */
export async function getAllPosts(): Promise<BlogPost[]> {
  const local = await getCollection("posts");

  if (!hasNotionCredentials()) {
    return local;
  }

  let notionRaw: NotionPost[] = [];
  try {
    notionRaw = await getCollection("notionPosts");
  } catch {
    notionRaw = [];
  }

  const notion: AdaptedNotionPost[] = [];
  const seenSlugs = new Map<string, string>();

  for (const entry of notionRaw) {
    const adapted = adaptNotionPost(entry);
    if (!adapted) continue;

    let slug = adapted.id;
    const previous = seenSlugs.get(slug);
    if (previous) {
      slug = `${slug}-${entry.id.replace(/-/g, "").slice(0, 6)}`;
    }
    seenSlugs.set(slug, entry.id);
    notion.push({ ...adapted, id: slug });
  }

  assertNoRouteCollisions(local, notion);
  return [...local, ...notion];
}

export function isNotionPost(post: BlogPost): post is AdaptedNotionPost {
  return post.collection === "notionPosts";
}
