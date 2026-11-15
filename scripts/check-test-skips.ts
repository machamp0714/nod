// bun test の JUnit の結果（--reporter=junit）と、許可する skip の一覧（test/allowed-skips.json）を照合する。
// 使い方: bun scripts/check-test-skips.ts <JUnit の結果ファイル> <許可する skip の一覧>
// 実際に skip されたテスト（test.todo を含む）の集合と一覧が完全に一致するときだけ、件数と一致した項目を標準出力に出して 0 で終わる。
// 一致しないとき・入力を読めないときは、原因の項目を標準エラーに全部出して 1 で終わる。引数の誤りは 2。
//
// 一覧は { file, name, reason } の配列。file は bun test を実行したディレクトリ（リポジトリのルート）からのパス、
// name は入れ子の describe の名前を外側から順に並べ、最後にテストの名前を置いた配列、reason は skip を許す理由。
import { readFileSync } from "node:fs";

interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  children: XmlElement[];
}

interface TestCase {
  file: string;
  name: string[];
  status: "ran" | "skip" | "todo";
}

interface AllowedSkip {
  file: string;
  name: string[];
  reason: string;
}

// describe.skip の中のフックを、bun は名前の無い testcase "(unnamed)" の skip として報告する
const UNNAMED = "(unnamed)";

const NAME = "[A-Za-z_:][\\w.:-]*";
const OPEN_TAG = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, "y");
const CLOSE_TAG = new RegExp(`</(${NAME})\\s*>`, "y");
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, "g");
const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

class XmlError extends Error {}

// 文字参照・実体参照を戻す。知らない参照や ; の無い & は解析の失敗にする
function decode(raw: string): string {
  return raw.replace(/&([^&;]*)(;?)/g, (_, ref: string, semi: string) => {
    if (semi && ref in ENTITIES) return ENTITIES[ref]!;
    const code = !semi ? NaN : /^#x[0-9a-fA-F]+$/.test(ref) ? parseInt(ref.slice(2), 16) : /^#[0-9]+$/.test(ref) ? Number(ref.slice(1)) : NaN;
    if (Number.isNaN(code) || code > 0x10ffff) throw new XmlError(`解釈できない参照 &${ref}${semi}`);
    return String.fromCodePoint(code);
  });
}

// JUnit の結果に必要な範囲（要素・属性・文字・コメント・CDATA・XML 宣言）の、外部依存の無い XML の解析
function parseXml(xml: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let i = 0;
  const fail = (message: string, at: number) => new XmlError(`${xml.slice(0, at).split("\n").length} 行目: ${message}`);
  const skipPast = (end: string, at: number) => {
    const found = xml.indexOf(end, at);
    if (found === -1) throw fail(`${end} で閉じられていません`, at);
    return found + end.length;
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    if (text.trim() !== "") {
      if (stack.length === 0) throw fail("要素の外に文字があります", i);
      try {
        decode(text);
      } catch (e) {
        throw fail((e as Error).message, i);
      }
    }
    if (lt === -1) break;
    i = lt;
    if (xml.startsWith("<?", i)) {
      i = skipPast("?>", i);
    } else if (xml.startsWith("<!--", i)) {
      i = skipPast("-->", i);
    } else if (xml.startsWith("<![CDATA[", i)) {
      if (stack.length === 0) throw fail("要素の外に CDATA があります", i);
      i = skipPast("]]>", i);
    } else if (xml.startsWith("<!", i)) {
      throw fail("DOCTYPE などの宣言は扱いません", i);
    } else if (xml.startsWith("</", i)) {
      CLOSE_TAG.lastIndex = i;
      const m = CLOSE_TAG.exec(xml);
      if (!m) throw fail("閉じタグの形が不正です", i);
      const open = stack.pop();
      if (!open || open.name !== m[1]) throw fail(`</${m[1]}> に対応する開始タグがありません`, i);
      i = CLOSE_TAG.lastIndex;
    } else {
      OPEN_TAG.lastIndex = i;
      const m = OPEN_TAG.exec(xml);
      if (!m) throw fail("タグの形が不正です", i);
      const element: XmlElement = { name: m[1]!, attrs: new Map(), children: [] };
      for (const a of m[2]!.matchAll(ATTRIBUTE)) {
        if (element.attrs.has(a[1]!)) throw fail(`属性 ${a[1]} が重複しています`, i);
        try {
          element.attrs.set(a[1]!, decode(a[2] ?? a[3]!));
        } catch (e) {
          throw fail((e as Error).message, i);
        }
      }
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root) throw fail("ルートの要素が複数あります", i);
      else root = element;
      if (m[3] !== "/") stack.push(element);
      i = OPEN_TAG.lastIndex;
    }
  }
  if (stack.length > 0) throw fail(`<${stack.at(-1)!.name}> が閉じられていません`, xml.length);
  if (!root) throw fail("要素がありません", xml.length);
  return root;
}

function attr(element: XmlElement, name: string): string {
  const value = element.attrs.get(name);
  if (value === undefined) throw new XmlError(`<${element.name}> に ${name} 属性がありません`);
  return value;
}

// ファイルごとの testsuite の下で、入れ子の testsuite（describe）の名前を積んでテストの完全な名前にする
function collectCases(root: XmlElement): TestCase[] {
  if (root.name !== "testsuites") throw new XmlError(`ルートの要素が <testsuites> ではなく <${root.name}> です`);
  const cases: TestCase[] = [];
  const walk = (suite: XmlElement, file: string, path: string[]) => {
    for (const child of suite.children) {
      if (child.name === "testsuite") {
        walk(child, file, [...path, attr(child, "name")]);
      } else if (child.name === "testcase") {
        const skipped = child.children.find((c) => c.name === "skipped");
        // bun は test.todo を <skipped message="TODO" />、test.skip・skipIf を <skipped /> で報告する
        const status = !skipped ? "ran" : skipped.attrs.get("message") === "TODO" ? "todo" : "skip";
        cases.push({ file, name: [...path, attr(child, "name")], status });
      }
    }
  };
  for (const suite of root.children) {
    if (suite.name !== "testsuite") throw new XmlError(`<testsuites> の下に <${suite.name}> があります`);
    walk(suite, attr(suite, "file"), []);
  }
  return cases;
}

