import { describe, expect, test } from "bun:test";
import { ApiError, apiFetch, type FetchLike } from "./client";

function stub(status: number, body: string | null) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status });
  };
  return { calls, fetchImpl };
}

describe("apiFetch", () => {
  test("/api を前置して GET し、JSON を返す", async () => {
    const s = stub(200, JSON.stringify({ ok: 1 }));
    expect(await apiFetch<{ ok: number }>("/issues", {}, s.fetchImpl)).toEqual({ ok: 1 });
    expect(s.calls[0]?.url).toBe("/api/issues");
    expect(s.calls[0]?.init?.method).toBe("GET");
  });

  test("body を JSON にして送る", async () => {
    const s = stub(200, "{}");
    await apiFetch("/issues/API-1/answer", { method: "POST", body: { text: "はい" } }, s.fetchImpl);
    expect(s.calls[0]?.init?.method).toBe("POST");
    expect(s.calls[0]?.init?.body).toBe(JSON.stringify({ text: "はい" }));
    expect(s.calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
  });

  test("エラーの本文から code と message を取り出す", async () => {
    const s = stub(404, JSON.stringify({ error: { code: "NOT_FOUND", message: "API-1 はありません" } }));
    const err = await apiFetch("/issues/API-1", {}, s.fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: "NOT_FOUND", message: "API-1 はありません" });
  });

  test("JSON でないエラーは HTTP_ERROR にする", async () => {
    const s = stub(502, "<html>Bad Gateway</html>");
    const err = await apiFetch("/issues", {}, s.fetchImpl).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: "HTTP_ERROR", message: "HTTP 502" });
  });

  test("本文が空の成功は null を返す", async () => {
    const s = stub(204, null);
    expect(await apiFetch("/views/1", { method: "DELETE" }, s.fetchImpl)).toBeNull();
  });
});
