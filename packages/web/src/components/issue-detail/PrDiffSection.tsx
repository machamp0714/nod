import { useState } from "react";
import { errorMessage } from "../../api/errors";
import {
  usePrDiff,
  usePrDiffFile,
  useRefreshPrDiff,
} from "../../api/hooks/pr-diff";
import type { PrDiff, PrDiffFileSummary } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { TONE_COLORS } from "../../lib/meta";
import {
  diffRows,
  fileStatusPill,
  githubFilesUrl,
  hasBidi,
  shortSha,
  splitBidi,
} from "../../lib/pr-diff";
import { Icon } from "../ui";
import s from "./pr-diff.module.css";

// 一覧で最初に出すファイル数。残りは「他 N ファイルを表示」で出す
const INITIAL_FILES = 5;

// PR の変更ファイルと差分（#55）。nod.pen「Issue詳細｜変更ファイル」「Reviews｜変更ファイル」「変更ファイル｜状態」に合わせる。
// 保存済みの結果を表示し、gh の実行は「更新」ボタンでだけ行う。差分・パスはテキストノードとしてだけ描画する（HTML にしない）。
// 一覧は要約だけを読み、patch は開いたファイルだけを読む
export function PrDiffSection({
  issueId,
  prUrl,
  collapsible = false,
}: {
  issueId: string;
  prUrl: string;
  collapsible?: boolean;
}) {
  const query = usePrDiff(issueId);
  const refresh = useRefreshPrDiff(issueId);
  const [open, setOpen] = useState(!collapsible);
  const view = query.data;
  const diff = view?.diff ?? null;
  const stale = view?.stale ?? null;
  const fetchError = view?.fetchError ?? null;
  const busy = refresh.isPending;
  const requestError = refresh.error ?? query.error;
  const filesUrl = githubFilesUrl(prUrl);
  const summary = diff ?? stale;
  const fileCount = diff ? diff.files.length : stale?.files;
  const tooLarge = !diff && fetchError?.code === "DIFF_TOO_LARGE";

  let note: string | null = null;
  if (!summary)
    note = busy
      ? "取得中…"
      : !fetchError && !requestError && !query.isPending
        ? "未取得。更新で gh から取得します"
        : null;

  return (
    <section
      className={collapsible ? `${s.section} ${s.boxed}` : s.section}
      aria-label="変更ファイル"
      aria-busy={busy}
    >
      <div className={s.head}>
        {collapsible && (
          <button
            type="button"
            className={s.toggle}
            aria-expanded={open}
            aria-label={open ? "変更ファイルを閉じる" : "変更ファイルを開く"}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        )}
        <h2 className={s.title}>変更ファイル</h2>
        {summary && (
          <>
            <span className={s.mono}>{fileCount}</span>
            <span className={s.sep}>·</span>
            <span className={`${s.mono} ${s.add}`}>
              +{summary.additions.toLocaleString()}
            </span>
            <span className={`${s.mono} ${s.del}`}>
              −{summary.deletions.toLocaleString()}
            </span>
            <span className={s.sep}>·</span>
            <span className={s.mono}>
              HEAD {shortSha(diff ? diff.headSha : stale!.diffHeadSha)}
            </span>
            <span className={s.sep}>·</span>
            <span
              className={s.note}
              title={busy ? undefined : summary.fetchedAt}
            >
              {busy ? "取得中…" : `取得: ${formatRelative(summary.fetchedAt)}`}
            </span>
          </>
        )}
        {note && <span className={s.note}>{note}</span>}
        <span className={s.spacer} />
        <button
          type="button"
          className={s.refresh}
          aria-label="変更ファイルを更新"
          title="gh で PR の差分を取得する"
          disabled={busy}
          onClick={() => refresh.mutate(undefined)}
        >
          <Icon name={busy ? "loader-circle" : "refresh-cw"} size={12} />
        </button>
        {filesUrl && (summary || fetchError) && (
          <a
            className={s.link}
            href={filesUrl}
            target="_blank"
            rel="noreferrer"
          >
            GitHub で開く ↗
          </a>
        )}
      </div>

      {open && (
        <>
          {(requestError || (fetchError && !tooLarge)) && (
            <p className={s.error} role="alert">
              <Icon name="circle-alert" size={13} />
              <span>
                {requestError
                  ? `更新できませんでした：${errorMessage(requestError)}`
                  : diff
                    ? `差分を取得できませんでした：${fetchError!.message}`
                    : fetchError!.message}
              </span>
            </p>
          )}
          {stale && (
            <p className={s.stale} role="status">
              <Icon name="triangle-alert" size={13} />
              <span>
                PR が更新されています（HEAD {shortSha(stale.diffHeadSha)} →{" "}
                {shortSha(stale.currentHeadSha)}）。差分を更新してください
              </span>
            </p>
          )}
          {tooLarge && (
            <div className={s.tooLarge} role="status">
              <Icon name="file-warning" size={14} />
              <span className={s.tooLargeText} title={fetchError!.message}>
                差分が大きすぎます。GitHub で確認してください
              </span>
              {filesUrl && (
                <a
                  className={s.link}
                  href={filesUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub で開く ↗
                </a>
              )}
            </div>
          )}
          {diff && diff.files.length > 0 && (
            <FileList issueId={issueId} diff={diff} />
          )}
          {diff && diff.files.length === 0 && (
            <p className={s.note}>変更ファイルはありません</p>
          )}
        </>
      )}
    </section>
  );
}

function FileList({ issueId, diff }: { issueId: string; diff: PrDiff }) {
  const [showAll, setShowAll] = useState(false);
  const files = diff.files;
  const shown = showAll ? files : files.slice(0, INITIAL_FILES);
  return (
    <ul className={s.files} aria-label="変更ファイルの一覧">
      {shown.map((f, i) => (
        <FileRow
          key={`${i}-${f.path}`}
          issueId={issueId}
          diff={diff}
          file={f}
        />
      ))}
      {!showAll && files.length > INITIAL_FILES && (
        <li className={s.more}>
          <button
            type="button"
            className={s.moreButton}
            onClick={() => setShowAll(true)}
          >
            他 {files.length - INITIAL_FILES} ファイルを表示
          </button>
        </li>
      )}
    </ul>
  );
}

// 双方向の制御文字を符号（⟪U+202E⟫）にして描画する
function BidiText({ text }: { text: string }) {
  return (
    <>
      {splitBidi(text).map((p, i) =>
        p.bidi ? (
          <span key={i} className={s.bidi}>
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

const shown = (text: string) =>
  splitBidi(text)
    .map((p) => p.text)
    .join("");

function FileRow({
  issueId,
  diff,
  file,
}: {
  issueId: string;
  diff: PrDiff;
  file: PrDiffFileSummary;
}) {
  const [open, setOpen] = useState(false);
  // 閉じている間とバイナリ・大きいファイル（patch が無い）は読まない
  const body = usePrDiffFile(
    issueId,
    diff,
    file.path,
    open && file.omitted === null,
  );
  const pill = fileStatusPill(file);
  const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <li className={s.file}>
      <button
        type="button"
        className={open ? `${s.fileRow} ${s.fileRowOpen}` : s.fileRow}
        aria-label={`${pill.label} ${shown(path)} ${file.binary ? "バイナリ" : `+${file.additions} −${file.deletions}`}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className={s.pill}
          style={{
            color: TONE_COLORS[pill.tone].fg,
            background: TONE_COLORS[pill.tone].bg,
          }}
        >
          {pill.label}
        </span>
        <span className={s.path} title={shown(path)}>
          <BidiText text={path} />
        </span>
        {file.binary ? (
          <span className={s.binary}>バイナリ</span>
        ) : (
          <>
            <span className={`${s.count} ${s.add}`}>
              +{file.additions.toLocaleString()}
            </span>
            <span className={`${s.count} ${s.del}`}>
              −{file.deletions.toLocaleString()}
            </span>
          </>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </button>
      {open && (
        <FileBody
          file={file}
          path={path}
          patch={body.data?.patch ?? null}
          loading={body.isPending}
          error={body.error}
        />
      )}
    </li>
  );
}

function FileBody({
  file,
  path,
  patch,
  loading,
  error,
}: {
  file: PrDiffFileSummary;
  path: string;
  patch: string | null;
  loading: boolean;
  error: Error | null;
}) {
  if (file.omitted === "binary")
    return <p className={s.omitted}>バイナリのため表示しません</p>;
  if (file.omitted === "too_large")
    return (
      <p className={s.omitted}>
        大きいため省略しました。GitHub で確認してください
      </p>
    );
  if (error)
    return (
      <p className={s.omitted}>
        差分を読み込めませんでした：{errorMessage(error)}
      </p>
    );
  if (loading) return <p className={s.omitted}>読み込み中…</p>;
  const rows = diffRows(patch ?? "");
  const bidi = hasBidi(path) || hasBidi(patch ?? "");
  if (rows.length === 0)
    return <p className={s.omitted}>内容の変更はありません</p>;
  return (
    <>
      {bidi && (
        <p className={s.stale} role="note">
          <Icon name="triangle-alert" size={13} />
          <span>
            双方向の制御文字を含みます（⟪U+…⟫
            の箇所）。見た目と実際のコードの並びが異なる恐れがあります
          </span>
        </p>
      )}
      <div
        className={s.diff}
        role="table"
        aria-label={`${shown(file.path)} の差分`}
      >
        {rows.map((r, i) =>
          r.kind === "hunk" || r.kind === "note" ? (
            <div key={i} className={s.hunk} role="row">
              <span role="cell">
                <BidiText text={r.text} />
              </span>
            </div>
          ) : (
            <div
              key={i}
              className={`${s.line} ${r.kind === "add" ? s.lineAdd : r.kind === "del" ? s.lineDel : ""}`}
              role="row"
              data-kind={r.kind}
            >
              <span className={s.lineNo} role="cell">
                {r.oldNo ?? ""}
              </span>
              <span className={s.lineNo} role="cell">
                {r.newNo ?? ""}
              </span>
              <span className={s.code} role="cell">
                {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
                <BidiText text={r.text} />
              </span>
            </div>
          ),
        )}
      </div>
    </>
  );
}
