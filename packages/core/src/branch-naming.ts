import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { IssueRow } from "./issue-query";
import { githubLinkOf } from "./ops/github-links";
import { githubRepoOfWorkspace } from "./ops/github-repo";

// ブランチ名と Orca の worktree 名。GitHub に出るので nod の ID を含めない。
// 公開済み（今の公開先の対応がある）は issue-<GitHub の番号>-<slug>、未公開は <slug>-<hash>。
// hash は sha256("<キー>-<番号>") の先頭 8 桁で、DB を変えずに決まる。キーと連番から総当たりで求められるので秘匿ではなく、
// 保証するのは nod の ID を平文で書かないことまで。キーを変えると hash も変わる
export const SLUG_MAX = 40;

export function slugOf(text: string, workspaceKeys: string[]): string {
  let s = text.normalize("NFKC").toLowerCase();
  const keys = workspaceKeys.map((k) => k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (keys) s = s.replace(new RegExp(String.raw`(?<![a-z0-9])(?:${keys})-\d+(?![a-z0-9])`, "g"), " ");
  // 区切りが空白や _ や ‑ だった "API 12" のような並びも、- でつないだ後は ID と同じ形になる。語の単位で取り除く
  const strip = (joined: string): string => {
    if (!keys) return joined;
    const re = new RegExp(`(^|-)(?:${keys})-\\d+(?=-|$)`);
    let prev: string;
    do {
      prev = joined;
      joined = joined.replace(re, "$1").replace(/^-+|-+$/g, "").replace(/--+/g, "-");
    } while (joined !== prev);
    return joined;
  };
  const joined = strip((s.match(/[a-z0-9]+/g) ?? []).join("-"));
  // 切り詰めで "api-12x" が "api-12" になることがあるので、もう一度かける
  return strip(joined.slice(0, SLUG_MAX).replace(/^-+|-+$/g, ""));
}

export function issueHash(key: string, number: number): string {
  return createHash("sha256").update(`${key.toUpperCase()}-${number}`).digest("hex").slice(0, 8);
}

function workspaceKeysOf(db: Database): string[] {
  return (db.query("SELECT key FROM workspaces").all() as { key: string }[]).map((r) => r.key);
}

function publishedNumber(db: Database, row: IssueRow): number | null {
  const link = githubLinkOf(db, row.id);
  const repo = githubRepoOfWorkspace(db, row.workspace_id);
  return link && repo && link.repo.toLowerCase() === repo.toLowerCase() ? link.number : null;
}

function nameFor(db: Database, row: IssueRow, base: string): string {
  const slug = slugOf(base, workspaceKeysOf(db));
  const number = publishedNumber(db, row);
  if (number !== null) return slug ? `issue-${number}-${slug}` : `issue-${number}`;
  const hash = issueHash(row.ws_key, row.number);
  return slug ? `${slug}-${hash}` : hash;
}

export function branchNameFor(db: Database, row: IssueRow): string {
  return nameFor(db, row, row.title);
}

export function worktreeNameFor(db: Database, row: IssueRow, feature: string): string {
  return nameFor(db, row, feature);
}
