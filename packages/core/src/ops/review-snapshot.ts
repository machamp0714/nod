import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ReviewFailure } from "./review-failure";
import { reviewGit } from "./review-git";

export const sensitiveReviewPath = (path: string) => path.split("/").some(part => /^(?:\.env(?:\..*)?|\.aws|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|[^/]*\.(?:pem|key))$/i.test(part));
export interface LocalReviewSnapshot {
  repo: string;
  treeSha: string;
  indexTreeSha: string;
  indexHash: string;
  sourceFingerprint: string;
  stagedPatch: string;
  untracked: string[];
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Git = (...args: string[]) => Promise<string>;
type Captured = { path: string; mode: string; content?: Buffer; state: string };

function captureFile(repo: string, path: string, required: boolean): Captured {
  if (!path || path.startsWith("/") || path.split("/").some(part => ["", ".", "..", ".git"].includes(part))) throw new ReviewFailure("LOCAL_PATH_INVALID", "対象はリポジトリ内の通常ファイルを相対パスで指定してください");
  const destination = resolve(repo, path);
  if (!destination.startsWith(repo + sep)) throw new ReviewFailure("LOCAL_PATH_INVALID", "リポジトリ外のファイルは対象にできません");
  // 親ディレクトリも検査し、外部を指すsymlinkの先を読まない。
  let parent = dirname(destination);
  while (parent !== repo) {
    try { if (!lstatSync(parent).isDirectory()) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `${path} の親は通常ディレクトリではありません`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    parent = dirname(parent);
  }
  let stat;
  try { stat = lstatSync(destination); }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return { path, mode: "0", state: "deleted" };
    throw new ReviewFailure("LOCAL_SOURCE_UNREADABLE", `対象 ${path} を取得できません`);
  }
  if (stat.isSymbolicLink()) return { path, mode: "120000", state: digest(readlinkSync(destination)) };
  if (!stat.isFile()) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `${path} は通常ファイルではありません`);
  if (sensitiveReviewPath(path)) return { path, mode: "excluded", state: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  if (stat.size > 2 * 1024 * 1024) return { path, mode: "large", state: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  const content = readFileSync(destination);
  return { path, mode: stat.mode & 0o111 ? "100755" : "100644", content, state: digest(content) };
}

/** 元のrepoには書かず、独立したindexとobject領域だけでtreeを作る。commitは作らない。 */
export async function captureLocalReview(input: { repo: string; directory: string; headSha: string; untracked: string[]; git: Git }): Promise<LocalReviewSnapshot> {
  const { repo, git } = input;
  const indexPath = resolve(repo, (await git("rev-parse", "--git-path", "index")).trim());
  const indexBytes = readFileSync(indexPath);
  const flags = (await git("ls-files", "-v", "-z")).split("\0").filter(Boolean);
  if (flags.some(entry => entry[0] === "S" || /^[a-z]/.test(entry))) throw new ReviewFailure("LOCAL_INDEX_UNSUPPORTED", "skip-worktree・assume-unchangedを含むindexはlocal対象として未対応です。欠落を削除として扱いません");
  const staged = await git("ls-files", "--stage", "-z");
  const entries = staged.split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    const [mode, oid, stage] = line.slice(0, tab).split(" ");
    if (stage !== "0") throw new ReviewFailure("LOCAL_INDEX_CONFLICT", "indexに未解決の競合があります");
    return { path: line.slice(tab + 1), mode: mode!, oid: oid! };
  });
  const available = new Set((await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean));
  const untracked = [...new Set(input.untracked)].sort();
  for (const path of untracked) {
    if (sensitiveReviewPath(path)) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `${path} は秘密情報を含み得るため読み込みません`);
    if (!available.has(path)) throw new ReviewFailure("LOCAL_UNTRACKED_INVALID", `${path} は取得可能な未追跡ファイルではありません（ignore・存在しないパス・ディレクトリは指定不可）`);
  }
  const changedPaths = async () => new Set([
    ...(await git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", input.headSha, "--")).split("\0"),
    ...(await git("diff", "--no-ext-diff", "--no-textconv", "--cached", "--name-only", "-z", input.headSha, "--")).split("\0"),
  ]);
  const changed = await changedPaths();
  for (const path of changed) if (sensitiveReviewPath(path)) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `${path} は秘密情報を含み得るため読み込みません`);
  const paths = [...new Set([...entries.map(e => e.path), ...untracked])].sort();
  const capture = () => paths.map(path => captureFile(repo, path, untracked.includes(path)));
  const captured = capture();
  if (captured.reduce((sum, item) => sum + (item.content?.length ?? 0), 0) > 64 * 1024 * 1024) throw new ReviewFailure("SNAPSHOT_EXCLUDED", "ローカル対象の総量が64MiBを超えています");
  const state = (files: Captured[]) => digest(JSON.stringify(files.map(({ content: _content, ...file }) => file)));
  const snapshotRepo = join(input.directory, "snapshot.git");
  mkdirSync(snapshotRepo, { recursive: true });
  const isolated = async (args: string[], data?: string) => (await reviewGit(["--no-optional-locks", "-c", "core.fsmonitor=false", "--git-dir", snapshotRepo, ...args],
    { cwd: repo, input: data, maxBytes: 20 * 1024 * 1024 })).stdout;
  await isolated(["init", "--bare", "--template=", `--object-format=${(await git("rev-parse", "--show-object-format")).trim()}`, snapshotRepo]);
  const objects = resolve(repo, (await git("rev-parse", "--git-path", "objects")).trim());
  writeFileSync(join(snapshotRepo, "objects/info/alternates"), objects + "\n");
  await isolated(["-c", "core.splitIndex=false", "update-index", "-z", "--index-info"], staged);
  const indexTreeSha = (await isolated(["write-tree"])).trim();
  const stagedPatch = await isolated(["diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--binary", input.headSha, indexTreeSha, "--"]);
  const updates: string[] = [];
  for (const file of captured) {
    const prior = entries.find(e => e.path === file.path);
    if (!file.content) {
      if (file.mode === "0") updates.push(`0 ${"0".repeat(input.headSha.length)}\t${file.path}\0`);
      else if (!prior || changed.has(file.path)) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `${file.path} は通常ファイルとして固定できません`);
      continue;
    }
    const blob = join(input.directory, "snapshot-blob");
    writeFileSync(blob, file.content, { mode: 0o600 });
    let oid: string;
    try { oid = (await isolated(["hash-object", "-w", "--no-filters", "--", blob])).trim(); }
    finally { rmSync(blob, { force: true }); }
    if (file.content.includes(0) && (!prior || prior.oid !== oid)) throw new ReviewFailure("SNAPSHOT_EXCLUDED", `${file.path} は変更されたバイナリのため確認できません`);
    updates.push(`${file.mode} ${oid}\t${file.path}\0`);
  }
  await isolated(["update-index", "-z", "--index-info"], updates.join(""));
  const treeSha = (await isolated(["write-tree"])).trim();
  // 非同期のGit照合を終えてからファイルを読み直し、Git読取中の同時編集も検出する。
  const finalChangedPaths = await changedPaths();
  const finalHead = (await git("rev-parse", "HEAD")).trim();
  if (finalHead !== input.headSha || !readFileSync(indexPath).equals(indexBytes) || state(capture()) !== state(captured) || JSON.stringify([...finalChangedPaths].sort()) !== JSON.stringify([...changed].sort())) throw new ReviewFailure("LOCAL_TARGET_CHANGED", "対象の取得中にHEAD・index・作業ツリーが変更されました。新しい実行が必要です");
  return { repo: snapshotRepo, treeSha, indexTreeSha, indexHash: digest(indexBytes), sourceFingerprint: state(captured), stagedPatch, untracked };
}

/** 元のindex・作業ツリーを変更せず、明示したlocal対象が固定時と同じか確認する。 */
export async function localReviewUnchanged(repo: string, snapshot: LocalReviewSnapshot, git: Git): Promise<boolean> {
  const indexPath = resolve(repo, (await git("rev-parse", "--git-path", "index")).trim());
  const index = readFileSync(indexPath);
  if (digest(index) !== snapshot.indexHash) return false;
  const tracked = (await git("ls-files", "-z")).split("\0").filter(Boolean);
  const paths = [...new Set([...tracked, ...snapshot.untracked])].sort();
  const state = digest(JSON.stringify(paths.map(path => {
    const { content: _content, ...file } = captureFile(repo, path, snapshot.untracked.includes(path));
    return file;
  })));
  return state === snapshot.sourceFingerprint && readFileSync(indexPath).equals(index);
}
