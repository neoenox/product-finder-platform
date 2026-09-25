import { corsHeaders, json } from "./http";
import type { Env } from "./env";
import {
  handleCategories,
  handleConfig,
  handleEvaluate,
  handleProductDetail,
  handleReady,
} from "./api";
import { handleRedirect } from "./redirect";
import { handleDevSeed } from "./dev-seed";
import { handleImageProxy } from "./image-proxy";
import { hasRateLimitCoverage, runSecurityChecks } from "./security";

const MAX_JSON_BODY_BYTES = 32 * 1024;

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("payload_too_large");
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

/**
 * API・リダイレクト・SPA フォールバックの共通ルーティング。
 * 処理対象外のパスでは null を返し、呼び出し側（Worker / Pages _worker）が
 * 404 応答または ASSETS へのフォールバックを判断する。
 */
export async function handleRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const isApi = pathname.startsWith("/api/");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Security checks (rate limit, bot detection, etc.)
  const blocked = await runSecurityChecks(request, env, pathname);
  if (blocked) return blocked;

  if (isApi) {
    if (pathname === "/api/health" || pathname === "/api/health/") {
      return json({ ok: true, service: "product-finder-platform", ts: new Date().toISOString() });
    }
    if (pathname === "/api/ready" || pathname === "/api/ready/") {
      // /health はプロセス生存確認、/ready は実トラフィックを受けられるかの確認。
      // 全rate-limit対象endpointがNative bindingまたはKV fallbackで保護されない場合は
      // DB/catalogが正常でもready=trueにしない。ローカルloopbackのみ明示bypassを許可する。
      const localBypass = env.RATE_LIMIT_BYPASS === "1" && isLoopbackHost(url.hostname);
      if (!hasRateLimitCoverage(env) && !localBypass) {
        return json(
          {
            ok: false,
            service: "product-finder-platform",
            error: "rate_limit_unavailable",
            checks: {
              rateLimitCoverage: false,
              rateLimitKv: Boolean(env.KV),
            },
          },
          { status: 503 }
        );
      }
      return handleReady(env);
    }
    if (pathname === "/api/dev/seed" || pathname === "/api/dev/seed/") {
      // ローカル開発/e2e専用。設定ミスで公開環境にDEV_SEEDが入っても実行しない。
      const isLoopback = isLoopbackHost(url.hostname);
      if (env.DEV_SEED !== "1" || !isLoopback) {
        return json({ error: "forbidden" }, { status: 403 });
      }
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      return handleDevSeed(env);
    }
    if (pathname === "/api/config" || pathname === "/api/config/") {
      return handleConfig(request, env);
    }
    if (pathname === "/api/categories" || pathname === "/api/categories/") {
      return handleCategories(env);
    }
    if (pathname === "/api/diagnosis/evaluate" || pathname === "/api/diagnosis/evaluate/") {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const declaredLength = Number(request.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
        return json({ error: "payload_too_large" }, { status: 413 });
      }
      const rawBody = await readBodyWithLimit(request, MAX_JSON_BODY_BYTES);
      if (rawBody === null) {
        return json({ error: "payload_too_large" }, { status: 413 });
      }
      let body: unknown = null;
      try {
        body = JSON.parse(rawBody) as unknown;
      } catch {
        // handleEvaluateの共通invalid_request応答へ渡す
      }
      return handleEvaluate(env, body);
    }
    const productMatch = pathname.match(/^\/api\/products\/([^/]+)\/?$/);
    if (productMatch && productMatch[1]) {
      const productId = decodePathSegment(productMatch[1]);
      if (productId === null) return json({ error: "invalid_path_encoding" }, { status: 400 });
      return handleProductDetail(env, productId);
    }
    return json({ error: "not_found", path: pathname }, { status: 404 });
  }

  const redirectMatch = pathname.match(/^\/go\/([^/]+)\/([^/]+)\/?$/);
  if (redirectMatch && redirectMatch[1] && redirectMatch[2]) {
    const providerKey = decodePathSegment(redirectMatch[1]);
    const token = decodePathSegment(redirectMatch[2]);
    if (providerKey === null || token === null) {
      return json({ error: "invalid_path_encoding" }, { status: 400 });
    }
    return handleRedirect(env, request, providerKey, token);
  }

  // 商品画像のプロキシ（一部メーカーの直リンクブロック対策）
  if (pathname === "/img" || pathname === "/img/") {
    return handleImageProxy(request);
  }

  return null;
}
