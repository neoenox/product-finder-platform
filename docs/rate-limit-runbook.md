# Rate Limit & Bot Protection Runbook

## 概要

公開 endpoint の濫用耐性を、repo 内実装と Cloudflare edge 側設定の役割を明確にして管理する。

## Threat Model

| Endpoint                  | Threat                             | Impact                           | 対策                             |
| ------------------------- | ---------------------------------- | -------------------------------- | -------------------------------- |
| `/go/:provider/:token`    | bot による click 連打              | click_events 汚染、D1 write 増加 | rate limit + dedup               |
| `/img`                    | cache-busting query による帯域濫用 | Cloudflare 帯域コスト増加        | rate limit + query normalization |
| `/api/diagnosis/evaluate` | 大量リクエスト                     | D1 read 増加、CPU 時間消費       | rate limit                       |

## Repo 内 Rate Limit (Native 優先 + KV fallback)

Cloudflare Workers Native Rate Limiting binding が対象 endpoint に設定されている場合は Native binding を優先する。未設定 endpoint、または Native runtime 障害時に `KV` binding が利用可能なら、既存 KV 固定窓 limiter を compatibility fallback として使用する。

Production の Native binding / namespace ID はこの repo のコード変更だけでは有効化しない。設定値・read-back・429 実測まで含む移行ゲートは [`docs/native-rate-limit-migration.md`](./native-rate-limit-migration.md) を正とする。

### 設定値

| Path                      | Window | Max Requests | Retry-After |
| ------------------------- | ------ | ------------ | ----------- |
| `/go`                     | 60s    | 30           | 60s         |
| `/img`                    | 60s    | 60           | 60s         |
| `/api/diagnosis/evaluate` | 60s    | 20           | 60s         |

Native binding 側の `simple.limit` / `simple.period` も上表と一致させる。3 endpoint group は異なる上限を持つため、Production 移行時は個別 binding として設定・検証する。

### KV Namespace (compatibility fallback)

既存 `KV` namespace は Native migration 中の fallback と click dedup 用途を兼ねる。Native rate limit を有効化した後も、click dedup が KV を使用するため、単純に `KV` binding を削除しない。

```jsonc
// wrangler.worker.jsonc
{
  "kv_namespaces": [{ "binding": "KV", "id": "..." }],
}
```

### 適用手順

Native migration を行わない現行環境では、KV fallback の既存手順を維持する:

1. Cloudflare Dashboard で KV namespace を作成
2. wrangler に binding を追加
3. `wrangler deploy` でデプロイ
4. 正常リクエストが通ることを確認
5. 閾値超過時に 429 が返ることを確認

Native migration を行う場合は上記を直接置き換えず、`docs/native-rate-limit-migration.md` の Production completion gate に従う。

## Cloudflare WAF/Rate Limiting (Edge 側)

### 推奨設定

Cloudflare Dashboard > Security > WAF > Rate limiting rules:

#### `/go` endpoint

```
Rule: (http.request.uri.path eq "/go")
Rate: 30 requests / 60 seconds
Counting expression: ip.addr
Action: Managed Challenge (60s)
Burst: 10
```

#### `/img` endpoint

```
Rule: (http.request.uri.path eq "/img")
Rate: 60 requests / 60 seconds
Counting expression: ip.addr
Action: Managed Challenge (60s)
Burst: 20
```

#### `/api/diagnosis/evaluate`

```
Rule: (http.request.uri.path eq "/api/diagnosis/evaluate")
Rate: 20 requests / 60 seconds
Counting expression: ip.addr
Action: Block (429)
Burst: 5
```

### 適用前の確認

1. 利用中の Cloudflare plan で必要な Rate Limiting / WAF 機能と制限を公式 dashboard/docs で確認する
2. 正常ユーザーが rate limit に引っかからないことを確認
3. Bot の検出ロジックが過剰でないことを確認

## Click Events Retention

### 保持期間

