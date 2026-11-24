// 変換の入力（既定は scripts/pstack-omp/transform/。context.ts の NOD_PSTACK_OMP_TRANSFORM で差し替えられる）を読む。
// - rules.yml: 順序付きの置換規則（rules）と、スキルのディレクトリの外から生成物に入れる文書（include）
// - denylist.yml: 変換の後に残ってはならない語（terms）
// - forks.yml: 全文差し替えの宣言（forks）と、このディレクトリに置いた本文
// 各ファイルの項目の意味は、それぞれのファイルの先頭の注記を参照。YAML は Bun の YAML で読む（config.ts と同じ）。
// 読めない・形が正しくない入力では止めず、理由を problems に、そのために後の検査ができない範囲を limits に集める（generate.ts がまとめて報告する）。
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { isMapping } from "./config";

export const INPUT_FILES = ["rules.yml", "denylist.yml", "forks.yml"] as const;

export interface Rule {
  id: string;
  reason: string;
  // 当てる生成物の相対パス。無ければ全部
  files: RegExp | undefined;
  // 一致させる文字列か正規表現（g つき）
  match: string | RegExp;
  replace: string;
}

export interface Include {
  from: string;
  to: string;
}

export interface Term {
  term: string;
  // g つき
  regex: RegExp;
}

export interface Fork {
  path: string;
  // 宣言の指紋。不正なら undefined（理由は problems にある）
  upstreamSha256: string | undefined;
  // 本文。読めなければ undefined（理由は problems にある）
  body: { path: string; bytes: Buffer; sha256: string } | undefined;
}

export interface Transform {
  // 規則。読めない・不正な項目があれば undefined（規則は前の規則の出力に当てるので、一部だけでは当てない）
  rules: Rule[] | undefined;
  // 読めた include（不正な項目は除く）
  include: Include[];
  // 読めた語（不正な項目は除く）。拒否リストを読めなければ undefined
  terms: Term[] | undefined;
  // 宣言した全文差し替え（path が正しいもの）。宣言を読めなければ undefined
  forks: Fork[] | undefined;
  // 入力のファイル（INPUT_FILES）の sha256
  sha256: Record<string, string>;
  problems: string[];
  limits: string[];
}

export function sha256(data: Buffer | string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

// 上流・生成物・変換の入力のディレクトリの中の相対パスとして使える形か（空でなく、絶対パスでなく、. や .. を含まない正規の形）
export function isRelativePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && posix.normalize(path) === path && path !== "." && !path.startsWith("../") && path !== "..";
}

