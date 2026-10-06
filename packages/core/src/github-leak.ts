import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { defaultAttachmentsDir } from "./ops/attachments";
import { defaultDocsDir } from "./ops/documents";

// GitHub に送るタイトル・本文から nod の情報を見つける。原文の全体（コードブロック・HTML コメント・リンク先・URL の中）を調べ、
// 見つけた箇所を返すだけで、消したり書き換えたりしない。防ぐのは分かっている形の漏れまでで、すべての個人環境の情報がないことは保証しない
export type LeakRule = "issue_id" | "issue_ref" | "nod_web" | "nod_command" | "import_footer" | "absolute_path" | "link_target";
export type LeakField = "title" | "body";

export interface LeakFinding {
  field: LeakField;
  line: number; // 1始まり
  column: number; // 1始まり。コードポイント数
  text: string;
  rule: LeakRule;
  reason: string;
}

export interface LeakConfig {
  workspaceKeys: string[]; // 登録済みの全 Workspace のキー
  knownPaths: string[]; // nod が知っているパス（HOME、Workspace、Documents、添付、DB。realpath を含む）
  webPorts: number[]; // nod の Web のポート
}

export const NOD_WEB_DEFAULT_PORT = 4700;

const REASONS: Record<LeakRule, string> = {
  issue_id: "nod の Issue ID です。GitHub に出さないよう書き換えてください",
  issue_ref: "番号だけの参照です。nod の番号と取り違えないよう、完全な GitHub の URL（https://github.com/owner/repo/issues/N）に直してください",
  nod_web: "nod の Web の URL です",
  nod_command: "nod のコマンドです",
  import_footer: "nod の取り込みで付いた footer です",
  absolute_path: "手元の環境のパスです",
  link_target: "GitHub で開けないリンク先です（http(s)://・mailto:・ページ内の #見出し だけを使えます）",
};

// 正規の GitHub Issue/PR URL。この範囲だけを調べない（後ろに / ? # などが続くものは例外にしない）
const GITHUB_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+\/(?:issues|pull)\/\d+(?=$|[\s)\]>"'<,;:!?、。]|\.(?:$|\s))/gm;
// 成り立つ HTML の実体参照（&#123; &#x7B;）。番号の参照としては扱わない
const ENTITY_RE = /&#(?:\d+|x[0-9a-f]+);/gi;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gi;
const SCHEME_HOST_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

const PATH_BEFORE = String.raw`(?<![A-Za-z0-9_./\\~-])`;
const DELIM = String.raw`[\s"'\`()\[\]{}<>,;:!?、。]`;
const PATH_END = String.raw`(?=/|$|${DELIM})`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

interface Pattern {
  rule: LeakRule;
  re: RegExp; // g を持つ
  entityMasked?: boolean; // 実体参照を外した文字列で調べる
}

function pathPatterns(config: LeakConfig): RegExp[] {
  const res = [
    new RegExp(String.raw`${PATH_BEFORE}/(?:Users|home)/[^/\s"'\`()\[\]{}<>,;:!?、。]+${PATH_END}`, "gm"),
    new RegExp(String.raw`${PATH_BEFORE}~/`, "gm"),
    new RegExp(String.raw`${PATH_BEFORE}/(?:private|var/folders|tmp)${PATH_END}`, "gm"),
    new RegExp(String.raw`${PATH_BEFORE}[A-Za-z]:[\\/]`, "gm"),
  ];
  for (const p of config.knownPaths) {
    const trimmed = p.replace(/\/+$/, "");
    if (trimmed.length < 2) continue;
    res.push(new RegExp(String.raw`${PATH_BEFORE}${escapeRe(trimmed)}${PATH_END}`, "gm"));
  }
  return res;
}