- **90日**: 月次・四半期の分析に十分
- 90日以降は `cleanupExpiredClicks()` で自動削除

### 削除手順

Cron job (scheduled handler) から `cleanupExpiredClicks()` を呼び出す:

```typescript
// src/worker/scheduled.ts
import { cleanupExpiredClicks } from "./click-retention";

export async function handleScheduled(env: Env): Promise<void> {
  await cleanupExpiredClicks(env);
}
```

### 削除の安全性

- 削除はバッチで行い（1回100行）、active redirect をブロックしない
- 既存の分析クエリは集約済みデータを使用するため、raw データ削除の影響なし

## Rate Limit 超過時の HTTP 応答

```json
{
  "error": "rate_limited",
  "retryAfter": 60
}
```

**レスポンスヘッダー:**

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1692633600
```

## Bot 対策

### 現状の方針

- アプリケーション内のUAパターン判定は実装しない（以前の `isLikelyBot` はどの経路からも呼ばれない死蔵コードだったため削除済み）。
- bot対策は **rate limit（Native優先・KV fallback）+ click dedup（5秒窓）** と、Cloudflare WAF の edge 側ルール（下記）で担う。

### Click dedup の識別子（日次saltローテーション）

click dedup の識別子は生の IP/UA を直接ハッシュせず、**日次saltを組み合わせたsalted hash** とする
（Issue #64。実装: `src/worker/click-retention.ts`）。

```
identifier = SHA-256("{dailySalt}:{cf-connecting-ip}:{user-agent}")
KV dedupキー = click_dedup:{identifier}:{providerKey}:{providerItemId}
```

| 項目             | 設定値                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| salt生成         | `crypto.randomUUID()`（存在しない場合のみ生成）                         |
| ローテーション幅 | **UTC 日次**（キー `click_dedup_salt:{YYYY-MM-DD}` にUTC日付 embedded） |
| salt保持期間     | KV TTL **48時間**（旧salt掃除用。ローテーション境界はUTC 0時）          |
| 保存内容         | salt込みSHA-256識別子のみ。生IP/UAは保存・ログ出力しない                |

保証:

- 同一ユーザー・同一日内 → 同一salt → 同一識別子 → 5秒窓のデュープ検出が機能する
- 異なる日 → saltが異なるため識別子が衝突しない（日跨ぎ直前後の5秒もデュープされない）
- KV障害時はエフェメラルsaltへフォールバックし、dedupが効かなくなるだけで正当クリックは落とさない（fail-open）

### 注意事項

- IP/UA を保存しない（プライバシー最小化）。click_events には商品・バージョン・時刻のみ記録する。
- rate-limit coverage 自体が無い設定不整合（対象 Native binding も KV も無い）は公開 host で503 fail-closedする。
- Native runtime 障害時は KV があれば fallback し、KV も利用不能な runtime 障害は既存方針どおり可用性優先で fail-open する。設定欠損と runtime 障害を混同しない。

## 監視

### アラート条件

- rate limit 超過が 1分間に 100 回以上
- click_events の日次追加行数が 10,000 行以上
- D1 read/write の異常増加

### 確認コマンド

```bash
# rate limit ログ確認
wrangler tail --env production | grep "rate_limited"

# click_events 行数確認
wrangler d1 execute product-finder-platform --command "SELECT COUNT(*) FROM click_events"

# 古い click_events の削除確認
wrangler d1 execute product-finder-platform --command "SELECT COUNT(*) FROM click_events WHERE clicked_at < datetime('now', '-90 days')"
```

## 変更履歴

| 日付       | 変更                                          | 理由           |
| ---------- | --------------------------------------------- | -------------- |
| 2026-08-21 | 初版作成                                      | Issue #26 対応 |
| 2026-08-24 | click dedup 識別子を日次salt込みSHA-256に変更 | Issue #64 対応 |
| 2026-09-03 | Native優先 + KV fallback の移行契約を追記     | Issue #73 対応 |
