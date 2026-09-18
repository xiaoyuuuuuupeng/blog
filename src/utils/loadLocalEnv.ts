import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let cached: Record<string, string> | null = null;

/**
 * Read project `.env*` files. Needed because Astro secret env vars are not
 * always present on `process.env` inside content loaders.
 */
export function loadLocalEnv(): Record<string, string> {
  if (cached) return cached;

  const result: Record<string, string> = {};
  const mode = process.env.NODE_ENV === "production" ? "production" : "development";
  const files = [`.env.${mode}.local`, `.env.local`, `.env.${mode}`, ".env"];

  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;

    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // First file in priority list wins; later files only fill gaps.
      if (!(key in result)) {
        result[key] = value;
      }
    }
  }

  cached = result;
  return result;
}

export function getLocalEnv(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  const fromFile = loadLocalEnv()[name]?.trim();
  return fromFile || undefined;
}
