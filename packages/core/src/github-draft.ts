import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { type LeakConfig, type LeakField, type LeakHit, type LeakRule, leakHitsOf, leakPathEnd, leakPositionsIn, leakUrlsOf } from "./github-leak";
import { findIssueRow, type IssueRow } from "./issue-query";
import { githubIssueUrl, githubLinkOf } from "./ops/github-links";

// GitHub に出すタイトル・本文の案を、nod の文面から決まった規則だけで作る（LLM・外部の API は使わない）。
// 案は保存せず、nod の本文も変えない。書き換えは元の文面の上の重ならない範囲ごとに1回だけ行い、書き換えた結果は調べ直さない（連鎖しない）
export interface GithubDraftChange {
  field: LeakField;
  line: number; // 元の文面の行。1始まり
  column: number; // 元の文面の桁。1始まり。コードポイント数
  before: string;
  after: string;
  rule: LeakRule;
  reason: string;
}

export interface GithubDraft {
  title: string;
  body: string;
  changes: GithubDraftChange[];
  unparsed: LeakField[]; // Markdown として解析できず、自動では整えなかった項目
}

// 解析できなかった項目に残った箇所の理由に足す説明
export const GITHUB_DRAFT_UNPARSED_REASON = "（Markdown として解析できなかったため、この項目は自動では整えていません）";

// 元の文面の [start, end) を after に置き換える
interface Edit {
  start: number;
  end: number;
  after: string;
  rule: LeakRule;
  reason: string;
}

interface DraftEnv {
  db: Database;
  issue: IssueRow;
  config: LeakConfig;
  roots: string[]; // 公開する Issue の Workspace のパス（DB の表記と realpath）
  issues: Map<string, IssueRow | null>; // 本文に何度も出る ID を1回だけ引く
}

const trimSlash = (p: string) => p.replace(/\/+$/, "");

function workspaceRootsOf(db: Database, workspaceId: number): string[] {
  const { path } = db.query("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as { path: string };
  const roots = new Set([trimSlash(path)]);
  try {
    roots.add(trimSlash(realpathSync(path)));
  } catch {
    // 実在しない Workspace は DB の表記だけで照合する
  }
  return [...roots].filter((r) => r.length > 1);
}

// Workspace の下を指すパスなら、Workspace のパスを外した相対パス。. と .. を解決してから判定し、
// ルートそのもの・Workspace の外に出るもの・より長い別の既知パス（ほかの Workspace など）の下は null
function relativePathOf(env: DraftEnv, raw: string): string | null {
  const path = posix.normalize(raw);
  for (const root of env.roots) {
    if (!path.startsWith(`${root}/`)) continue;
    const rel = path.slice(root.length + 1);
    if (!rel) return null;
    const deeper = env.config.knownPaths.map(trimSlash).some((k) => k.length > root.length && (path === k || path.startsWith(`${k}/`)));
    return deeper ? null : rel;
  }
  return null;
}

// 書き換えの範囲を外側の構造から順に決める。先に決めた範囲（書き換える範囲・そのまま残す範囲）の中は、あとの規則で書き換えない
interface Plan {
  edits: Edit[];
  claimed: [number, number][];
  code: [number, number][]; // コードブロック・インラインコードの範囲。中はパスの相対パス化だけを行う
}

// 範囲は重ならず start の順に並べて持つ。end より前に始まる最後の範囲の位置
function lastBefore(ranges: [number, number][], end: number): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid]?.[0] ?? 0) < end) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const overlaps = (ranges: [number, number][], start: number, end: number) => (ranges[lastBefore(ranges, end) - 1]?.[1] ?? 0) > start;
const isFree = (plan: Plan, start: number, end: number) => !overlaps(plan.claimed, start, end);
const inCode = (plan: Plan, start: number, end: number) => overlaps(plan.code, start, Math.max(end, start + 1));

function claim(plan: Plan, start: number, end: number, edit?: Omit<Edit, "start" | "end">): void {
  plan.claimed.splice(lastBefore(plan.claimed, end), 0, [start, end]);
  if (edit) plan.edits.push({ start, end, ...edit });
}