function patternsOf(config: LeakConfig): Pattern[] {
  const list: Pattern[] = [];
  if (config.workspaceKeys.length) {
    const keys = config.workspaceKeys.map(escapeRe).join("|");
    list.push({ rule: "issue_id", re: new RegExp(String.raw`(?<![A-Za-z0-9_-])(?:${keys})-\d+(?![A-Za-z0-9_-])`, "gi") });
  }
  list.push({ rule: "issue_ref", re: /(?<![\w/#])#\d+(?!\w)/g, entityMasked: true });
  list.push({ rule: "issue_ref", re: /(?<![\w.-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+#\d+(?!\w)/g, entityMasked: true });
  if (config.webPorts.length) {
    list.push({ rule: "nod_web", re: new RegExp(String.raw`(?:localhost|127\.0\.0\.1):(?:${config.webPorts.join("|")})(?!\d)`, "gi") });
  }
  list.push({ rule: "nod_command", re: /(?<![\w-])nod\s+issue\s+show(?![\w-])/g });
  list.push({ rule: "import_footer", re: /取り込み元[:：]/g });
  for (const re of pathPatterns(config)) list.push({ rule: "absolute_path", re });
  return list;
}

// Markdown のリンク・画像・参照定義、HTML の src・href、autolink。リンク先は1〜3番目のグループのどれか
const LINK_PATTERNS: RegExp[] = [
  /!?\[[^\]\n]*\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
  /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]*)>?/gm,
  /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  /<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi,
];

function allowedTarget(target: string): boolean {
  return /^(?:https?:\/\/\S|mailto:\S)/i.test(target) || /^#\S+$/.test(target);
}

const mask = (text: string, re: RegExp) => text.replace(re, (m) => " ".repeat(m.length));

function position(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: Array.from(text.slice(lineStart, index)).length + 1 };
}

// URL はスキームとホストを外したパスと、percent-decode を1回した形も調べる（壊れたエンコードは原文だけ）
function urlVariants(url: string): string[] {
  const out = [url.replace(SCHEME_HOST_RE, "")];
  try {
    const decoded = decodeURIComponent(url);
    if (decoded !== url) out.push(decoded, decoded.replace(SCHEME_HOST_RE, ""));
  } catch {
    // 壊れたエンコードは原文だけを調べる
  }
  return out;
}

interface Hit {
  index: number;
  text: string;
  rule: LeakRule;
}

function scanField(raw: string, patterns: Pattern[]): Hit[] {
  const masked = mask(raw, GITHUB_URL_RE);
  const entityMasked = mask(masked, ENTITY_RE);
  const hits: Hit[] = [];
  for (const p of patterns) {
    for (const m of (p.entityMasked ? entityMasked : masked).matchAll(p.re)) hits.push({ index: m.index ?? 0, text: m[0], rule: p.rule });
  }
  const urlRules = patterns
    .filter((p) => p.rule === "issue_id" || p.rule === "absolute_path")
    .map((p) => ({ rule: p.rule, re: new RegExp(p.re.source, p.re.flags.replace("g", "")) }));
  for (const m of masked.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    for (const variant of urlVariants(m[0])) {
      for (const p of urlRules) {
        if (!p.re.test(variant)) continue;
        if (hits.some((h) => h.rule === p.rule && h.index >= start && h.index < end)) continue;
        hits.push({ index: start, text: m[0], rule: p.rule });
      }
    }
  }
  for (const re of LINK_PATTERNS) {
    for (const m of raw.matchAll(re)) {
      const target = m[1] ?? m[2] ?? m[3] ?? "";
      if (allowedTarget(target)) continue;
      const base = m[0].search(/\]\(|\]:|=|</);
      const offset = m[0].indexOf(target, base + 1);
      hits.push({ index: (m.index ?? 0) + Math.max(0, offset), text: target || m[0], rule: "link_target" });
    }
  }
  const seen = new Set<string>();
  return hits
    .filter((h) => {
      const key = `${h.rule}:${h.index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.index - b.index);
}

export function detectLeaks(input: { title: string; body: string }, config: LeakConfig): LeakFinding[] {
  const patterns = patternsOf(config);
  const out: LeakFinding[] = [];
  for (const field of ["title", "body"] as const) {
    const raw = input[field];
    for (const h of scanField(raw, patterns)) {
      out.push({ field, ...position(raw, h.index), text: h.text, rule: h.rule, reason: REASONS[h.rule] });
    }
  }
  return out;
}

// 検出に使う設定を DB と環境から作る。webPort は server が待ち受けている実際のポート（CLI では渡さない）
export function leakConfigOf(db: Database, opts: { webPort?: number; env?: Record<string, string | undefined> } = {}): LeakConfig {
  const env = opts.env ?? process.env;
  const rows = db.query("SELECT key, path FROM workspaces ORDER BY key").all() as { key: string; path: string }[];
  const base = [env.HOME || homedir(), ...rows.map((r) => r.path), defaultDocsDir(env), defaultAttachmentsDir(env), db.filename];
  const paths = new Set<string>();
  for (const p of base) {
    if (!p || !p.startsWith("/")) continue;
    paths.add(p);
    try {
      paths.add(realpathSync(p));
    } catch {
      // 実在しないパスは設定上の表記だけで照合する
    }
  }
  const ports = [NOD_WEB_DEFAULT_PORT, ...(opts.webPort && opts.webPort !== NOD_WEB_DEFAULT_PORT ? [opts.webPort] : [])];
  return { workspaceKeys: rows.map((r) => r.key), knownPaths: [...paths], webPorts: ports };
}
