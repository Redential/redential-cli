import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "../src/http-client.js";

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
