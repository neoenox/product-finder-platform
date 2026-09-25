import type { ProductOffer } from "../../shared/domain/types";

export const RAKUTEN_PRODUCT_PROVIDER = "rakuten-product-aggregate";

/**
 * Rakuten Product Search (2025-08-01) のうち、価格CTAに必要な最小フィールド。
 * seller別の商品ではなく、JAN単位の楽天市場集約製品レコードとして扱う。
 */
export interface RakutenProductSearchRecord {
  productId: string | null;
  productCode: string | null;
  affiliateUrl: string | null;
  salesItemCount: number | null;
  salesMinPrice: number | null;
}

export interface RakutenJanMapping {
  /** 自サイトの安定 productId */
  productId: string;
  /** 公式情報等で確認したJANコード。推測値は禁止。 */
  janCode: string;
}

export type RakutenOfferRejectReason =
  | "jan_mismatch"
  | "missing_provider_product_id"
  | "no_purchasable_items"
  | "invalid_price"
  | "missing_affiliate_url"
  | "invalid_affiliate_url";

export type RakutenOfferNormalizeResult =
  { ok: true; offer: ProductOffer } | { ok: false; reason: RakutenOfferRejectReason };

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * JANで取得した楽天Product Search結果を、既存ProductOfferへfail-closedで正規化する。
 *
 * salesMinPrice は「購入可能な最低価格」という製品集約値であり、個別ショップの
 * seller offer ではない。providerKey に aggregate と明記して意味を固定する。
 */
export function normalizeRakutenAggregateOffer(
  record: RakutenProductSearchRecord,
  mapping: RakutenJanMapping,
  fetchedAt: Date
): RakutenOfferNormalizeResult {
  if (record.productCode !== mapping.janCode) {
    return { ok: false, reason: "jan_mismatch" };
  }
  if (!record.productId) {
    return { ok: false, reason: "missing_provider_product_id" };
  }
  if (record.salesItemCount === null || record.salesItemCount <= 0) {
    return { ok: false, reason: "no_purchasable_items" };
  }
  if (
    record.salesMinPrice === null ||
    !Number.isSafeInteger(record.salesMinPrice) ||
    record.salesMinPrice <= 0
  ) {
    return { ok: false, reason: "invalid_price" };
  }
  if (!record.affiliateUrl) {
    return { ok: false, reason: "missing_affiliate_url" };
  }
  if (!isHttpsUrl(record.affiliateUrl)) {
    return { ok: false, reason: "invalid_affiliate_url" };
  }

  return {
    ok: true,
    offer: {
      productId: mapping.productId,
      providerKey: RAKUTEN_PRODUCT_PROVIDER,
      providerItemId: record.productId,
      outboundUrl: record.affiliateUrl,
      // JPY is a zero-decimal currency. Existing priceMinor stores the integer
      // amount as returned by the provider; do not divide by 100.
      priceMinor: record.salesMinPrice,
      currency: "JPY",
      availability: "in_stock",
      updatedAt: fetchedAt.toISOString(),
    },
  };
}