// Markdown の構造は GFM のパーサー（mdast-util-from-markdown）で見分け、各ノードの位置（offset）を使う。
// 正規表現や括弧の走査で CommonMark の形（引用・リスト・段落・エスケープ・CRLF など）を真似ない
interface MdNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
  referenceType?: string; // linkReference の full・collapsed・shortcut
}

// インラインリンク [文字](リンク先)。label は [] の中、target はリンク先（<> を除く）の範囲
interface InlineLink {
  start: number;
  end: number;
  labelEnd: number;
  targetStart: number;
  targetEnd: number;
}

interface MdStructure {
  code: [number, number][]; // コードブロック・インラインコード。中はパスの相対パス化だけを行う
  kept: [number, number][]; // 残す構造（画像・画像の参照・参照定義・HTML のタグ・参照キー・脚注の識別子）
  links: InlineLink[];
}

// ノードの範囲。位置のないノードは扱わない
function rangeOf(node: MdNode): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : [start, end];
}

// ]( のあとの空白・リンク先（<...> か空白を含まない並び）・任意のタイトル・) までの形。リンク先の位置をここから求める
const LINK_TAIL_RE = /^\]\((\s*)(<[^>\n]*>|\S*?)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\)))?\s*\)$/;

function inlineLinkOf(text: string, node: MdNode, start: number, end: number): InlineLink | null {
  // [ で始まるものだけがインラインリンク。<URL> や文中の URL（GFM の autolink）は URL の規則で扱う
  if (text[start] !== "[") return null;
  const last = node.children?.at(-1);
  const labelEnd = (last && rangeOf(last)?.[1]) ?? start + 1;
  const m = LINK_TAIL_RE.exec(text.slice(labelEnd, end));
  if (!m) return null; // [文字][参照] などリンク先を本文に持たない形
  const raw = m[2] ?? "";
  const bracketed = raw.startsWith("<");
  const targetStart = labelEnd + 2 + (m[1] ?? "").length + (bracketed ? 1 : 0);
  return { start, end, labelEnd, targetStart, targetEnd: targetStart + raw.length - (bracketed ? 2 : 0) };
}

const CODE_TYPES = new Set(["code", "inlineCode"]);
// 形ごと残す構造。脚注の参照 [^ID] は識別子だけからなる
const KEPT_TYPES = new Set(["image", "imageReference", "definition", "footnoteReference"]);
// HTML はタグ（「<」から「>」まで。属性名・引用符で囲んだ値を含む）とコメントを形ごと残し、タグの間の文は通常の規則で扱う。
// タグとみなすのは CommonMark・HTML の構文どおり「<」の直後がタグ名（英字）・「</」＋タグ名・「<!--」・「<!」＋英字（宣言）・「<?」のときだけ。
// 引用符の中の「>」でタグを終わらせないよう、値は引用符ごとに読む
const HTML_TAG_RE = /<!--[\s\S]*?-->|<(?:\/?[A-Za-z]|![A-Za-z]|\?)(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
const FOOTNOTE_LABEL_RE = /^\[\^[^\]\n]*\]:/;

// 参照リンクの参照キー。full（[文字][キー]）は ][キー] の部分、collapsed（[キー][]）・shortcut（[キー]）は文字がキーを兼ねるので全体
function referenceKeyOf(node: MdNode, start: number, end: number): [number, number] {
  if (node.referenceType !== "full") return [start, end];
  const last = node.children?.at(-1);
  return [(last && rangeOf(last)?.[1]) ?? start + 1, end];
}

// 深い入れ子でも自分の走査でスタックを使い切らないよう、積み上げで辿る。パーサー自体が失敗したときは例外をそのまま投げる
function structureOf(text: string): MdStructure {
  const out: MdStructure = { code: [], kept: [], links: [] };
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdNode;
  const stack: MdNode[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const range = rangeOf(node);
    const children = node.children ?? [];
    if (range && CODE_TYPES.has(node.type)) out.code.push(range);
    else if (range && KEPT_TYPES.has(node.type)) out.kept.push(range);
    else if (range && node.type === "html") {
      for (const m of text.slice(range[0], range[1]).matchAll(HTML_TAG_RE)) out.kept.push([range[0] + (m.index ?? 0), range[0] + (m.index ?? 0) + m[0].length]);
    } else if (range && node.type === "linkReference") {
      out.kept.push(referenceKeyOf(node, range[0], range[1]));
      if (node.referenceType === "full") stack.push(...children);
    } else {
      if (range && node.type === "footnoteDefinition") {
        const label = FOOTNOTE_LABEL_RE.exec(text.slice(range[0], range[1]));
        if (label) out.kept.push([range[0], range[0] + label[0].length]);
      }
      if (range && node.type === "link") {
        const link = inlineLinkOf(text, node, range[0], range[1]);
        if (link) out.links.push(link);
      }
      stack.push(...children);
    }
  }
  out.code.sort((x, y) => x[0] - y[0]);
  out.kept.sort((x, y) => x[0] - y[0]);
  out.links.sort((x, y) => x.start - y.start);
  return out;
}

