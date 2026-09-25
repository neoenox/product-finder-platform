export interface NativeRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  /** Rate limit / dedup 用 KV namespace。Native binding未設定endpointのfallbackにも使う。 */
  KV?: KVNamespace;
  /** Cloudflare Native Rate Limiting: /go = 30 requests / 60s */
  RATE_LIMIT_GO?: NativeRateLimitBinding;
  /** Cloudflare Native Rate Limiting: /img = 60 requests / 60s */
  RATE_LIMIT_IMG?: NativeRateLimitBinding;
  /** Cloudflare Native Rate Limiting: /api/diagnosis/evaluate = 20 requests / 60s */
  RATE_LIMIT_DIAGNOSIS?: NativeRateLimitBinding;
  /** カンマ区切りの公開有効カテゴリキー。未設定なら全カテゴリを有効とする。 */
  ENABLED_CATEGORIES?: string;
  /** ローカル開発/e2e専用。本番には設定しないこと（/api/dev/seed の有効化） */
  DEV_SEED?: string;
  /** ローカル開発専用。rate limit binding未設定時のfail-closedを回避 */
  RATE_LIMIT_BYPASS?: string;
}