export function readTransform(dir: string): Transform {
  const problems: string[] = [];
  const limits: string[] = [];
  const sha256s: Record<string, string> = {};
  const load = (file: string, keys: string[]): Record<string, unknown> | undefined => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, file));
    } catch (e) {
      problems.push(`${file}: 読めません: ${(e as Error).message}`);
      return undefined;
    }
    sha256s[file] = sha256(bytes);
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(bytes.toString("utf8"));
    } catch (e) {
      problems.push(`${file}: YAML として読めません: ${(e as Error).message}`);
      return undefined;
    }
    if (!isMapping(parsed)) {
      problems.push(`${file}: 全体がマッピングではありません`);
      return undefined;
    }
    for (const key of Object.keys(parsed)) if (!keys.includes(key)) problems.push(`${file}: 知らない項目 ${key} があります`);
    return parsed;
  };
  // file の key の配列。無い・配列でなければ undefined（optional で無いだけなら []）
  const list = (file: string, data: Record<string, unknown>, key: string, optional = false): unknown[] | undefined => {
    const value = data[key];
    if (value === undefined && optional) return [];
    if (Array.isArray(value)) return value;
    problems.push(`${file}: ${key} が${value === undefined ? "ありません" : "配列ではありません"}（空なら ${key}: []）`);
    return undefined;
  };

  // rules.yml
  const rulesFile = load("rules.yml", ["rules", "include"]);
  let rules: Rule[] | undefined;
  const include: Include[] = [];
  if (rulesFile === undefined) {
    limits.push("rules.yml を読めないので、規則を当てず、規則の一致の検査と、規則を当てる .md（全文差し替えを除く）の拒否リストの検査はしていません");
    limits.push("rules.yml を読めないので、include の文書を生成物に入れていません");
  } else {
    const items = list("rules.yml", rulesFile, "rules");
    const before = problems.length;
    const ids = new Set<string>();
    const parsed = (items ?? []).map((item, i) => {
      const where = `rules.yml の rules の ${i + 1} 番目${isMapping(item) && typeof item.id === "string" ? `（id: ${item.id}）` : ""}`;
      const f = fields(where, item, { required: ["id", "reason", "replace"], optional: ["files", "literal", "regex", "flags"], mayBeEmpty: ["replace"] }, problems);
      if (f === undefined) return undefined;
      if (ids.has(f.id!)) problems.push(`${where}: id ${f.id} が重複しています`);
      ids.add(f.id!);
      if ((f.literal === undefined) === (f.regex === undefined)) {
        problems.push(`${where}: literal と regex のどちらか1つだけを書いてください`);
        return undefined;
      }
      if (f.literal !== undefined && f.flags !== undefined) problems.push(`${where}: flags は regex にだけ付けられます`);
      const files = f.files === undefined ? undefined : compile(where, "files", f.files, "", problems);
      const match = f.literal ?? compile(where, "regex", f.regex!, `${(f.flags ?? "").replace("g", "")}g`, problems);
      if (match === undefined || (f.files !== undefined && files === undefined)) return undefined;
      return { id: f.id!, reason: f.reason!, files, match, replace: f.replace! };
    });
    if (items !== undefined && problems.length === before) rules = parsed as Rule[];
    else limits.push("rules.yml の規則が正しくないので、規則を当てず、規則の一致の検査と、規則を当てる .md（全文差し替えを除く）の拒否リストの検査はしていません");

    const includeItems = list("rules.yml", rulesFile, "include", true);
    let skipped = includeItems === undefined;
    includeItems?.forEach((item, i) => {
      const where = `rules.yml の include の ${i + 1} 番目`;
      const f = fields(where, item, { required: ["from", "to", "reason"], optional: [], mayBeEmpty: [] }, problems);
      const bad = f === undefined ? [] : (["from", "to"] as const).filter((key) => !isRelativePath(f[key]!));
      for (const key of bad) problems.push(`${where}: ${key} の ${f![key]} は相対パスの正規の形ではありません`);
      if (f === undefined || bad.length > 0) skipped = true;
      else include.push({ from: f.from!, to: f.to! });
    });
    if (skipped) limits.push("rules.yml の include の正しくない項目の文書は生成物に入れていないので、その文書に規則と拒否リストを当てていません");
  }

  // denylist.yml
  const denyFile = load("denylist.yml", ["terms"]);
  let terms: Term[] | undefined;
  const termItems = denyFile === undefined ? undefined : list("denylist.yml", denyFile, "terms");
  if (termItems === undefined) {
    limits.push("denylist.yml を読めないので、変換の後の拒否リストの検査はしていません");
  } else {
    const names = new Set<string>();
    const unchecked: string[] = [];
    terms = termItems.flatMap((item, i) => {
      const where = `denylist.yml の terms の ${i + 1} 番目${isMapping(item) && typeof item.term === "string" ? `（term: ${item.term}）` : ""}`;
      const f = fields(where, item, { required: ["term", "regex", "reason"], optional: ["flags"], mayBeEmpty: [] }, problems);
      if (f === undefined) {
        unchecked.push(`${i + 1} 番目`);
        return [];
      }
      if (names.has(f.term!)) problems.push(`${where}: term ${f.term} が重複しています`);
      names.add(f.term!);
      const regex = compile(where, "regex", f.regex!, `${(f.flags ?? "").replace("g", "")}g`, problems);
      if (regex === undefined || new RegExp(regex.source, regex.flags.replace("g", "")).test("")) {
        if (regex !== undefined) problems.push(`${where}: regex が空の文字列に一致します`);
        unchecked.push(f.term!);
        return [];
      }
      return [{ term: f.term!, regex }];
    });
    if (unchecked.length > 0) limits.push(`denylist.yml の正しくない項目（${unchecked.join(", ")}）の語は検査していません`);
  }

  // forks.yml
  const forksFile = load("forks.yml", ["forks"]);
  let forks: Fork[] | undefined;
  const forkItems = forksFile === undefined ? undefined : list("forks.yml", forksFile, "forks");
  const unknownForks =
    "全文差し替えの宣言を読めないので、差し替えるはずのファイルを差し替えず、指紋の検査もしていません。そのファイルにも上流の本文のまま規則と拒否リストを当てたので、その報告には差し替えの後には無くなるものが含まれることがあります";
  if (forkItems === undefined) {
    limits.push(`forks.yml: ${unknownForks}`);
  } else {
    const paths = new Set<string>();
    let unknown = false;
    forks = forkItems.flatMap((item, i) => {
      const entry = isMapping(item) ? item : {};
      const path = entry.path;
      const where = `forks.yml の forks の ${i + 1} 番目${typeof path === "string" ? `（path: ${path}）` : ""}`;
      // 項目の誤りを報告する。誤りがあっても、path・指紋・本文はそれぞれ確かめる
      fields(where, item, { required: ["path", "upstreamSha256", "body", "reason"], optional: [], mayBeEmpty: [] }, problems);
      if (typeof path !== "string" || !isRelativePath(path)) {
        if (typeof path === "string") problems.push(`${where}: path の ${path} は相対パスの正規の形ではありません`);
        unknown = true;
        return [];
      }
      if (paths.has(path)) problems.push(`${where}: path ${path} が重複しています`);
      paths.add(path);
      const declared = typeof entry.upstreamSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.upstreamSha256) ? entry.upstreamSha256 : undefined;
      if (typeof entry.upstreamSha256 === "string" && declared === undefined) problems.push(`${where}: upstreamSha256 が小文字の16進64桁ではありません`);
      let body: Fork["body"];
      if (typeof entry.body === "string" && !isRelativePath(entry.body)) {
        problems.push(`${where}: body の ${entry.body} は相対パスの正規の形ではありません`);
      } else if (typeof entry.body === "string") {
        try {
          const bytes = readFileSync(join(dir, entry.body));
          body = { path: entry.body, bytes, sha256: sha256(bytes) };
        } catch (e) {
          problems.push(`${where}: 本文 ${entry.body} を読めません: ${(e as Error).message}`);
        }
      }
      if (body === undefined) limits.push(`${path}: 全文差し替えの本文を使えないので、このファイルの拒否リストの検査はしていません`);
      return [{ path, upstreamSha256: declared, body }];
    });
    if (unknown) limits.push(`forks.yml の path が正しくない項目: ${unknownForks}`);
  }

  return { rules, include, terms, forks, sha256: sha256s, problems, limits };
}

