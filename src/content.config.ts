import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { glob } from "astro/loaders";
import { notionPageSchema } from "@astro-notion/loader";
import config from "@/config";
import { notionBlogLoader } from "@/loaders/notionBlogLoader";

export const BLOG_PATH = "src/content/posts";

const posts = defineCollection({
  loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: `./${BLOG_PATH}` }),
  schema: ({ image }) =>
    z.object({
      author: z.string().default(config.site.author),
      pubDatetime: z.date(),
      modDatetime: z.date().optional().nullable(),
      title: z.string(),
      featured: z.boolean().optional(),
      draft: z.boolean().optional(),
      tags: z.array(z.string()).default(["others"]),
      ogImage: image().or(z.string()).optional(),
      description: z.string(),
      canonicalURL: z.string().optional(),
      hideEditPost: z.boolean().optional(),
      timezone: z.string().optional(),
      category: z.string().optional(),
    }),
});

/** Notion CMS source. Soft-disabled when NOTION_TOKEN / NOTION_DATABASE_ID are unset. */
const notionPosts = defineCollection({
  loader: notionBlogLoader({
    imageSavePath: "assets/images/notion",
  }),
  // Loose page schema: property names vary; adaptation happens in getAllPosts().
  schema: notionPageSchema({
    properties: z.record(z.string(), z.any()),
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: "**/[^_]*.{md,mdx}", base: "./src/content/pages" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    ogImage: z.string().optional(),
    canonicalURL: z.string().optional(),
  }),
});

export const collections = { posts, notionPosts, pages };
