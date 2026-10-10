import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTypesafeApiKey } from "../src/ops/jev-client";

test("キーは環境変数を優先し、ファイルを実行も展開もしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "nod-jev-"));
  const path = join(dir, "env");
  try {
    writeFileSync(path, 'OTHER=ignored\nexport TYPESAFE_API_KEY="$(touch /tmp/never-run)${HOME}"\n');
    expect(readTypesafeApiKey({ TYPESAFE_API_KEY: "env-key" }, path)).toBe("env-key");
    expect(readTypesafeApiKey({}, path)).toBe("$(touch /tmp/never-run)${HOME}");
    expect(readTypesafeApiKey({ TYPESAFE_API_KEY: "" }, path)).toBeNull();
    expect(readTypesafeApiKey({}, join(dir, "missing"))).toBeNull();
  } finally { rmSync(dir, { recursive: true }); }
});

import { createJevClient, JEV_MODEL } from "../src/ops/jev-client";
test("本文のみをNoul一問へ渡し固定版の確率と使用量を返す", async () => {
  let sent: any;
  const client = createJevClient({ apiKey: () => "fake-key", fetch: async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ model: JEV_MODEL, answers: { needs_spec: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 123, output_tokens: 5 } });
  } });
  const result = await client("本文");
  expect(sent.state).toBe("本文");
  expect(Object.keys(sent.questions)).toEqual(["needs_spec"]);
  expect(result).toMatchObject({ kind: "success", probability: 0.8, inputTokens: 123, model: JEV_MODEL });
});

test("外部のエラーや秘密値を返さず、HTTP失敗を分類して再試行しない", async () => {
  for (const [status, failureKind] of [[401,"authentication"],[403,"authentication"],[429,"rate_limit"],[402,"rate_limit"],[500,"http_error"]] as const) {
    let calls = 0;
    const result = await createJevClient({ apiKey: () => "secret-value", fetch: async () => { calls++; return new Response("secret-value", { status }); } })("本文");
    expect(result).toMatchObject({ kind: "failed", failureKind });
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(calls).toBe(1);
  }
});
test("確率・型・固定モデル・入力tokenの不正応答を拒否する", async () => {
  for (const value of ["0.5", -0.1, 1.1, null]) {
    const result = await createJevClient({ apiKey: () => "fake", fetch: async () => Response.json({ model: JEV_MODEL, answers: { needs_spec: { type: "noul", noul: value } }, usage: { input_tokens: 1 } }) })("本文");
    expect(result).toMatchObject({ kind: "failed", failureKind: "invalid_response" });
  }
  for (const data of [{}, {model: "jev-latest"}, {model:JEV_MODEL, answers:{needs_spec:{type:"score",noul:0.5}},usage:{input_tokens:1}}, {model:JEV_MODEL,answers:{needs_spec:{type:"noul",noul:0.5}},usage:{input_tokens:-1}}]) {
    expect(await createJevClient({ apiKey: () => "fake", fetch: async () => Response.json(data) })("本文")).toMatchObject({kind:"failed",failureKind:"invalid_response"});
  }
});
test("通信とJSON本文の待機を期限内で止め、再試行しない", async () => {
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const result = await createJevClient({ apiKey: () => "fake", timeoutMs: 10, fetch: async (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); } })("本文");
  expect(result).toMatchObject({ kind: "failed", failureKind: "timeout" });
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
  const stream = new ReadableStream({ start() {} });
  expect(await createJevClient({ apiKey: () => "fake", timeoutMs: 10, fetch: async () => new Response(stream) })("本文")).toMatchObject({kind:"failed", failureKind:"timeout"});
});
test("キー欠落は通信せず、通信例外の詳細を公開しない", async () => {
  let calls = 0;
  expect(await createJevClient({apiKey:()=>null,fetch:async()=>{calls++;throw Error("secret");}})("本文")).toMatchObject({kind:"failed",failureKind:"missing_key"});
  expect(calls).toBe(0);
  expect(await createJevClient({apiKey:()=>"fake",fetch:async()=>{throw Error("secret");}})("本文")).toMatchObject({kind:"failed",failureKind:"network"});
});
