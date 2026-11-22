// 禁止操作を止める規則（同じディレクトリの rules.json）の形と検証。制御の拡張（index.ts）と、適用（scripts/pstack-omp/harness.ts）が使う。
// OMP のモジュールには依存しない（適用は OMP の外で動くため）。
//
// rules.json の形（未知のキー・型違い・空の一覧は不正）:
//   version         1
//   toolApproval    ツールの名前 → "deny"。OMP の tools.approval の同じキーを実行時の層で上書きする（eval の deny を必ず含む）
//   bashDeny        OMP の bash.patterns に deny で先頭に入れるパターン（* だけのワイルドカード。OMP が照合する）。
//                   設定は子と孫と共有なので、役割では分けず全員に効く
//   github          denyOps: github ツールで拒否する op
//   task            denyIsolated: task の isolated: true を拒否するか。subAgents: 子と孫（ctx.agent.kind が sub）が起動できるエージェント
//   protectedPaths  パスを引数に持つ書き込みのツールで書けない置き場（そのパス自身と、その下）
// bashDeny と protectedPaths には、制御の拡張が解決するプレースホルダを書ける:
//   {agentDir}  適用した OMP の設定の置き場（PI_CODING_AGENT_DIR。既定は ~/.omp/agent）
//   {workDir}   nod のデータ置き場の下の pstack-omp（写し・生成物・上流の clone）
// 資格情報は書かない。

export interface Rules {
  version: 1;
  toolApproval: Record<string, "deny">;
  bashDeny: string[];
  github: { denyOps: string[] };
  task: { denyIsolated: boolean; subAgents: string[] };
  protectedPaths: string[];
}

export interface Places {
  agentDir: string;
  workDir: string;
}

const KEYS = ["version", "toolApproval", "bashDeny", "github", "task", "protectedPaths"];
const PLACEHOLDERS = ["{agentDir}", "{workDir}"];

// 形が正しければ規則を、正しくなければ理由を返す
export function parseRules(record: unknown): Rules | string {
  if (!isRecord(record)) return "オブジェクトではありません";
  const keys = exactKeys(record, KEYS);
  if (keys !== undefined) return keys;
  if (record.version !== 1) return `version が 1 ではありません: ${String(record.version)}`;

  const approval = record.toolApproval;
  if (!isRecord(approval) || Object.keys(approval).length === 0) return "toolApproval がツールの名前から deny への対応ではありません";
  for (const [tool, value] of Object.entries(approval)) {
    if (tool.trim() === "" || value !== "deny") return `toolApproval.${tool} が deny ではありません`;
  }
  if (approval.eval !== "deny") return "toolApproval に eval の deny がありません";

  const bashDeny = names(record.bashDeny, "bashDeny");
  if (typeof bashDeny === "string") return bashDeny;
  const placeholder = bashDeny.find(unknownPlaceholder);
  if (placeholder !== undefined) return `bashDeny の ${placeholder} に知らないプレースホルダがあります`;

  const github = record.github;
  if (!isRecord(github)) return "github がオブジェクトではありません";
  const githubKeys = exactKeys(github, ["denyOps"], "github.");
  if (githubKeys !== undefined) return githubKeys;
  const denyOps = names(github.denyOps, "github.denyOps");
  if (typeof denyOps === "string") return denyOps;

  const task = record.task;
  if (!isRecord(task)) return "task がオブジェクトではありません";
  const taskKeys = exactKeys(task, ["denyIsolated", "subAgents"], "task.");
  if (taskKeys !== undefined) return taskKeys;
  if (typeof task.denyIsolated !== "boolean") return "task.denyIsolated が真偽値ではありません";
  const subAgents = names(task.subAgents, "task.subAgents");
  if (typeof subAgents === "string") return subAgents;

  const protectedPaths = names(record.protectedPaths, "protectedPaths");
  if (typeof protectedPaths === "string") return protectedPaths;
  for (const path of protectedPaths) {
    if (unknownPlaceholder(path)) return `protectedPaths の ${path} に知らないプレースホルダがあります`;
    if (!PLACEHOLDERS.some((p) => path.startsWith(p)) && !path.startsWith("/")) return `protectedPaths の ${path} が絶対パスかプレースホルダで始まっていません`;
  }
  return { version: 1, toolApproval: approval as Record<string, "deny">, bashDeny, github: { denyOps }, task: { denyIsolated: task.denyIsolated, subAgents }, protectedPaths };
}

// プレースホルダを置き場に置き換える
export function resolvePlaces(text: string, places: Places): string {
  return text.replaceAll("{agentDir}", places.agentDir).replaceAll("{workDir}", places.workDir);
}

// 配列でないオブジェクトか（制御の拡張の中で共有する唯一の型の判定。写しは nod のリポジトリのモジュールを読めないため、ここに置く）
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// キーがちょうど keys であれば undefined、そうでなければ理由
function exactKeys(record: Record<string, unknown>, keys: string[], prefix = ""): string | undefined {
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) return `知らないキーがあります: ${unknown.map((key) => prefix + key).join(", ")}`;
  const missing = keys.filter((key) => record[key] === undefined);
  if (missing.length > 0) return `キーがありません: ${missing.map((key) => prefix + key).join(", ")}`;
  return undefined;
}

// 空でない文字列の、重複の無い空でない配列
function names(value: unknown, name: string): string[] | string {
  if (!Array.isArray(value) || value.length === 0 || !value.every((x) => typeof x === "string" && x.trim() !== "")) return `${name} が空でない文字列の配列ではありません`;
  const duplicated = value.find((x, i) => value.indexOf(x) !== i);
  if (duplicated !== undefined) return `${name} に ${String(duplicated)} が重複しています`;
  return value as string[];
}

function unknownPlaceholder(text: string): boolean {
  return (text.match(/\{[^}]*\}/g) ?? []).some((p) => !PLACEHOLDERS.includes(p));
}
