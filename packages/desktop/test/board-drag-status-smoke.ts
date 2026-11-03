// 実Desktopの入力→API保存→表示→再読み込みを通す手動起動の受入テスト。
// 先に隔離アプリのBoardを開き、最新のスクリーンショットから座標を指定する。
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  origin: { type: "string" }, issue: { type: "string" }, "data-dir": { type: "string" },
  "window-id": { type: "string" }, from: { type: "string" }, to: { type: "string" },
  output: { type: "string" }, app: { type: "string", default: "io.github.machamp0714.nod" },
  status: { type: "string", default: "in_progress" }, column: { type: "string", default: "In Progress" },
} });
function required(name: keyof typeof values): string {
  const value = values[name];
  assert(value, `--${name} が必要です`);
  return value;
}
function point(value: string): [number, number] {
  const parts = value.split(",").map(Number);
  assert(parts.length === 2 && parts.every(Number.isFinite), "座標は x,y で指定してください");
  return [parts[0]!, parts[1]!];
}
assert.equal(process.platform, "darwin", "実macOS DesktopとOrca Computer Useの権限が必要です");
const origin = new URL(required("origin"));
assert(origin.protocol === "http:" && origin.hostname === "127.0.0.1", "隔離したloopback APIだけを使用します");
const issue = required("issue");
const dataDir = resolve(required("data-dir"));
const output = resolve(required("output"));
const windowId = required("window-id");
const from = point(required("from")), to = point(required("to"));
mkdirSync(output); // 既存の証拠を上書きしない。

interface Observation {
  ok: boolean;
  error?: { message: string };
  result?: { snapshot?: { treeText?: string }; screenshot?: { path?: string }; action?: unknown };
}
const evidence: Record<string, unknown> = { issue, origin: origin.origin, dataDir, windowId,
  from, to, expectedStatus: values.status, expectedColumn: values.column, startedAt: new Date().toISOString() };
function save(name: string, value: unknown): void {
  writeFileSync(`${output}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}
function observe(name: string, args: string[]): Observation {
  const result = Bun.spawnSync(["orca", "computer", ...args, "--app", values.app!, "--window-id", windowId, "--json"],
    { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString() || result.stdout.toString());
  const observation = JSON.parse(result.stdout.toString()) as Observation;
  save(name, observation);
  assert(observation.ok, observation.error?.message ?? "native観測に失敗しました");
  const screenshot = observation.result?.screenshot?.path;
  if (screenshot) copyFileSync(screenshot, `${output}/${name}.png`);
  return observation;
}
interface SavedIssue { workspace: string; status: string }
async function api<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, origin));
  assert(response.ok, `${path}: HTTP ${response.status} ${await response.clone().text()}`);
  return response.json() as Promise<T>;
}
function inColumn(observation: Observation): boolean {
  const lines = (observation.result?.snapshot?.treeText ?? "").split("\n");
  const start = lines.findIndex(line => line.trim().replace(/^\d+ /, "") === `container ${values.column}`);
  if (start < 0) return false;
  const indent = lines[start]!.match(/^\s*/)?.[0].length ?? 0;
  const end = lines.findIndex((line, index) => index > start && line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent);
  return lines.slice(start + 1, end < 0 ? undefined : end).some(line => line.includes(`Text: ${issue} `));
}
async function visible(name: string): Promise<void> {
  const until = Date.now() + 6_000;
  let attempt = 0;
  do {
    if (inColumn(observe(`${name}-${++attempt}`, ["get-app-state"]))) return;
    await Bun.sleep(100);
  } while (Date.now() < until);
  assert.fail(`${issue} が ${values.column} 列に表示されません`);
}

try {
  const before = await api<SavedIssue>(`/api/issues/${encodeURIComponent(issue)}`);
  const workspaces = await api<{ key: string; path: string }[]>("/api/workspaces");
  assert(workspaces.some(w => w.key === before.workspace && w.path.startsWith(dataDir + sep)),
    "対象Issueが指定した隔離データのWorkspaceにありません");
  assert.notEqual(before.status, values.status, "既に移動先の状態です。成功済みデータを再利用しないでください");
  save("api-before", before);
  observe("before", ["get-app-state", "--restore-window"]);
  const action = observe("drag", ["drag", "--from-x", String(from[0]), "--from-y", String(from[1]),
    "--to-x", String(to[0]), "--to-y", String(to[1])]);
  evidence.nativeAction = action.result?.action; // 入力の未検証メタデータもそのまま残す。
  let after = await api<SavedIssue>(`/api/issues/${encodeURIComponent(issue)}`);
  const until = Date.now() + 6_000;
  while (after.status !== values.status && Date.now() < until) {
    await Bun.sleep(100);
    after = await api<SavedIssue>(`/api/issues/${encodeURIComponent(issue)}`);
  }
  save("api-after", after);
  evidence.beforeStatus = before.status;
  evidence.afterStatus = after.status;
  assert.equal(after.status, values.status, "nativeドロップ後の保存状態が移動先と一致しません");
  await visible("moved");
  observe("reload", ["hotkey", "--key", "CmdOrCtrl+R"]);
  await visible("reloaded");
  const reloaded = await api<SavedIssue>(`/api/issues/${encodeURIComponent(issue)}`);
  save("api-reloaded", reloaded);
  assert.equal(reloaded.status, values.status, "再読み込み後の保存状態が移動先と一致しません");
  evidence.passed = true;
  console.log(`${issue}: ${before.status} → ${values.status}、native表示とAPI保存、再読み込みが一致`);
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  save("result", evidence);
}