// ID の規則の結果（as は何に書き換えたかの説明）。null なら残す
function issueRowOf(env: DraftEnv, ref: string): IssueRow | null {
  const key = ref.toUpperCase();
  if (!env.issues.has(key)) {
    try {
      env.issues.set(key, findIssueRow(env.db, ref));
    } catch {
      env.issues.set(key, null); // 存在しない ID（削除済みを含む）
    }
  }
  return env.issues.get(key) ?? null;
}

function issueTargetOf(env: DraftEnv, ref: string): { after: string; as: string } | null {
  const row = issueRowOf(env, ref);
  if (!row) return null;
  if (row.id === env.issue.id) return { after: "この Issue", as: "「この Issue」" };
  const link = githubLinkOf(env.db, row.id);
  if (link) return { after: link.url, as: "対応する GitHub Issue の URL" };
  if (row.workspace_id === env.issue.workspace_id) return { after: `「${row.title}」の Issue`, as: "タイトルでの言い換え" };
  return null;
}

// owner/repo#N は GitHub の URL に。番号だけの #N は nod の番号と区別できないので残す
function issueRefReplacement(text: string): { after: string; reason: string } | null {
  const i = text.lastIndexOf("#");
  if (!text.slice(0, i).includes("/")) return null;
  return { after: githubIssueUrl(text.slice(0, i), Number(text.slice(i + 1))), reason: "owner/repo#N を GitHub Issue の URL にしました" };
}