function compile(where: string, key: string, source: string, flags: string, problems: string[]): RegExp | undefined {
  try {
    return new RegExp(source, flags);
  } catch (e) {
    problems.push(`${where}: ${key} が正規表現として正しくありません: ${(e as Error).message}`);
    return undefined;
  }
}

// 項目 item が、spec の項目だけを文字列で持つマッピングなら、その値。違えば理由を problems に足して undefined
function fields(
  where: string,
  item: unknown,
  spec: { required: string[]; optional: string[]; mayBeEmpty: string[] },
  problems: string[],
): Record<string, string> | undefined {
  if (!isMapping(item)) {
    problems.push(`${where}: マッピングではありません`);
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(item)) if (![...spec.required, ...spec.optional].includes(key)) problems.push(`${where}: 知らない項目 ${key} があります`);
  for (const key of spec.required) if (item[key] === undefined) problems.push(`${where}: ${key} がありません`);
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || ![...spec.required, ...spec.optional].includes(key)) continue;
    if (typeof value !== "string") problems.push(`${where}: ${key} が文字列ではありません`);
    else if (value === "" && !spec.mayBeEmpty.includes(key)) problems.push(`${where}: ${key} が空です`);
  }
  return problems.length === before ? (item as Record<string, string>) : undefined;
}
