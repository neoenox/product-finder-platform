import { describe, expect, it, vi } from "vitest";

import type { Env, NativeRateLimitBinding } from "../../src/worker/env";
import { handleRequest } from "../../src/worker/handler";
import { hasRateLimitCoverage, runSecurityChecks } from "../../src/worker/security";

function envWithoutKv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ...overrides,
  };
}

function nativeBinding(success = true): NativeRateLimitBinding {
  return {
    limit: vi.fn().mockResolvedValue({ success }),
  };
}

function kvBinding(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

describe("service readiness rate-limit coverage", () => {
  it("fails closed on a public host when all rate-limit bindings are missing", async () => {
    const response = await handleRequest(
      new Request("https://pitariko.example/api/ready"),
      envWithoutKv()
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    await expect(response!.json()).resolves.toEqual({
      ok: false,
      service: "product-finder-platform",
      error: "rate_limit_unavailable",
      checks: {
        rateLimitCoverage: false,
        rateLimitKv: false,
      },
    });
  });

  it("does not let RATE_LIMIT_BYPASS mask missing production coverage", async () => {
    const response = await handleRequest(
      new Request("https://pitariko.example/api/ready"),
      envWithoutKv({ RATE_LIMIT_BYPASS: "1" })
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
  });

  it.each([
    ["/go/provider/token", "GET"],
    ["/img", "GET"],
    ["/api/diagnosis/evaluate", "POST"],
  ] as const)(
    "fails closed on public hosts for %s without endpoint coverage",
    async (pathname, method) => {
      for (const bypass of [undefined, "0", "01", "1"] as const) {
        const request = new Request(`https://pitariko.example${pathname}`, {
          method,
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        const response = await handleRequest(
          request,
          envWithoutKv(bypass === undefined ? {} : { RATE_LIMIT_BYPASS: bypass })
        );

        expect(response).not.toBeNull();
        expect(response!.status).toBe(503);
        await expect(response!.json()).resolves.toMatchObject({
          error: "rate_limit_unavailable",
        });
      }
    }
  );

  it("treats KV as complete fallback coverage", () => {
    expect(hasRateLimitCoverage(envWithoutKv({ KV: kvBinding() }))).toBe(true);
  });

  it("treats all three native bindings as complete coverage without KV", () => {
    expect(
      hasRateLimitCoverage(
        envWithoutKv({
          RATE_LIMIT_GO: nativeBinding(),
          RATE_LIMIT_IMG: nativeBinding(),
          RATE_LIMIT_DIAGNOSIS: nativeBinding(),
        })
      )
    ).toBe(true);
  });

  it("rejects partial native coverage when KV fallback is absent", () => {
    expect(
      hasRateLimitCoverage(
        envWithoutKv({
          RATE_LIMIT_GO: nativeBinding(),
          RATE_LIMIT_IMG: nativeBinding(),
        })
      )
    ).toBe(false);
  });
});

describe("native rate-limit execution", () => {
  it("returns 429 when the endpoint native binding rejects the request", async () => {
    const response = await runSecurityChecks(
      new Request("https://pitariko.example/go/provider/token", {
        headers: { "CF-Connecting-IP": "203.0.113.1" },
      }),
      envWithoutKv({ RATE_LIMIT_GO: nativeBinding(false) }),
      "/go/provider/token"
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("Retry-After")).toBe("60");
    await expect(response!.json()).resolves.toMatchObject({ error: "rate_limited" });
  });

  it("prefers the native binding and does not touch KV when native succeeds", async () => {
    const kv = kvBinding();
    const native = nativeBinding(true);

    const response = await runSecurityChecks(
      new Request("https://pitariko.example/go/provider/token", {
        headers: { "CF-Connecting-IP": "203.0.113.2" },
      }),
      envWithoutKv({ KV: kv, RATE_LIMIT_GO: native }),
      "/go/provider/token"
    );

    expect(response).toBeNull();
    expect(native.limit).toHaveBeenCalledTimes(1);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("falls back to KV when a native binding throws at runtime", async () => {
    const kv = kvBinding();
    const native: NativeRateLimitBinding = {
      limit: vi.fn().mockRejectedValue(new Error("native unavailable")),
    };

    const response = await runSecurityChecks(
      new Request("https://pitariko.example/go/provider/token", {
        headers: { "CF-Connecting-IP": "203.0.113.3" },
      }),
      envWithoutKv({ KV: kv, RATE_LIMIT_GO: native }),
      "/go/provider/token"
    );

    expect(response).toBeNull();
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it("keeps the documented runtime fail-open policy if native fails and KV is absent", async () => {
    const native: NativeRateLimitBinding = {
      limit: vi.fn().mockRejectedValue(new Error("native unavailable")),
    };

    const response = await runSecurityChecks(
      new Request("https://pitariko.example/go/provider/token"),
      envWithoutKv({ RATE_LIMIT_GO: native }),
      "/go/provider/token"
    );

    expect(response).toBeNull();
  });
});
