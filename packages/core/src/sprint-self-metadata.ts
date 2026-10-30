import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { SprintClock } from "./sprint-types";
import { sprintHash } from "./sprint-validation";

// ファイルシステム境界の差し替え用。CLIにpath/identityの上書き入口は設けない。
export interface SprintSelfMetadataSource {
  threadId: string | undefined; terminal: string | undefined; cwd: string; collectorDigest: string;
  snapshots(): { filename: string; lines: Iterable<string> }[];
}
export interface SprintSelfMetadata {
  schemaVersion: 1; status: "observed" | "unknown"; reasons: string[];
  threadId: string | null; turnId: string | null; terminal: string | null; cwd: string | null;
  model: string | null; effort: string | null; provider: string | null; cliVersion: string | null;
  settingsAppliedAt: string | null; collectedAt: string; collectorDigest: string; metadataDigest: string | null;
  source: string; association: string;
}
type Shape = { [key: string]: true | Shape };
const recordFields: Record<string, Shape> = {
  session_meta: { id: true, timestamp: true, cwd: true, cli_version: true, originator: true, source: true, model_provider: true },
  turn_context: { turn_id: true, cwd: true, model: true, effort: true },
  token_usage_record: { thread_id: true, turn_id: true, session_id: true, root_turn_id: true },
  event_msg: { type: true, turn_id: true, started_at: true },
  thread_settings_applied: { type: true, thread_id: true, thread_settings: { cwd: true, model: true, model_provider_id: true, reasoning_effort: true } },
};

