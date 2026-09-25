import { describe, expect, it } from "vitest";

import {
  normalizeRakutenAggregateOffer,
  RAKUTEN_PRODUCT_PROVIDER,
  type RakutenProductSearchRecord,
} from "../../src/worker/adapters/rakuten-product";

const fetchedAt = new Date("2026-09-03T00:00:00.000Z");
const mapping = { productId: "rice-cooker:test", janCode: "4900000000000" };

function record(overrides: Partial<RakutenProductSearchRecord> = {}): RakutenProductSearchRecord {
  return {
    productId: "rakuten-product-id",
    productCode: mapping.janCode,
    affiliateUrl: "https://hb.afl.rakuten.co.jp/example",
    salesItemCount: 3,
    salesMinPrice: 19800,
    ...overrides,
  };
}

describe("normalizeRakutenAggregateOffer", () => {
  it("maps a JAN-matched purchasable aggregate result into a JPY offer", () => {
    const result = normalizeRakutenAggregateOffer(record(), mapping, fetchedAt);

    expect(result).toEqual({
      ok: true,
      offer: {
        productId: mapping.productId,
        providerKey: RAKUTEN_PRODUCT_PROVIDER,
        providerItemId: "rakuten-product-id",
        outboundUrl: "https://hb.afl.rakuten.co.jp/example",
        priceMinor: 19800,
        currency: "JPY",
        availability: "in_stock",
        updatedAt: fetchedAt.toISOString(),
      },
    });
  });

  it("rejects a provider result whose JAN does not match the curated mapping", () => {
    expect(
      normalizeRakutenAggregateOffer(record({ productCode: "4909999999999" }), mapping, fetchedAt)
    ).toEqual({ ok: false, reason: "jan_mismatch" });
  });

  it("rejects unavailable aggregate products instead of publishing a purchasable CTA", () => {
    expect(
      normalizeRakutenAggregateOffer(record({ salesItemCount: 0 }), mapping, fetchedAt)
    ).toEqual({ ok: false, reason: "no_purchasable_items" });
  });

  it("rejects missing or invalid aggregate price", () => {
    expect(
      normalizeRakutenAggregateOffer(record({ salesMinPrice: null }), mapping, fetchedAt)
    ).toEqual({ ok: false, reason: "invalid_price" });
    expect(
      normalizeRakutenAggregateOffer(record({ salesMinPrice: 12.5 }), mapping, fetchedAt)
    ).toEqual({ ok: false, reason: "invalid_price" });
  });

  it("requires an HTTPS affiliate URL", () => {
    expect(
      normalizeRakutenAggregateOffer(record({ affiliateUrl: null }), mapping, fetchedAt)
    ).toEqual({ ok: false, reason: "missing_affiliate_url" });
    expect(
      normalizeRakutenAggregateOffer(
        record({ affiliateUrl: "http://example.com/item" }),
        mapping,
        fetchedAt
      )
    ).toEqual({ ok: false, reason: "invalid_affiliate_url" });
  });
});