// nod の Web の /issues/<ID> の URL なら、その終わりと ID。ID のあとの / と ?・# から先は含め、末尾の句読点は含めない
function nodIssueUrlOf(text: string, url: { index: number; text: string }, hits: LeakHit[]): { end: number; id: string } | null {
  const scheme = /^https?:\/\//i.exec(url.text);
  if (!scheme) return null;
  const host = hits.find((h) => h.rule === "nod_web" && h.index === url.index + scheme[0].length);
  if (!host) return null;
  const path = host.index + host.text.length;
  if (!text.startsWith("/issues/", path)) return null;
  const id = hits.find((h) => h.rule === "issue_id" && h.index === path + "/issues/".length);
  if (!id) return null;
  const urlEnd = url.index + url.text.length;
  const idEnd = id.index + id.text.length;
  const rest = (/^\/?(?:[?#][!-~]*)?/.exec(text.slice(idEnd, urlEnd))?.[0] ?? "").replace(/[.,;:!?]+$/, "");
  const end = idEnd + rest.length;
  // URL がまだ続く（/issues/<ID>/edit など）ものは Issue の URL とみなさない。続きが日本語なら URL はそこで終わる
  if (!/^(?:[.,;:!?]*$|[^\x00-\x7f])/.test(text.slice(end, urlEnd))) return null;
  return { end, id: id.text };
}

// 取り込みで本文の末尾に付けた footer（github-import の形のまま）。--- の行は残し、そのあとを出所の URL の1行にする。
// 形が崩れたもの・末尾にないものは手で直したものとみなして残す
const IMPORT_FOOTER_RE =
  /(?:^|\n)---\n(取り込み元: (https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/\d+)（GitHub #\d+、@\S+ が \S+ に作成(?:、\S+ に close)?）(?:\n担当（GitHub）: @[^\s,]+(?:, @[^\s,]+)*)?)\s*$/;

function planImportFooter(text: string, hits: LeakHit[], plan: Plan): void {
  if (!hits.some((h) => h.rule === "import_footer")) return;
  const m = IMPORT_FOOTER_RE.exec(text);
  if (!m?.[1]) return;
  const start = m.index + m[0].indexOf(m[1]);
  if (inCode(plan, start, start + m[1].length)) return;
  claim(plan, start, start + m[1].length, { after: `参考: ${m[2]}`, rule: "import_footer", reason: "取り込みの footer を、出所の URL だけの1行にしました" });
}

// GitHub に対応がある nod の Issue（/issues/<ID> か nod の Web の Issue の URL）を指すリンク先なら、その GitHub の URL
function linkedIssueUrlOf(env: DraftEnv, text: string, start: number, end: number, hits: LeakHit[]): { url: string; rule: LeakRule } | null {
  const target = text.slice(start, end);
  let ref: string | undefined;
  let rule: LeakRule = "link_target";
  const path = /^\/issues\/([^/?#]+)\/?(?:[?#].*)?$/.exec(target);
  if (path && hits.some((h) => h.rule === "issue_id" && h.index === start + "/issues/".length && h.text === path[1])) ref = path[1];
  else {
    const nod = nodIssueUrlOf(text, { index: start, text: target }, hits);
    if (nod?.end === end) [ref, rule] = [nod.id, "nod_web"];
  }
  const row = ref ? issueRowOf(env, ref) : null;
  const link = row && githubLinkOf(env.db, row.id);
  return link ? { url: link.url, rule } : null;
}

// リンク先が相対パスか Workspace の中の絶対パスなら、表に出す相対パス
function linkPathOf(env: DraftEnv, target: string): string | null {
  if (target.startsWith("/")) return relativePathOf(env, target);
  if (!target || /^(?:~|\.\.|#)/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  return target;
}

// 残す構造（画像・画像の参照・参照定義・HTML）は、ラベルの中のリンクなどより先に確定する。中に検出があれば形ごと残し、中をあとの規則で書き換えない
function planKept(md: MdStructure, hits: LeakHit[], plan: Plan): void {
  for (const [start, end] of md.kept) {
    if (isFree(plan, start, end) && !inCode(plan, start, end) && hits.some((h) => h.index >= start && h.index < end)) claim(plan, start, end);
  }
}

// リンク先に検出があったインラインリンクは、ここで決めた書き換え（またはそのまま）だけにし、中の ID・パスはあとの規則で書き換えない。
// 文字が空のリンクは残す
function planLinks(env: DraftEnv, text: string, md: MdStructure, hits: LeakHit[], plan: Plan): void {
  for (const l of md.links) {
    if (!isFree(plan, l.start, l.end) || inCode(plan, l.start, l.end) || !hits.some((h) => h.index >= l.targetStart && h.index < Math.max(l.targetEnd, l.targetStart + 1))) continue;
    claim(plan, l.start, l.end);
    const label = text.slice(l.start + 1, l.labelEnd);
    if (!label) continue;
    const linked = linkedIssueUrlOf(env, text, l.targetStart, l.targetEnd, hits);
    if (linked) {
      plan.edits.push({ start: l.targetStart, end: l.targetEnd, after: linked.url, rule: linked.rule, reason: "nod の Issue へのリンク先を、対応する GitHub Issue の URL にしました" });
      continue;
    }
    const path = linkPathOf(env, text.slice(l.targetStart, l.targetEnd));
    if (path) plan.edits.push({ start: l.start, end: l.end, after: `${label}（${path}）`, rule: "link_target", reason: "GitHub で開けないリンクを、リンクの文字とパスの表記にしました" });
  }
}

// パス・ファイル名・ブランチ名の一部になっている ID（docs/API-1.md、feature/API-1、API-1/memo、API-1.設計.md）。言い換えるとパスが壊れるので残す。
// 「.」のあとが空白・句読点・括弧・行末なら文の区切りとして言い換える
const partOfPath = (text: string, start: number, end: number) =>
  /[/\\]/.test(text[start - 1] ?? "") || /^(?:[/\\]|\.[^\s.,;:!?、。，．)）\]」』>"'`])/.test(text.slice(end, end + 2));

function planUrls(env: DraftEnv, text: string, hits: LeakHit[], plan: Plan): void {
  for (const url of leakUrlsOf(text)) {
    if (!isFree(plan, url.index, url.index + url.text.length)) continue;
    const nod = inCode(plan, url.index, url.index + url.text.length) ? null : nodIssueUrlOf(text, url, hits);
    const target = nod && issueTargetOf(env, nod.id);
    if (nod && target) {
      // <URL> の autolink を URL でない言い換えにするときは、<> も外す
      const bracketed = text[url.index - 1] === "<" && text[nod.end] === ">" && !target.after.startsWith("https://");
      const [start, end] = bracketed && isFree(plan, url.index - 1, nod.end + 1) ? [url.index - 1, nod.end + 1] : [url.index, nod.end];
      claim(plan, start, end, { after: target.after, rule: "nod_web", reason: `nod の Web の Issue の URL を${target.as}にしました` });
    } else claim(plan, url.index, url.index + url.text.length); // ほかの URL は、その中の ID・パスも含めて残す
  }
}

function planHits(env: DraftEnv, text: string, hits: LeakHit[], plan: Plan): void {
  for (const h of hits) {
    if (h.rule === "absolute_path") {
      planPath(env, text, h.index, plan);
      continue;
    }
    const end = h.index + h.text.length;
    if (!isFree(plan, h.index, end) || inCode(plan, h.index, end)) continue;
    if (h.rule === "issue_id") {
      if (partOfPath(text, h.index, end)) continue;
      const target = issueTargetOf(env, h.text);
      if (target) claim(plan, h.index, end, { after: target.after, rule: h.rule, reason: `nod の Issue ID を${target.as}にしました` });
    } else if (h.rule === "issue_ref") {
      const r = issueRefReplacement(h.text);
      if (r) claim(plan, h.index, end, { after: r.after, rule: h.rule, reason: r.reason });
    }
  }
}

// パス全体（末尾の . は文の句点として含めない）を決め、Workspace の中なら相対パスに。残すパスも、その中を書き換えないよう範囲として持つ
function planPath(env: DraftEnv, text: string, index: number, plan: Plan): void {
  const path = text.slice(index, leakPathEnd(text, index)).replace(/\.+$/, "");
  const end = index + path.length;
  if (!path || !isFree(plan, index, end)) return;
  const rel = relativePathOf(env, path);
  claim(plan, index, end, rel ? { after: rel, rule: "absolute_path", reason: "Workspace の中を指す絶対パスを、Workspace からの相対パスにしました" } : undefined);
}

// Markdown として解析できなかった（深い入れ子でパーサーがスタックを使い切るなど）ときは null。自動では書き換えない
function structureOrNull(text: string): MdStructure | null {
  try {
    return structureOf(text);
  } catch {
    return null;
  }
}

function editsOf(env: DraftEnv, text: string): Edit[] | null {
  const hits = leakHitsOf(text, env.config);
  if (!hits.length) return [];
  const md = structureOrNull(text);
  if (!md) return null;
  const plan: Plan = { edits: [], claimed: [], code: md.code };
  planImportFooter(text, hits, plan);
  planKept(md, hits, plan);
  planLinks(env, text, md, hits, plan);
  planUrls(env, text, hits, plan);
  planHits(env, text, hits, plan);
  return plan.edits;
}

function applyEdits(field: LeakField, text: string, edits: Edit[]): { text: string; changes: GithubDraftChange[] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const positionOf = leakPositionsIn(text);
  const changes: GithubDraftChange[] = [];
  let out = "";
  let at = 0;
  for (const e of sorted) {
    out += text.slice(at, e.start) + e.after;
    at = e.end;
    changes.push({ field, ...positionOf(e.start), before: text.slice(e.start, e.end), after: e.after, rule: e.rule, reason: e.reason });
  }
  return { text: out + text.slice(at), changes };
}

export function buildGithubDraft(db: Database, issue: IssueRow, input: { title: string; body: string }, config: LeakConfig): GithubDraft {
  const env: DraftEnv = { db, issue, config, roots: workspaceRootsOf(db, issue.workspace_id), issues: new Map() };
  const unparsed: LeakField[] = [];
  const draftOf = (field: LeakField) => {
    const edits = editsOf(env, input[field]);
    if (!edits) unparsed.push(field);
    return applyEdits(field, input[field], edits ?? []);
  };
  const title = draftOf("title");
  const body = draftOf("body");
  return { title: title.text, body: body.text, changes: [...title.changes, ...body.changes], unparsed };
}
