/**
 * Notion API averages ~3 requests/second per integration.
 * Wrap `fetch` so `@notionhq/client` (used by @astro-notion/loader) stays under that budget.
 */

type FetchLike = typeof fetch;

export type NotionFetchOptions = {
  /** Max in-flight Notion requests. Default 2. */
  concurrency?: number;
  /** Minimum gap between starting requests (ms). Default 350 (~2.8/s). */
  minIntervalMs?: number;
  /** Max attempts including the first try. Default 5. */
  maxAttempts?: number;
};

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (!Number.isNaN(asNumber) && asNumber >= 0) return asNumber;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, (asDate - Date.now()) / 1000);
  }
  return null;
}

export function createNotionRateLimitedFetch(
  options: NotionFetchOptions = {}
): FetchLike {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 350);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);

  let active = 0;
  let lastStart = 0;
  const waiters: Array<() => void> = [];

  const pump = () => {
    while (active < concurrency && waiters.length > 0) {
      const next = waiters.shift();
      if (next) next();
    }
  };

  const acquire = async () => {
    if (active >= concurrency) {
      await new Promise<void>(resolve => waiters.push(resolve));
    }
    active += 1;

    const elapsed = Date.now() - lastStart;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastStart = Date.now();
  };

  const release = () => {
    active = Math.max(0, active - 1);
    pump();
  };

  const rateLimitedFetch: FetchLike = async (input, init) => {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      await acquire();
      try {
        const response = await fetch(input, init);
        if (response.status !== 429 && response.status !== 529) {
          return response;
        }

        const retryAfter =
          parseRetryAfterSeconds(response.headers.get("retry-after")) ??
          Math.min(30, 2 ** attempt);
        const jitter = Math.random() * 250;
        await sleep(retryAfter * 1000 + jitter);

        // Consume body so the connection can close cleanly before retry.
        await response.arrayBuffer().catch(() => undefined);
        lastError = new Error(
          `Notion API ${response.status}; retrying (attempt ${attempt}/${maxAttempts})`
        );
      } catch (error) {
        lastError = error;
        await sleep(Math.min(10_000, 500 * 2 ** (attempt - 1)));
      } finally {
        release();
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "Notion fetch failed"));
  };

  return rateLimitedFetch;
}
