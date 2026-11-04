import { readReviewResponsibility, verifyReviewResponsibility, type ReviewResponsibility } from "./review-responsibility";
import { readStandardScope, verifyStandardScope, type StandardScope, type StandardRange } from "./review-scope";
import { captureLocalReview, sensitiveReviewPath, type LocalReviewSnapshot } from "./review-snapshot";
import { reviewProcess, ReviewFailure } from "./review-process";
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { getDocument, listDocuments } from "./documents";
import { getIssue, listIssues } from "./issues";
import { gitRunner } from "./git-runner";
import type { IssueDetail } from "../types";

export interface ReviewSource {
  applicability?: StandardRange[];
  type: "issue" | "document" | "plan" | "standard";
  id: string;
  path?: string;
  title: string;
  content: string;
  hash: string;
  version: string;
  sections: { title: string; line: number; hash: string }[];
}
export interface ReviewPreparation {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  status: "prepared" | "incomplete";
  score: null;
  review: { standards: "not_started"; spec: "not_started" };
  target: null | { mode: "commit" | "local"; local?: LocalReviewSnapshot; repo: string; baseSha: string; headSha: string; mergeBaseSha: string; patch: string; hash: string; files: string[]; commitMessages?: string[]; commitMessagesTruncated?: boolean };
  requirements: {
    primary: string[]; issueIds: string[]; consistency: "unverified"; excluded: { id: number; reason: string }[];
    /** 説明資料から参照されているが固定対象にない資料。必須かどうかはレビューが判断する。 */
    unresolvedReferences: { path: string; referencedFrom: string; line: number }[];
    /** 必要資料の取得成功だけを表す。内容の整合性や充足を保証しない。 */
    acquisition?: { status: "complete"; mode: "document_only" | "issue_context"; sourceIds: string[] };
  };
  sources: ReviewSource[];
  standardScope?: StandardScope;
  responsibility?: ReviewResponsibility;
  standardScopeTemplatePath?: string;
  problems: { code: string; message: string }[];
  remaining: string[];
  artifactPath: string;
}
export interface PrepareReviewInput {
  repo: string;
  base: string;
  head?: string;
  local?: boolean;
  untracked?: string[];
  issue?: string;
  document?: string;
  scopePlan?: string;
  responsibilityPlan?: string;
  outputDir: string;
  deadline?: number;
  signal?: AbortSignal;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
class PreparationFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function source(type: ReviewSource["type"], id: string, title: string, content: string, version: string, path?: string): ReviewSource {
  const lines = content.split("\n");
  const headings = lines.flatMap((line, i) => /^#{1,6}\s/.test(line) ? [{ title: line, line: i + 1 }] : []);
  return { type, id, title, content, version, path, hash: hash(content), sections: headings.map((h, i) => ({ ...h, hash: hash(lines.slice(h.line - 1, headings[i + 1] ? headings[i + 1]!.line - 1 : undefined).join("\n")) })) };
}

// 明示された状態だけを採用する。本文中の「旧版」の言及で現行要求を除外しない。
function inactiveDocument(title: string, content: string): boolean {
  return /^(旧版|検討資料|草案)(?:[：:・\s]|$)/.test(title)
    || /^状態[：:]\s*(旧版|検討資料|草案|superseded|rejected|draft)\s*$/m.test(content)
    || /^---\r?\n(?:(?!^---)[\s\S])*?^status:\s*(superseded|rejected|draft)\s*$/m.test(content);
}

/** 対象の入力だけを固定する。レビュー結果や承認は生成しない。 */
export async function prepareReview(db: Database, input: PrepareReviewInput): Promise<ReviewPreparation> {
  const runId = randomUUID();
  const result: ReviewPreparation = {
    schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: "incomplete", score: null,
    review: { standards: "not_started", spec: "not_started" }, target: null,
    requirements: { primary: [], issueIds: [], consistency: "unverified", excluded: [], unresolvedReferences: [] }, sources: [], problems: [],
    remaining: ["要求同士の意味上の整合性確認", "Standards探索", "Spec探索と要求別の充足確認", "候補検証"],
    artifactPath: join(resolve(input.outputDir), runId, "preparation.json"),
  };
  const repo = resolve(input.repo);
  const git = async (...args: string[]) => {
    if (input.deadline !== undefined) {
      try {
        return (await reviewProcess("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repo, ...args], {
          cwd: repo, deadline: input.deadline, signal: input.signal ?? new AbortController().signal, maxBytes: 20 * 1024 * 1024,
        })).stdout;
      } catch (error) {
        if (error instanceof ReviewFailure) throw new PreparationFailure(error.code === "CLI_FAILED" ? "GIT_FAILED" : error.code, error.message);
        throw error;
      }
    }
    const r = await gitRunner(["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repo, ...args], { timeoutMs: 15_000, maxStdoutBytes: 20 * 1024 * 1024 });
    if (r.kind !== "exited" || r.exitCode !== 0) throw new PreparationFailure("GIT_FAILED", `Gitで対象を取得できません: ${args[0]}（${r.kind === "exited" ? r.stderr.trim() : r.kind}）`);
    return r.stdout;
  };
  try {
    if (input.local && input.head && input.head !== "HEAD") throw new PreparationFailure("LOCAL_HEAD_INVALID", "local対象では現在のHEADだけを指定できます");
    if (!input.local && input.untracked?.length) throw new PreparationFailure("LOCAL_REQUIRED", "未追跡ファイルの指定には--localが必要です");
    const baseSha = (await git("rev-parse", "--verify", "--end-of-options", `${input.base}^{commit}`)).trim();
    const headSha = (await git("rev-parse", "--verify", "--end-of-options", `${input.head ?? "HEAD"}^{commit}`)).trim();
    const mergeBaseSha = (await git("merge-base", baseSha, headSha)).trim();
    const local = input.local ? await captureLocalReview({ repo, directory: dirname(result.artifactPath), headSha, untracked: input.untracked ?? [], git, deadline: input.deadline, signal: input.signal }) : undefined;
    const snapshotGit = local ? (...args: string[]) => git("--git-dir", local.repo, ...args) : git;
    const revision = local?.treeSha ?? headSha;
    const files = (await snapshotGit("diff", "--name-only", "-z", mergeBaseSha, revision, "--")).split("\0").filter(Boolean);
    const excluded = files.find(sensitiveReviewPath);
    if (excluded) throw new PreparationFailure("SNAPSHOT_EXCLUDED", `差分の ${excluded} は秘密情報を含み得るため本文を読みません。必要範囲の確認が必要です`);
    const patch = await snapshotGit("diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--binary", mergeBaseSha, revision, "--");
    result.target = { mode: local ? "local" : "commit", local, repo, baseSha, headSha, mergeBaseSha, patch, hash: local ? hash(JSON.stringify({ mode: "local", headSha, mergeBaseSha, treeSha: local.treeSha, indexTreeSha: local.indexTreeSha, indexHash: local.indexHash, untracked: local.untracked })) : hash(patch), files };
    // 規約が求めるコミットメッセージの形式を確認できるよう、対象のメッセージを固定する。識別値には含めない（SHAで固定済み）。
    if (!local) {
      const messages = (await snapshotGit("log", "--no-merges", "--format=%H%n%B%x00", "-n", "51", `${mergeBaseSha}..${headSha}`)).split("\0").map(item => item.trim()).filter(Boolean);
      result.target.commitMessages = messages.slice(0, 50);
      if (messages.length > 50) result.target.commitMessagesTruncated = true;
    }
    if (!files.length) throw new PreparationFailure("EMPTY_DIFF", "固定した対象の差分が空です。基点と対象を確認してください");
    const tracked = (await snapshotGit("ls-tree", "-r", "--name-only", "-z", revision)).split("\0");
    const standards = new Set<string>();
    for (const file of files) {
      let dir = dirname(file);
      for (;;) {
        for (const name of ["AGENTS.md", "CLAUDE.md", "CODING_STANDARDS.md", "CONTRIBUTING.md", "README.md"]) {
          const path = dir === "." ? name : `${dir}/${name}`;
          if (tracked.includes(path)) standards.add(path);
        }
        if (dir === ".") break;
        dir = dirname(dir);
      }
    }
    for (const path of standards) {
      if (sensitiveReviewPath(path)) throw new PreparationFailure("STANDARD_UNREADABLE", `規約 ${path} は秘密情報を含み得るため本文を読みません`);
      let content: string;
      try {
        const mode = (await snapshotGit("ls-tree", revision, "--", path)).split(" ")[0];
        if (mode !== "100644" && mode !== "100755") throw new Error("通常ファイルではありません");
        content = await snapshotGit("show", `${revision}:${path}`);
      } catch {
        throw new PreparationFailure("STANDARD_UNREADABLE", `規約 ${path} を固定対象から読めません`);
      }
      result.sources.push(source("standard", path, path, content, revision, path));
      // 規約から参照されるローカルMarkdownも固定する。循環参照はSetで一度だけ読む。
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const link = match[1]!.split("#")[0]!;
        if (!link || /^(?:[a-z]+:|\/)/i.test(link) || !/\.md$/i.test(link)) continue;
        const ref = posix.normalize(posix.join(posix.dirname(path), link));
        if (ref.startsWith("../") || !tracked.includes(ref)) {
          // 開発規約が直接指す資料の欠落は停止する。説明資料からの切れたリンクは必須要求と決めず、記録してレビューの判断に委ねる。
          if (/(^|\/)(AGENTS|CLAUDE|CODING_STANDARDS|CONTRIBUTING)\.md$/.test(path)) throw new PreparationFailure("STANDARD_UNREADABLE", `規約 ${path} の参照先 ${link} を固定対象から読めません`);
          result.requirements.unresolvedReferences.push({ path: ref, referencedFrom: path, line: content.slice(0, match.index).split("\n").length });
          continue;
        }
        standards.add(ref);
      }
    }
    const issues: IssueDetail[] = [];
    let explicitDoc: ReturnType<typeof getDocument> | undefined;
    if (input.document) {
      const ref = /^\d+$/.test(input.document) ? Number(input.document) : listDocuments(db).find(d => resolve(d.path) === resolve(repo, input.document!))?.id;
      if (ref) {
        explicitDoc = getDocument(db, ref);
        for (const linked of explicitDoc.issues) issues.push(getIssue(db, linked.id));
      } else {
        if (/^\d+$/.test(input.document) || !/\.md$/i.test(input.document)) throw new PreparationFailure("DOCUMENT_NOT_FOUND", `要求Document ${input.document} を特定できません`);
        const path = resolve(repo, input.document);
        try {
          const content = readFileSync(path, "utf8");
          if (inactiveDocument(/^#\s+(.+)$/m.exec(content)?.[1] ?? "", content)) {
            throw new PreparationFailure("DOCUMENT_INACTIVE", `明示した要求文書 ${path} は現行要求ではありません`);
          }
          result.sources.push(source("document", path, path, content, String(statSync(path).mtimeMs), path));
          result.requirements.primary.push(`document:${path}`);
        } catch (error) {
          if (error instanceof PreparationFailure) throw error;
          throw new PreparationFailure("DOCUMENT_UNREADABLE", `明示した要求文書 ${path} を取得できません`);
        }
      }
    }
    if (input.issue) {
      const issue = getIssue(db, input.issue);
      if (!issues.some(i => i.id === issue.id)) issues.push(issue);
    } else if (!input.document) {
      const branch = (await git("branch", "--show-current")).trim();
      const common = (await git("rev-parse", "--path-format=absolute", "--git-common-dir")).trim();
      const workspace = db.query("SELECT key FROM workspaces WHERE path = ?").get(dirname(common)) as { key: string } | null;
      const candidates = branch ? listIssues(db, { statuses: ["triage", "backlog", "needs_clarification", "todo", "in_progress", "done", "canceled"] }).filter(i => i.branch === branch) : [];
      const matches = [];
      for (const candidate of candidates) {
        // Personalなど別WorkspaceのIssueも、記録した作業場所がこのrepoなら対象にする。
        if (candidate.worktree) {
          const location = input.deadline === undefined
            ? await gitRunner(["-C", candidate.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 15_000, maxStdoutBytes: 4096 })
            : await reviewProcess("git", ["-C", candidate.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
              cwd: repo, deadline: input.deadline, signal: input.signal ?? new AbortController().signal, maxBytes: 4096,
            }).then(r => ({ kind: "exited" as const, exitCode: 0, stdout: r.stdout })).catch(error => {
              if (error instanceof ReviewFailure && ["DEADLINE_EXCEEDED", "CANCELLED", "CHILD_STOP_FAILED"].includes(error.code)) throw new PreparationFailure(error.code, error.message);
              return { kind: "not_found" as const };
            });
          if (location.kind === "exited" && location.exitCode === 0 && realpathSync(location.stdout.trim()) === realpathSync(common)) matches.push(candidate);
        } else if (candidate.workspace === workspace?.key) {
          matches.push(candidate);
        }
      }
      if (matches.length !== 1) throw new PreparationFailure("ISSUE_UNRESOLVED", `現在のブランチを記録したIssueは${matches.length}件です。--issue または --document で要求元を指定してください`);
      issues.push(getIssue(db, matches[0]!.id));
    }
    const docs = new Map<number, ReturnType<typeof getDocument>>();
    if (explicitDoc) docs.set(explicitDoc.id, explicitDoc);
    for (const issue of issues) {
      result.requirements.issueIds.push(issue.id);
      result.sources.push(source("issue", issue.id, issue.title, issue.description ?? "", issue.updatedAt));
      if (issue.plan.tasks.length) result.sources.push(source("plan", issue.id, `${issue.id} のTask・Step`, JSON.stringify(issue.plan, null, 2), issue.updatedAt, issue.plan.source ?? undefined));
      for (const doc of issue.documents) {
        if (doc.id === explicitDoc?.id || doc.kind === "spec" || (doc.kind === "plan" && doc.path === issue.plan.source)) {
          docs.set(doc.id, getDocument(db, doc.id));
        } else {
          result.requirements.excluded.push({ id: doc.id, reason: doc.kind === "plan" ? "現在のTask・Stepの元文書ではない計画" : "要求として指定されていない参考文書" });
        }
      }
      if (issue.plan.source && ![...docs.values()].some(d => d.path === issue.plan.source)) {
        throw new PreparationFailure("PLAN_UNREADABLE", `現在の計画 ${issue.plan.source} のDocumentがありません`);
      }
    }
    for (const doc of docs.values()) {
      const retired = inactiveDocument(doc.title, doc.content ?? "");
      if (retired) {
        result.requirements.excluded.push({ id: doc.id, reason: "旧版・検討資料と明示された文書" });
        if (doc.id === explicitDoc?.id || issues.some(i => i.plan.source === doc.path)) throw new PreparationFailure("DOCUMENT_INACTIVE", `明示Document ${doc.id} は現行要求ではありません`);
        continue;
      }
      if (doc.content === null) throw new PreparationFailure("DOCUMENT_UNREADABLE", `Document ${doc.id} (${doc.path}) を取得できません。本文へ代替せず、元の文書を復旧してください`);
      result.sources.push(source("document", String(doc.id), doc.title, doc.content, String(doc.mtime), doc.path));
      if (doc.kind === "spec" || doc.id === explicitDoc?.id) result.requirements.primary.push(`document:${doc.id}`);
    }
    if (!result.requirements.primary.length) result.requirements.primary = issues.map(i => `issue:${i.id}`);
    for (const primary of result.requirements.primary) {
      const [type, ...parts] = primary.split(":");
      const entry = result.sources.find(s => s.type === type && s.id === parts.join(":"));
      if (!entry?.content.trim()) throw new PreparationFailure("REQUIREMENTS_EMPTY", `要求元 ${primary} に本文がありません。要求の本文を指定してください`);
    }
    if (result.requirements.primary.filter(p => p.startsWith("document:")).length > 1) {
      throw new PreparationFailure("REQUIREMENTS_AMBIGUOUS", "有効な要求Documentが複数あります。補完関係・矛盾・旧版の区別を確認してください。更新日時による自動選択は行いません");
    }
    if (input.scopePlan) result.standardScope = readStandardScope(resolve(repo, input.scopePlan), result.sources);
    if (input.responsibilityPlan) result.responsibility = readReviewResponsibility(resolve(repo, input.responsibilityPlan), result.sources);
    result.requirements.acquisition = {
      status: "complete", mode: issues.length ? "issue_context" : "document_only",
      sourceIds: result.sources.filter(s => s.type !== "standard").map(s => `${s.type}:${s.id}`),
    };
    result.status = "prepared";
  } catch (error) {
    result.problems.push({ code: error instanceof PreparationFailure || error instanceof ReviewFailure ? error.code : "SOURCE_FAILED", message: error instanceof Error ? error.message : String(error) });
  }
  mkdirSync(dirname(result.artifactPath), { recursive: true });
  if (result.status === "prepared") {
    result.standardScopeTemplatePath = join(dirname(result.artifactPath), "standard-scope.template.json");
    const template = { version: 1, standards: result.sources.filter(s => s.type === "standard").map(s => ({
      source: `standard:${s.id}`, hash: s.hash, ranges: [{ start: 1, end: s.content.split("\n").length, kind: "unresolved", rationale: "適用範囲を未判定。固定資料と今回の要求から判断する。" }],
    })) };
    writeFileSync(result.standardScopeTemplatePath, JSON.stringify(template, null, 2) + "\n", { flag: "wx" });
  }
  writeFileSync(result.artifactPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}

/** 実行中の要求・添付関係・適用規約の変更を検出する。準備結果は上書きしない。 */
export function reviewSourceFingerprint(db: Database, preparation: ReviewPreparation): string {
  return hash(JSON.stringify({
    standardScope: verifyStandardScope(preparation.standardScope),
    responsibility: verifyReviewResponsibility(preparation.responsibility),
    issues: preparation.requirements.issueIds.map(id => {
      const issue = getIssue(db, id);
      const source = preparation.sources.find(s => s.type === "issue" && s.id === id)!;
      const plan = preparation.sources.find(s => s.type === "plan" && s.id === id);
      if (source.title !== issue.title || source.content !== (issue.description ?? "") || (plan && plan.content !== JSON.stringify(issue.plan, null, 2))) throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定したIssue・計画が変更されました。新しい実行が必要です");
      return { id, title: issue.title, description: issue.description, updatedAt: issue.updatedAt, plan: issue.plan,
        documents: issue.documents.filter(d => d.kind === "spec" || d.kind === "plan") };
    }),
    sources: preparation.sources.map(s => {
      if (s.type === "document") {
        if (/^\d+$/.test(s.id)) {
          const doc = getDocument(db, Number(s.id));
          if (doc.content !== s.content || doc.title !== s.title) throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した要求Documentが変更されました。新しい実行が必要です");
          return { id: s.id, title: doc.title, content: doc.content, mtime: doc.mtime, kind: doc.kind, issues: doc.issues };
        }
        const content = readFileSync(s.path!, "utf8");
        if (content !== s.content) throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した要求文書が変更されました。新しい実行が必要です");
        return { id: s.id, content, mtime: statSync(s.path!).mtimeMs };
      }
      if (s.type === "standard") {
        try {
          const path = join(preparation.target!.repo, s.path!);
          const stat = lstatSync(path);
          if (!stat.isFile()) {
            if (preparation.target!.mode === "local") throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した適用規約を取得できません");
            return { id: s.id, unavailable: true };
          }
          const content = readFileSync(path, "utf8");
          if (preparation.target!.mode === "local" && content !== s.content) throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した適用規約が変更されました。新しい実行が必要です");
          return { id: s.id, content, mtime: stat.mtimeMs };
        }
        catch (error) {
          if (error instanceof ReviewFailure) throw error;
          if (preparation.target!.mode === "local") throw new ReviewFailure("REQUIREMENTS_CHANGED", "固定した適用規約を取得できません");
          return { id: s.id, unavailable: true };
        }
      }
      return { id: s.id, hash: s.hash };
    }),
  }));
}
