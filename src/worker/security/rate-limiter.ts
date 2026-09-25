/**
 * 公開 endpoint の rate limit モジュール。
 *
 * Cloudflare Native Rate Limiting bindingを優先し、未設定endpointは既存KVへfallbackする。
 * KVはeventual consistencyのため厳密カウンタではない。Native bindingもCloudflareの
 * ドキュメント上permissive/eventually consistentだが、repo内の非原子read-modify-write
 * 競合を回避できる。
 *
 * 受入条件:
 * - 正当利用を阻害しないキー/窓/上限
 * - rate limit 超過時の HTTP 429 + Retry-After
 * - Production binding設定はコード変更と分離
 */
import type { NativeRateLimitBinding } from "../env";
import { json } from "../http";

// ──────────────────────────────────────────────
// Rate limit 設定
// ──────────────────────────────────────────────

export interface RateLimitConfig {
  /** 窓サイズ（ミリ秒） */
  windowMs: number;
  /** 窓あたりの最大リクエスト数 */
  maxRequests: number;
  /** 超過時の Retry-After（秒） */
  retryAfterSeconds: number;
}

/**
 * endpoint ごとの rate limit 設定。
 * Native bindingを有効化する場合も、この値とwrangler側のsimple.limit/periodを一致させる。
 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  /** /go — アフィリエイトリダイレクト。bot による click 汚染防止。 */
  "/go": {
    windowMs: 60_000, // 1分
    maxRequests: 30, // 1分間に30回まで
    retryAfterSeconds: 60,
  },
  /** /img — 画像プロキシ。cache-busting/帯域濫用防止。 */
  "/img": {
    windowMs: 60_000, // 1分
    maxRequests: 60, // 1分間に60回まで
    retryAfterSeconds: 60,
  },
  /** /api/diagnosis/evaluate — 診断API。大量リクエスト時の保護。 */
  "/api/diagnosis/evaluate": {
    windowMs: 60_000, // 1分
    maxRequests: 20, // 1分間に20回まで
    retryAfterSeconds: 60,
  },
};

function rateLimitedResponse(config: RateLimitConfig): Response {
  const retryAfter = config.retryAfterSeconds;
  const now = Date.now();
  const bucket = Math.floor(now / config.windowMs);
  return json(
    { error: "rate_limited", retryAfter },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(config.maxRequests),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(((bucket + 1) * config.windowMs) / 1000)),
      },
    }
  );
}

function rateLimitActorKey(request: Request, path: string): string {
  // 現行KV実装との識別単位を変えない。CloudflareはIP keyを推奨していないため、
  // 将来ユーザー/tenant識別子が導入された時は別Issueで移行する。
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return `${path}:${ip}`;
}

/**
 * Cloudflare Native Rate Limiting bindingを使う。
 * binding側がperiod/windowを所有するので、キーへminute bucketは含めない。
 */
export async function checkNativeRateLimit(
  request: Request,
  path: string,
  binding: NativeRateLimitBinding,
  config: RateLimitConfig
): Promise<{ allowed: boolean; response?: Response }> {
  const { success } = await binding.limit({ key: rateLimitActorKey(request, path) });
  if (!success) {
    return { allowed: false, response: rateLimitedResponse(config) };
  }
  return { allowed: true };
}

// ──────────────────────────────────────────────
// KV fallback rate limiter
// ──────────────────────────────────────────────

/**
 * 固定窓レート制限を KV で実装する。
 * - キー: `{path}:{ip}:{minuteBucket}`
 * - 上限超過時: 429 + Retry-After
 *
 * Native bindingが無いendpointの互換fallback。非原子read-modify-writeのため、
 * ProductionではNative bindingへの移行を推奨する。
 */
export async function checkRateLimit(
  request: Request,
  path: string,
  kv: KVNamespace,
  config: RateLimitConfig
): Promise<{ allowed: boolean; response?: Response }> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = Date.now();
  const minuteBucket = Math.floor(now / config.windowMs);

  const key = `${path}:${ip}:${minuteBucket}`;

  try {
    const current = await kv.get(key, "text");
    const count = current ? Number.parseInt(current, 10) : 0;

    if (count >= config.maxRequests) {
      return { allowed: false, response: rateLimitedResponse(config) };
    }

    await kv.put(key, String(count + 1), {
      expirationTtl: Math.ceil(config.windowMs / 1000) * 2,
    });

    return {
      allowed: true,
      response: undefined,
    };
  } catch {
    // runtime KV障害時は既存契約どおりrate limitをfail-openにする。
    return { allowed: true };
  }
}

/**
 * endpoint パスから適用すべき rate limit 設定を取得する。
 * マッチしない場合は undefined を返す（rate limit なし）。
 */
export function getRateLimitConfig(pathname: string):
  | {
      path: string;
      config: RateLimitConfig;
    }
  | undefined {
  if (RATE_LIMITS[pathname]) {
    return { path: pathname, config: RATE_LIMITS[pathname] };
  }

  for (const [prefix, config] of Object.entries(RATE_LIMITS)) {
    if (pathname.startsWith(prefix + "/") || pathname === prefix) {
      return { path: prefix, config };
    }
  }

  return undefined;
}
