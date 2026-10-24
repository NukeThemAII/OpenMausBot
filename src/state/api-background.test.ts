import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudAsleep, markCloudAsleep, resetCloudPowerForTests } from "../lib/cloud-power";
import { api, ApiError } from "./store";

afterEach(() => { vi.unstubAllGlobals(); resetCloudPowerForTests(); });

describe("api() and a Cloud home that sleeps", () => {
  it("marks background polls, and leaves every other request as before", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api("/api/team-map", { background: true });
    await api("/api/threads");
    await api("/api/upload", { method: "PUT", headers: { "x-omb-sha256": "abc" } });
    const sent = fetch.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(sent[0].get("x-omb-background")).toBe("1");
    expect(sent[0].get("content-type")).toBe("application/json");
    expect(sent[1].get("x-omb-background")).toBeNull();
    expect(sent[1].get("content-type")).toBe("application/json");
    expect(sent[2].get("content-type")).toBeNull();
    expect(sent[2].get("x-omb-sha256")).toBe("abc");
  });

  it("never sends a background poll while the home sleeps; anything else wakes it", async () => {
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    markCloudAsleep(undefined);
    await expect(api("/api/team-map", { background: true })).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
    await api("/api/threads");
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/auth/session", "/api/threads"]);
    expect(cloudAsleep()).toBe(false);
  });

  it("goes quiet on the home's asleep answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "asleep" }), { status: 503, headers: { "x-omb-cloud-power": "asleep" } })));
    await expect(api("/api/sync")).rejects.toBeInstanceOf(ApiError);
    expect(cloudAsleep()).toBe(true);
  });
});
