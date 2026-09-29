import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { usePrDiff, useRefreshPrDiff } from "../../api/hooks/pr-diff";
import type { PrDiffFile } from "../../api/types";
import { formatRelative } from "../../lib/format";
import { TONE_COLORS } from "../../lib/meta";
import { diffRows, fileStatusPill, githubFilesUrl, shortSha } from "../../lib/pr-diff";
import { Icon } from "../ui";
import s from "./pr-diff.module.css";

// 一覧で最初に出すファイル数。残りは「他 N ファイルを表示」で出す
const INITIAL_FILES = 5;

// PR の変更ファイルと差分（#55）。nod.pen「Issue詳細｜変更ファイル」「Reviews｜変更ファイル」「変更ファイル｜状態」に合わせる。
// 保存済みの結果を表示し、gh の実行は「更新」ボタンでだけ行う。差分・パスはテキストノードとしてだけ描画する（HTML にしない）
export function PrDiffSection({ issueId, prUrl, collapsible = false }: { issueId: string; prUrl: string; collapsible?: boolean }) {
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
  if (!summary) note = busy ? "取得中…" : !fetchError && !requestError && !query.isPending ? "未取得。更新で gh から取得します" : null;

  return (
    <section className={collapsible ? `${s.section} ${s.boxed}` : s.section} aria-label="変更ファイル" aria-busy={busy}>
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
            <span className={`${s.mono} ${s.add}`}>+{summary.additions.toLocaleString()}</span>
            <span className={`${s.mono} ${s.del}`}>−{summary.deletions.toLocaleString()}</span>
            <span className={s.sep}>·</span>
            <span className={s.mono}>HEAD {shortSha(diff ? diff.headSha : stale!.diffHeadSha)}</span>
            <span className={s.sep}>·</span>
            <span className={s.note} title={busy ? undefined : summary.fetchedAt}>
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
          <a className={s.link} href={filesUrl} target="_blank" rel="noreferrer">
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
                PR が更新されています（HEAD {shortSha(stale.diffHeadSha)} → {shortSha(stale.currentHeadSha)}）。差分を更新してください
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
                <a className={s.link} href={filesUrl} target="_blank" rel="noreferrer">
                  GitHub で開く ↗
                </a>
              )}
            </div>
          )}
          {diff && diff.files.length > 0 && <FileList files={diff.files} />}
          {diff && diff.files.length === 0 && <p className={s.note}>変更ファイルはありません</p>}
        </>
      )}
    </section>
  );
}

function FileList({ files }: { files: PrDiffFile[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? files : files.slice(0, INITIAL_FILES);
  return (
    <ul className={s.files} aria-label="変更ファイルの一覧">
      {shown.map((f, i) => (
        <FileRow key={`${i}-${f.path}`} file={f} />
      ))}
      {!showAll && files.length > INITIAL_FILES && (
        <li className={s.more}>
          <button type="button" className={s.moreButton} onClick={() => setShowAll(true)}>
            他 {files.length - INITIAL_FILES} ファイルを表示
          </button>
        </li>
      )}
    </ul>
  );
}

function FileRow({ file }: { file: PrDiffFile }) {
  const [open, setOpen] = useState(false);
  const pill = fileStatusPill(file);
  const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <li className={s.file}>
      <button
        type="button"
        className={open ? `${s.fileRow} ${s.fileRowOpen}` : s.fileRow}
        aria-label={`${pill.label} ${path} ${file.binary ? "バイナリ" : `+${file.additions} −${file.deletions}`}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={s.pill} style={{ color: TONE_COLORS[pill.tone].fg, background: TONE_COLORS[pill.tone].bg }}>
          {pill.label}
        </span>
        <span className={s.path} title={path}>
          {path}
        </span>
        {file.binary ? (
          <span className={s.binary}>バイナリ</span>
        ) : (
          <>
            <span className={`${s.count} ${s.add}`}>+{file.additions.toLocaleString()}</span>
            <span className={`${s.count} ${s.del}`}>−{file.deletions.toLocaleString()}</span>
          </>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
      </button>
      {open && <FileBody file={file} />}
    </li>
  );
}

function FileBody({ file }: { file: PrDiffFile }) {
  if (file.omitted === "binary") return <p className={s.omitted}>バイナリのため表示しません</p>;
  if (file.omitted === "too_large") return <p className={s.omitted}>大きいため省略しました。GitHub で確認してください</p>;
  const rows = diffRows(file.patch ?? "");
  if (rows.length === 0) return <p className={s.omitted}>内容の変更はありません</p>;
  return (
    <div className={s.diff} role="table" aria-label={`${file.path} の差分`}>
      {rows.map((r, i) =>
        r.kind === "hunk" || r.kind === "note" ? (
          <div key={i} className={s.hunk} role="row">
            <span role="cell">{r.text}</span>
          </div>
        ) : (
          <div key={i} className={`${s.line} ${r.kind === "add" ? s.lineAdd : r.kind === "del" ? s.lineDel : ""}`} role="row" data-kind={r.kind}>
            <span className={s.lineNo} role="cell">
              {r.oldNo ?? ""}
            </span>
            <span className={s.lineNo} role="cell">
              {r.newNo ?? ""}
            </span>
            <span className={s.code} role="cell">
              {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
              {r.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
