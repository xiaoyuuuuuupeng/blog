import type { APIRoute } from "astro";
import { getLocalEnv } from "@/utils/loadLocalEnv";

export const prerender = false;

const DEBOUNCE_MS = 60_000;
let lastTriggeredAt = 0;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function extractSecret(request: Request, url: URL): string | undefined {
  const header = request.headers.get("authorization")?.trim();
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || undefined;
  }

  const custom = request.headers.get("x-redeploy-secret")?.trim();
  if (custom) return custom;

  const query = url.searchParams.get("secret")?.trim();
  return query || undefined;
}

async function handleRedeploy(request: Request): Promise<Response> {
  const secret = getLocalEnv("REDEPLOY_SECRET");
  const hookUrl = getLocalEnv("VERCEL_DEPLOY_HOOK_URL");

  if (!secret || !hookUrl) {
    return json(503, {
      ok: false,
      error: "not_configured",
      detail:
        "Set REDEPLOY_SECRET and VERCEL_DEPLOY_HOOK_URL on the server (Vercel env).",
    });
  }

  const provided = extractSecret(request, new URL(request.url));
  if (!provided || provided !== secret) {
    return json(401, { ok: false, error: "unauthorized" });
  }

  const now = Date.now();
  if (now - lastTriggeredAt < DEBOUNCE_MS) {
    return json(202, {
      ok: true,
      triggered: false,
      reason: "debounced",
      retryAfterSeconds: Math.ceil(
        (DEBOUNCE_MS - (now - lastTriggeredAt)) / 1000
      ),
    });
  }

  const upstream = await fetch(hookUrl, { method: "POST" });
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return json(502, {
      ok: false,
      error: "deploy_hook_failed",
      status: upstream.status,
      detail: text.slice(0, 300),
    });
  }

  lastTriggeredAt = now;
  return json(200, { ok: true, triggered: true });
}

export const POST: APIRoute = ({ request }) => handleRedeploy(request);

/** Convenience for Notion buttons / quick manual checks that only support GET. */
export const GET: APIRoute = ({ request }) => handleRedeploy(request);