function readCases(path: string, errors: string[]): TestCase[] | undefined {
  let xml: string;
  try {
    xml = readFileSync(path, "utf8");
  } catch (e) {
    errors.push(`JUnit の結果ファイルを読めません: ${path}: ${(e as Error).message}`);
    return undefined;
  }
  try {
    return collectCases(parseXml(xml));
  } catch (e) {
    if (!(e instanceof XmlError)) throw e;
    errors.push(`JUnit の結果ファイルを解析できません: ${path}: ${e.message}`);
    return undefined;
  }
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function readAllowed(path: string, errors: string[]): AllowedSkip[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`許可する skip の一覧を読めません: ${path}: ${(e as Error).message}`);
    return undefined;
  }
  if (!Array.isArray(data)) {
    errors.push(`許可する skip の一覧の形が不正です: ${path}: { file, name, reason } の配列にしてください`);
    return undefined;
  }
  const before = errors.length;
  const seen = new Set<string>();
  data.forEach((entry: Partial<Record<keyof AllowedSkip, unknown>> | null, index) => {
    const at = `${path} の ${index} 番目`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`許可する skip の一覧の形が不正です: ${at}: { file, name, reason } にしてください`);
      return;
    }
    const { file, name, reason } = entry;
    if (!isText(file)) errors.push(`許可する skip の一覧の形が不正です: ${at}: file が空か文字列ではありません`);
    if (!Array.isArray(name) || name.length === 0 || !name.every(isText)) {
      errors.push(`許可する skip の一覧の形が不正です: ${at}: name は describe とテストの名前を並べた空でない文字列の配列にしてください`);
    } else if (name.at(-1) === UNNAMED) {
      errors.push(`許可する skip の一覧の形が不正です: ${at}: 名前の無い skip（${UNNAMED}）は許可できません`);
    }
    if (!isText(reason)) errors.push(`許可する skip の一覧の形が不正です: ${at}: reason（skip を許す理由）が空か文字列ではありません`);
    if (isText(file) && Array.isArray(name)) {
      const key = JSON.stringify([file, ...name]);
      if (seen.has(key)) errors.push(`許可する skip の一覧の形が不正です: ${at}: ${item(file, name)} が重複しています`);
      seen.add(key);
    }
  });
  return errors.length === before ? (data as AllowedSkip[]) : undefined;
}

// 項目の書き方: ファイルと、完全な名前の JSON の配列（一覧の name にそのまま写せる形）
function item(file: string, name: unknown[]): string {
  return `${file} ${JSON.stringify(name)}`;
}

// 一覧と一致した skip は、ログで確かめられるよう種類（skip・todo）と項目の書き方で matched に返す
function check(cases: TestCase[], allowed: AllowedSkip[]): { matched: string[]; errors: string[] } {
  const errors: string[] = [];
  const groups = new Map<string, TestCase[]>();
  for (const c of cases) {
    const key = JSON.stringify([c.file, ...c.name]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const allowedKeys = new Set(allowed.map((a) => JSON.stringify([a.file, ...a.name])));
  const matched: string[] = [];
  for (const [key, group] of groups) {
    const skips = group.filter((c) => c.status !== "ran");
    const first = skips[0];
    if (!first) continue;
    const kind = first.status === "todo" ? "todo" : "skip";
    if (first.name.some((n) => n === "" || n === UNNAMED)) {
      errors.push(`名前で特定できない ${kind}: ${item(first.file, first.name)}（describe.skip のフックなど。一覧では許可できないため、test ごとに skip する形に直してください）`);
    } else if (group.length > 1) {
      errors.push(`名前で特定できない ${kind}: ${item(first.file, first.name)}（同じ完全な名前のテストが ${group.length} 件あります）`);
    } else if (!allowedKeys.has(key)) {
      errors.push(`一覧に無い ${kind}: ${item(first.file, first.name)}`);
    } else {
      matched.push(`${kind}: ${item(first.file, first.name)}`);
    }
  }
  for (const a of allowed) {
    const group = groups.get(JSON.stringify([a.file, ...a.name]));
    if (!group) errors.push(`一覧にあるのに結果に無い: ${item(a.file, a.name)}`);
    else if (group.every((c) => c.status === "ran")) errors.push(`一覧にあるのに実行された: ${item(a.file, a.name)}`);
  }
  return { matched, errors };
}

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("使い方: bun scripts/check-test-skips.ts <JUnit の結果ファイル> <許可する skip の一覧>");
  process.exit(2);
}
const [resultsPath, allowedPath] = args as [string, string];
const errors: string[] = [];
const cases = readCases(resultsPath, errors);
const allowed = readAllowed(allowedPath, errors);
if (cases && allowed) {
  const result = check(cases, allowed);
  errors.push(...result.errors);
  if (errors.length === 0) {
    console.log(`skip の照合: 実際の skip（todo を含む）と一覧が一致しました（${result.matched.length} 件）`);
    for (const m of result.matched) console.log(`  ${m}`);
    process.exit(0);
  }
}
for (const e of errors) console.error(e);
console.error(`skip の照合に失敗しました（原因 ${errors.length} 件）。skip の原因を直すか、許可する skip の一覧を実際の skip に合わせてください`);
process.exit(1);
