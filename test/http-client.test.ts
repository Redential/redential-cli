import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "../src/http-client.js";
import { NetworkError } from "../src/errors.js";

const originalFetch = globalThis.fetch;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;
const originalProxy: Record<string, string | undefined> = {};
for (const key of proxyKeys) {
  originalProxy[key] = process.env[key];
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of proxyKeys) {
    const value = originalProxy[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function jsonOk(): Response {
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}

describe("http-client proxy dispatcher (#83 slice 1)", () => {
  it("does not pass a dispatcher when no proxy env is set", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const fetchMock = vi.fn(async () => jsonOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postJson("https://example.test/api", {});

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init.dispatcher).toBeUndefined();
  });

  it("passes a dispatcher when HTTP_PROXY is set", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTP_PROXY = "http://127.0.0.1:8888";
    const fetchMock = vi.fn(async () => jsonOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postJson("https://example.test/api", {});

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init.dispatcher).toBeDefined();
  });

  it("passes a dispatcher when only HTTPS_PROXY is set", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = "http://127.0.0.1:8888";
    const fetchMock = vi.fn(async () => jsonOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postJson("https://example.test/api", {});

    const init = fetchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(init.dispatcher).toBeDefined();
  });

  it("reuses one EnvHttpProxyAgent across calls", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTP_PROXY = "http://127.0.0.1:8888";
    const fetchMock = vi.fn(async () => jsonOk());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postJson("https://example.test/a", {});
    await postJson("https://example.test/b", {});

    const first = (fetchMock.mock.calls[0][1] as Record<string, unknown>).dispatcher;
    const second = (fetchMock.mock.calls[1][1] as Record<string, unknown>).dispatcher;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe("http-client reach errors (#83 slice 2)", () => {
  it("names connection refused from error.code, never error.message", async () => {
    const leak = "Bearer extremely-secret-token";
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error(`connect failed ${leak}`), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;

    await expect(postJson("https://example.test/api", {})).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NetworkError);
      const message = (err as Error).message;
      expect(message).toBe("Could not reach example.test: connection refused.");
      expect(message).not.toContain(leak);
      return true;
    });
  });

  it("names a TLS failure from cause.code", async () => {
    const leak = "https://evil.test/callback?token=abc";
    globalThis.fetch = vi.fn(async () => {
      const cause = Object.assign(new Error(`unable to verify ${leak}`), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }) as unknown as typeof fetch;

    await expect(postJson("https://example.test/api", {})).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NetworkError);
      const message = (err as Error).message;
      expect(message).toContain("could not verify TLS certificate");
      expect(message).toContain("docs/corporate-networks.md");
      expect(message).not.toContain(leak);
      return true;
    });
  });

  it("names proxy required on HTTP 407", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("Proxy-Authenticate: Basic", { status: 407 })
    ) as unknown as typeof fetch;

    await expect(postJson("https://example.test/api", {})).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NetworkError);
      const message = (err as Error).message;
      expect(message).toBe("Could not reach example.test: proxy required.");
      expect(message).not.toContain("Proxy-Authenticate");
      expect(message).not.toContain("Basic");
      return true;
    });
  });

  it("names proxy required when CONNECT is not 200 (UND_ERR_ABORTED)", async () => {
    const leak = "Proxy response (407) !== 200 when HTTP Tunneling";
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error(leak), { code: "UND_ERR_ABORTED" });
    }) as unknown as typeof fetch;

    await expect(postJson("https://example.test/api", {})).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NetworkError);
      const message = (err as Error).message;
      expect(message).toBe("Could not reach example.test: proxy required.");
      expect(message).not.toContain("407");
      expect(message).not.toContain("Tunneling");
      return true;
    });
  });

  it("names a TLS failure for UND_ERR_PRX_TLS", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error("tls connection to a proxy failed"), { code: "UND_ERR_PRX_TLS" });
    }) as unknown as typeof fetch;

    await expect(postJson("https://example.test/api", {})).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as Error).message).toContain("could not verify TLS certificate");
      expect((err as Error).message).not.toContain("proxy failed");
      return true;
    });
  });

  it("keeps the generic reach message when the code is unknown", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error("socket hang up with a token=xyz"), { code: "ECONNRESET" });
    }) as unknown as typeof fetch;

    await expect(postJson("https://example.test/api", {})).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).toBe("Could not reach example.test.");
      expect((err as Error).message).not.toContain("token=xyz");
      return true;
    });
  });
});
