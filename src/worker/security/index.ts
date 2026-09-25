/**
 * security/index.ts — 統合セキュリティミドルウェア。
 *
 * 全ての公開 endpoint で共通のセキュリティチェックを
 * 1つの関数呼び出しで実行する。
 *
 * 使用方法:
 *   const blocked = await runSecurityChecks(request, env, pathname);
 *   if (blocked) return blocked;
 *   // ... handler logic
 */
export { hasRateLimitCoverage, runSecurityChecks } from "./middleware";
export { RATE_LIMITS } from "./rate-limiter";
