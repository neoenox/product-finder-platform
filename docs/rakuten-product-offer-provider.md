# Rakuten Product Search aggregate offer contract

Status: **code scaffold only / disabled in Production**

This document fixes the provider semantics for Issue #16 before credentials or Production configuration are introduced.

## Provider decision

Use **Rakuten Product Search API (2025-08-01)** as the first permitted MVP price source, but only as a **JAN-level marketplace aggregate**.

It is not a seller-specific offer source. `salesMinPrice` means the purchasable minimum price aggregated for the Rakuten product, and the returned `productId` identifies the Rakuten product, not an individual shop listing.

Provider key: `rakuten-product-aggregate`.

## Official contract used

- Product Search accepts `productCode` as a JAN code.
- `applicationId` and the new `accessKey` are required.
- `affiliateId` is optional at the API level, but this project requires it before publishing a CTA so the returned HTTPS `affiliateUrl` is available.
- Output fields used by this project are `productId`, `productCode`, `affiliateUrl`, `salesItemCount`, and `salesMinPrice`.
- Rakuten documents `salesMinPrice` as the purchasable minimum price and `salesItemCount` as the count of purchasable items.
- Price/availability data may be cached for up to 24 hours. Other API data may be cached for up to three months.
- Displayed price/availability must be refreshed at least weekly. When updates are less frequent than hourly, the acquisition time and the required price/availability disclaimer must be displayed next to the information.
- API data is to be used to introduce Rakuten products and link to the corresponding Rakuten page.
- Other providers may be shown alongside Rakuten data when the provider/source is identified, but Rakuten API data must not be repurposed to create another provider's affiliate link.

Official references:

- https://webservice.rakuten.co.jp/documentation/ichiba-product-search
- https://webservice.faq.rakuten.net/hc/ja/articles/900001974363
- https://webservice.faq.rakuten.net/hc/ja/articles/900001970786
- Rakuten Web Service FAQ article: 「各APIから取得したデータを表示する場合、どのくらいの頻度で更新する必要がありますか？」

## Fail-closed normalization

`normalizeRakutenAggregateOffer()` publishes an offer only when all of the following are true:

1. the returned JAN exactly matches a curated JAN mapping;
2. a Rakuten product ID exists;
3. `salesItemCount > 0`;
4. `salesMinPrice` is a positive safe integer;
5. an HTTPS affiliate URL exists.

JPY is a zero-decimal currency, so a returned `19800` is stored as `priceMinor: 19800`; it is not divided by 100.

## Architecture boundary

The current ingest contract publishes **products and offers together in one catalog version**. An offer-only adapter that returns no products would fail the product quality gates or risk replacing a healthy catalog with an incomplete version.

Therefore this branch intentionally does **not** wire Rakuten networking into `getAdapter()` or scheduled ingestion yet.

The safe next integration is one of:

- a composite rice-cooker adapter that keeps the complete curated product set and augments it with Rakuten aggregate offers, or
- a separate offer-refresh pipeline that updates offers without replacing the product catalog.

The second option is preferred if multiple commerce providers will be added.

## Remaining prerequisites before enabling

- Add verified JAN mappings for curated products. Never infer a JAN from a model number.
- Create/approve Rakuten `applicationId`, `accessKey`, and affiliate ID outside the repository. This task does not create them.
- Add server-side secret bindings; never expose `accessKey` to the browser or logs.
- Implement request throttling/retry behavior and provider failure isolation.
- Add UI source labeling such as 「楽天市場・購入可能最低価格」 so the aggregate price cannot be mistaken for one seller's quote.
- Add acquisition timestamp/disclaimer display required by the chosen refresh cadence.
- Keep existing stale/out-of-stock/currency/redirect fail-closed policy.

Until these prerequisites are complete, `ManualRiceCookerAdapter` remains the production adapter and continues returning no live offers.
