/**
 * security/middleware.ts — 統合セキュリティチェック。
 *
 * リクエストに対して以下のチェックを順に実行し、
 * いずれかでブロックされたら即座にエラー応答を返す。
 *
 * 1. Rate limit (Native binding preferred, KV fallback)
 * 2. Bot detection (UA pattern)
 * 3. Redirect guard (fetchWithRedirectGuard) は個別 handler 内
 */
import type { Env, NativeRateLimitBinding } from "../env";
import { json } from "../http";
import { checkNativeRateLimit, checkRateLimit, getRateLimitConfig } from "./rate-limiter";

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function nativeBindingForPath(env: Env, path: string): NativeRateLimitBinding | undefined {
  switch (path) {
    case "/go":
      return env.RATE_LIMIT_GO;
    case "/img":
      return env.RATE_LIMIT_IMG;
    case "/api/diagnosis/evaluate":
      return env.RATE_LIMIT_DIAGNOSIS;
    default:
      return undefined;
  }
}

/**
 * 全rate-limit対象endpointがNative bindingまたはKV fallbackで保護されるか。
 */
export function hasRateLimitCoverage(env: Env): boolean {
  if (env.KV) return true;
  return Boolean(env.RATE_LIMIT_GO && env.RATE_LIMIT_IMG && env.RATE_LIMIT_DIAGNOSIS);
}

/**
 * 全セキュリティチェックを実行する。
 * @returns Response = ブロックされた（呼び出し側はそのまま返す）、null = 通過
 */
export async function runSecurityChecks(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  const rateLimit = getRateLimitConfig(pathname);
  if (!rateLimit) return null;

  const nativeBinding = nativeBindingForPath(env, rateLimit.path);
  if (nativeBinding) {
    try {
      const result = await checkNativeRateLimit(
        request,
        rateLimit.path,
        nativeBinding,
        rateLimit.config
      );
      return !result.allowed && result.response ? result.response : null;
    } catch {
      // Native runtime failure時、KVがあれば既存fallbackへ退避する。
      // KVも無ければ既存runtime障害ポリシー同様、可用性優先でfail-open。
      if (!env.KV) return null;
    }
  }

  // Missing endpoint coverage is a configuration failure. Only loopback requests
  // with an explicit development bypass may proceed.
  if (!env.KV) {
    const url = new URL(request.url);
    const localBypass = env.RATE_LIMIT_BYPASS === "1" && isLoopbackHost(url.hostname);
    if (!localBypass) {
      return json({ error: "rate_limit_unavailable", path: rateLimit.path }, { status: 503 });
    }
    return null;
  }

  const result = await checkRateLimit(request, rateLimit.path, env.KV, rateLimit.config);
  return !result.allowed && result.response ? result.response : null;
}