// 非許可値は構築もJSON.parseもしない。本文recordにはこのparser自体を呼ばない。
function project(text: string, shape: Shape): Record<string, any> {
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? "") && i < text.length) i++; };
  function stringEnd(): number {
    if (text[i++] !== '"') throw Error();
    while (i < text.length) { const c = text[i++]; if (c === "\\") i++; else if (c === '"') return i; }
    throw Error();
  }
  function skip(depth = 0): void {
    if (depth > 64) throw Error();
    space();
    if (text[i] === '"') { stringEnd(); return; }
    if (text[i] === "{" || text[i] === "[") {
      const close = text[i++] === "{" ? "}" : "]";
      space();
      while (text[i] !== close) {
        if (close === "}") { stringEnd(); space(); if (text[i++] !== ":") throw Error(); }
        skip(depth + 1); space();
        if (text[i] === close) break;
        if (text[i++] !== ",") throw Error(); space();
      }
      if (text[i++] !== close) throw Error(); return;
    }
    const start = i;
    while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
    if (i === start) throw Error();
  }
  function object(allowed: Shape): Record<string, any> {
    space(); if (text[i++] !== "{") throw Error();
    const result: Record<string, any> = {}, seen = new Set<string>(); space();
    while (text[i] !== "}") {
      const start = i; stringEnd(); const key = JSON.parse(text.slice(start, i)) as string;
      if (seen.has(key)) throw Error(); seen.add(key);
      space(); if (text[i++] !== ":") throw Error(); space();
      const entry = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
      if (entry && entry !== true) result[key] = object(entry);
      else if (entry === true) {
        const start = i;
        if (text[i] === "{" || text[i] === "[") throw Error();
        skip(); result[key] = JSON.parse(text.slice(start, i));
        if (result[key] !== null && typeof result[key] !== "string" && typeof result[key] !== "number") throw Error();
        if (typeof result[key] === "string" && /dcap_|\bsk-[A-Za-z0-9_-]{16,}|-----BEGIN .*KEY|\bBearer\s/i.test(result[key])) throw Error("unsafe_metadata_value");
      } else skip();
      space(); if (text[i] === "}") break;
      if (text[i++] !== ",") throw Error(); space();
    }
    i++; return result;
  }
  const result = object(shape); space(); if (i !== text.length) throw Error(); return result;
}
const typePrefix = /^\s*\{\s*"timestamp"\s*:\s*"[^"\n]+"\s*,\s*(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"([^"]+)"/;
function metadata(line: string): boolean {
  const kind = typePrefix.exec(line.slice(0, 1024))?.[1];
  return ["session_meta", "turn_context", "token_usage_record"].includes(kind ?? "")
    || (kind === "event_msg" && /"payload"\s*:\s*\{\s*"type"\s*:\s*"(?:task_started|task_complete|task_aborted|turn_aborted|thread_settings_applied)"/.test(line.slice(0, 1024)));
}
function* snapshot(path: string): Iterable<string> {
  const fd = openSync(path, "r");
  try {
    let remaining = fstatSync(fd).size, pending = "", retain = true;
    const buffer = Buffer.alloc(65536);
    while (remaining > 0) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!count) throw Error(); remaining -= count;
      // latin1 preserves byte boundaries; UTF-8 is decoded only for selected metadata.
      const chunk = buffer.subarray(0, count).toString("latin1");
      let start = 0;
      for (let end = 0; end <= chunk.length; end++) {
        if (end < chunk.length && chunk[end] !== "\n") continue;
        if (retain) pending += chunk.slice(start, end);
        if (pending.length > 1024 && !metadata(pending)) { pending = pending.slice(0, 1024); retain = false; }
        if (pending.length > 4 * 1024 * 1024) throw Error();
        if (end < chunk.length) {
          yield Buffer.from(pending, "latin1").toString("utf8") + "\n";
          pending = ""; retain = true;
        }
        start = end + 1;
      }
    }
    if (pending || !retain) yield pending; // 未完末尾は本文でもunknown。
  } finally { closeSync(fd); }
}
function defaultSource(): SprintSelfMetadataSource {
  const threadId = process.env.CODEX_THREAD_ID, terminal = process.env.ORCA_TERMINAL_HANDLE;
  // CODEX_HOMEはproviderの設定済みstate root。identityの上書きや任意thread pathの入口にはしない。
  const codexStateRoot = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return { threadId, terminal, cwd: process.cwd(),
    collectorDigest: createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"),
    snapshots() {
      if (!codexStateRoot.trim()) throw Error("configured_codex_home_invalid");
      const root = join(resolve(codexStateRoot), "sessions"), paths: string[] = [];
      const dirs = (path: string) => readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && /^\d+$/.test(e.name)).map(e => join(path, e.name));
      for (const year of dirs(root)) for (const month of dirs(year)) for (const day of dirs(month)) {
        for (const entry of readdirSync(day, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) paths.push(join(day, entry.name));
      }
      return paths.map(path => ({ filename: basename(path), lines: (function* () {
        if (lstatSync(path).isSymbolicLink()) throw Error(); yield* snapshot(path);
      })() }));
    } };
}
export function collectSprintSelfMetadata(source?: SprintSelfMetadataSource, clock: SprintClock = {}): SprintSelfMetadata {
  const result: SprintSelfMetadata = { schemaVersion: 1, status: "unknown", reasons: [], threadId: null, turnId: null,
    terminal: null, cwd: null, model: null, effort: null, provider: null, cliVersion: null, settingsAppliedAt: null,
    collectedAt: "", collectorDigest: "", metadataDigest: null, source: "自己threadのprovider保存metadata",
    association: "thread適用設定と同一active turnのcontext/usageの値を照合。同値settingsの前後順は許容し、context後の値変更は拒否。設定eventにturn IDはなく、上流provider内部処理の証明ではない" };
  const unknown = (reason: string) => { result.reasons.push(reason); };
  try {
    source ??= defaultSource(); result.collectorDigest = source.collectorDigest;
    if (!/^[0-9a-f-]{36}$/.test(source.threadId ?? "") || !/^term_[0-9a-f-]{36}$/.test(source.terminal ?? "")) throw Error("allowed_identity_missing");
    result.threadId = source.threadId!; result.terminal = source.terminal!; result.cwd = source.cwd;
    const candidates = source.snapshots();
    if (candidates.length !== 1) throw Error("unique_self_file_required");
    if (!candidates[0]!.filename.endsWith(`-${source.threadId}.jsonl`)) throw Error("filename_thread_mismatch");
    const records: Record<string, any>[] = [];
    let n = 0;
    for (const line of candidates[0]!.lines) {
      n++;
      if (!line.endsWith("\n")) { unknown("snapshot_incomplete"); continue; }
      if (!typePrefix.test(line.slice(0, 1024))) { unknown("unsupported_record_format"); continue; }
      if (!metadata(line)) { if (n === 1) throw Error("session_header_missing"); continue; }
      const kind = typePrefix.exec(line.slice(0, 1024))![1]!;
      const shape = kind === "event_msg" && /"payload"\s*:\s*\{\s*"type"\s*:\s*"thread_settings_applied"/.test(line.slice(0, 1024))
        ? recordFields.thread_settings_applied! : recordFields[kind]!;
      const record = project(line, { timestamp: true, type: true, payload: shape }); records.push(record);
      if (n === 1 && (record.type !== "session_meta" || record.payload?.id !== source.threadId || record.payload?.cwd !== source.cwd)) throw Error("session_header_identity_mismatch");
    }
    const header = records[0]?.payload;
    if (!header || header.cli_version !== "0.164.0" || header.source !== "cli" || header.originator !== "codex-tui") throw Error("unsupported_version_or_mode");
    result.cliVersion = header.cli_version;
    const starts = records.filter(r => r.type === "event_msg" && r.payload.type === "task_started");
    const start = starts.at(-1); if (typeof start?.payload.turn_id !== "string" || !start.payload.turn_id) throw Error("active_turn_missing");
    result.turnId = start.payload.turn_id;
    const active = records.slice(records.indexOf(start) + 1);
    if (active.some(r => ["turn_context", "token_usage_record"].includes(r.type) && r.payload.turn_id !== result.turnId)) unknown("active_turn_identity_mismatch");
    if (active.some(r => ["task_complete", "task_aborted", "turn_aborted"].includes(r.payload.type) && r.payload.turn_id === result.turnId)) unknown("active_turn_ended");
    const context = active.filter(r => r.type === "turn_context" && r.payload.turn_id === result.turnId).at(-1);
    const usage = active.filter(r => r.type === "token_usage_record" && r.payload.turn_id === result.turnId).at(-1);
    const settings = records.filter(r => r.payload.type === "thread_settings_applied").at(-1);
    if (!context || !usage || !settings) throw Error("active_metadata_missing");
    const c = context.payload, u = usage.payload, s = settings.payload.thread_settings;
    if (u.thread_id !== source.threadId || u.session_id !== source.threadId || u.root_turn_id !== result.turnId || settings.payload.thread_id !== source.threadId) unknown("provider_identity_mismatch");
    if (c.cwd !== source.cwd || s?.cwd !== source.cwd) unknown("metadata_cwd_mismatch");
    if (![c.model, c.effort, s?.model_provider_id].every(v => typeof v === "string" && v.length > 0)
      || s.model_provider_id !== header.model_provider) unknown("applied_value_missing");
    if (c.model !== s?.model || c.effort !== s?.reasoning_effort) unknown("settings_mismatch");
    if (records.slice(records.indexOf(context) + 1).some(r => r.payload.type === "thread_settings_applied"
      && (r.payload.thread_id !== source!.threadId || r.payload.thread_settings?.cwd !== source!.cwd || r.payload.thread_settings?.model !== c.model
        || r.payload.thread_settings?.reasoning_effort !== c.effort || r.payload.thread_settings?.model_provider_id !== header.model_provider))) unknown("settings_changed_after_context");
    if (![start.timestamp, context.timestamp, usage.timestamp, settings.timestamp].every(t => typeof t === "string" && Number.isFinite(Date.parse(t)))) unknown("metadata_time_missing");
    result.model = typeof c.model === "string" ? c.model : null; result.effort = typeof c.effort === "string" ? c.effort : null;
    result.provider = typeof s?.model_provider_id === "string" ? s.model_provider_id : null;
    result.settingsAppliedAt = settings.timestamp ?? null;
    result.metadataDigest = sprintHash({ header: records[0], start, context, usage, settings });
    if (!result.reasons.length) result.status = "observed";
  } catch (error) {
    const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "metadata_read_unavailable";
    unknown(reason);
  }
  result.collectedAt = (clock.now ?? new Date()).toISOString(); return result;
}
