import { expect, test } from "bun:test";
import * as core from "../src/index";

const thread = "11111111-1111-4111-8111-111111111111";
const terminal = "term_22222222-2222-4222-8222-222222222222";
const cwd = "/専用作業場所";
const at = "2026-10-28T03:00:00.000Z";
function line(type: string, payload: unknown, timestamp = at) { return JSON.stringify({ timestamp, ordinal: 1, type, payload }) + "\n"; }
function records() {
  return [
    line("session_meta", { id: thread, cwd, cli_version: "0.164.0", originator: "codex-tui", source: "cli", model_provider: "openai", instructions: { secret: "会話秘密" } }),
    line("event_msg", { type: "task_started", turn_id: "現在turn" }),
    line("turn_context", { turn_id: "現在turn", cwd, model: "gpt-6.1-sol", effort: "high", instructions: "context秘密" }),
    line("event_msg", { type: "thread_settings_applied", thread_id: thread, thread_settings: { cwd, model: "gpt-6.1-sol", reasoning_effort: "high", model_provider_id: "openai", prompt: "settings秘密" } }, "2026-10-28T03:00:00.001Z"),
    line("token_usage_record", { thread_id: thread, turn_id: "現在turn", session_id: thread, root_turn_id: "現在turn", tool: "usage秘密" }),
    '{"timestamp":"2026-10-28T03:00:00.002Z","type":"response_item","payload": this is deliberately not JSON 会話本文\n',
  ];
}
function source(lines = records()) {
  return { threadId: thread, terminal, cwd, collectorDigest: "a".repeat(64),
    snapshots: () => [{ filename: `rollout-2026-10-28T12-00-00-${thread}.jsonl`, lines }] };
}

test("自己metadataだけを返し、本文とmetadata内の非許可値はdigestにも含めない", () => {
  const first = core.collectSprintSelfMetadata(source(), { now: new Date(at) });
  expect(first).toMatchObject({ status: "observed", threadId: thread, turnId: "現在turn", terminal, cwd,
    model: "gpt-6.1-sol", effort: "high", provider: "openai", settingsAppliedAt: "2026-10-28T03:00:00.001Z" });
  const changed = records().map(s => s.replaceAll("秘密", "別の値").replace("会話本文", "別の本文"));
  const second = core.collectSprintSelfMetadata(source(changed), { now: new Date(at) });
  expect(second.metadataDigest).toBe(first.metadataDigest);
  expect(JSON.stringify(first)).not.toMatch(/秘密|instructions|prompt|tool|会話本文/);
});

test("active turn後の別turn metadataは過去の一致へ戻さず取得不能にする", () => {
  const actual = core.collectSprintSelfMetadata(source([...records(), line("turn_context", {
    turn_id: "別turn", cwd, model: "gpt-6.1-sol", effort: "high",
  })]));
  expect(actual).toMatchObject({ status: "unknown", reasons: ["active_turn_identity_mismatch"] });
});

test("欠測・未完・設定変更・終了turn・未対応形式を理由付きunknownに保つ", () => {
  const cases = [
    source(records().filter(s => !s.includes('"token_usage_record"'))),
    source([...records(), "未完本文"]),
    source([...records(), line("event_msg", { type: "task_complete", turn_id: "現在turn" })]),
    source(records().map(s => s.replace('"effort":"high"', '"effort":"low"'))),
    source(records().map(s => s.replace('"cwd":"/専用作業場所"', '"cwd":"/別場所"'))),
    source(records().map(s => s.replace('"cli_version":"0.164.0"', '"cli_version":"9.0.0"'))),
    source(records().map(s => s.replace('"source":"cli"', '"source":"exec"'))),
    source(records().map(s => s.replace('"session_id":"'+thread+'"', '"session_id":"別thread"'))),
    source([...records(), line("event_msg", { type: "thread_settings_applied", thread_id: thread, thread_settings: { cwd, model: "別model", reasoning_effort: "high", model_provider_id: "openai" } }), records()[3]!]),
    { ...source(), snapshots: () => [] },
    { ...source(), snapshots: () => [...source().snapshots(), ...source().snapshots()] },
    { ...source(), snapshots: () => { throw Error("権限なし"); } },
    { ...source(), threadId: undefined },
    source([...records(), '{"type":"turn_context","timestamp":"2026-10-28T03:00:01Z","payload":{"turn_id":"別turn"}}\n']),
  ];
  for (const input of cases) {
    const actual = core.collectSprintSelfMetadata(input);
    expect(actual.status).toBe("unknown"); expect(actual.reasons.length).toBeGreaterThan(0);
  }
});

test("metadataの許可項目はrecord種別ごとに投影し、別種別のfield値も取り込まない", () => {
  const normal = core.collectSprintSelfMetadata(source());
  const altered = records().map(s => s.includes('"turn_context"') ? s.replace('"instructions":"context秘密"', '"instructions":"context秘密","source":"非許可の本文","session_id":"非許可ID"') : s);
  expect(core.collectSprintSelfMetadata(source(altered)).metadataDigest).toBe(normal.metadataDigest);
});

test("context後にcwdが変更され戻った場合も古いcontextのまま一致にしない", () => {
  const changed = line("event_msg", { type: "thread_settings_applied", thread_id: thread,
    thread_settings: { cwd: "/別cwd", model: "gpt-6.1-sol", reasoning_effort: "high", model_provider_id: "openai" } });
  const actual = core.collectSprintSelfMetadata(source([...records(), changed, records()[3]!]));
  expect(actual).toMatchObject({ status: "unknown", reasons: ["settings_changed_after_context"] });
});

test("許可fieldへ資格情報らしい値が混入したmetadataも出力とdigestへ入れない", () => {
  const actual = core.collectSprintSelfMetadata(source(records().map(s => s.replace('"effort":"high"', '"effort":"dcap_forbidden_value"'))));
  expect(actual.status).toBe("unknown"); expect(actual.metadataDigest).toBeNull();
  expect(JSON.stringify(actual)).not.toContain("dcap_forbidden_value");
});

test("既知recordでも設定値の型が未対応なら観測済みにしない", () => {
  const actual = core.collectSprintSelfMetadata(source(records().map(s => s.replaceAll('"model":"gpt-6.1-sol"', '"model":42'))));
  expect(actual.status).toBe("unknown"); expect(actual.model).toBeNull();
});
