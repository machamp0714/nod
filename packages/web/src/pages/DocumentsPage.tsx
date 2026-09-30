import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useDocuments, useDocumentsRoot } from "../api/hooks/document";
import type { DocKind } from "../api/types";
import { Button, Icon, Menu, MenuItem, PageError, PageHeader, PageTitle, Pill, Spacer } from "../components/ui";
import { displayPath, documentDate, KIND_LABELS, KIND_TONES } from "../lib/document";
import s from "./documents.module.css";

const route = getRouteApi("/documents");
const KINDS = Object.keys(KIND_LABELS) as DocKind[];

// nod.pen の「Documents｜一覧」。Filter は種類だけを絞り込み、URL の ?kind= に残す
function KindFilter({ kind, onChange }: { kind?: DocKind; onChange: (kind?: DocKind) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (value?: DocKind) => {
    onChange(value);
    setOpen(false);
  };
  return (
    <div className={s.filterWrap} ref={root}>
      <Button
        icon="list-filter"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        {kind ? `種類: ${KIND_LABELS[kind]}` : "Filter"}
      </Button>
      {open && (
        <Menu label="種類で絞り込む" className={s.menu} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <MenuItem checked={!kind} onClick={() => choose(undefined)}>
            すべて
          </MenuItem>
          {KINDS.map((k) => (
            <MenuItem key={k} checked={kind === k} onClick={() => choose(k)}>
              {KIND_LABELS[k]}
            </MenuItem>
          ))}
        </Menu>
      )}
    </div>
  );
}

export function DocumentsPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/documents" });
  const documents = useDocuments();
  const root = useDocumentsRoot();
  const items = documents.data?.filter((d) => !search.kind || d.kind === search.kind);
  return (
    <div className={s.page}>
      <PageHeader>
        <PageTitle>Documents</PageTitle>
        {items && <span className={s.count}>{items.length}</span>}
        <Spacer />
        <KindFilter kind={search.kind} onChange={(kind) => navigate({ search: kind ? { kind } : {}, replace: true })} />
        <Button variant="primary" icon="plus" onClick={() => navigate({ to: "/documents/new" })}>
          新規ドキュメント
        </Button>
      </PageHeader>
      {documents.error ? (
        <PageError message={errorMessage(documents.error)} />
      ) : (
        <table className={s.table}>
          <colgroup>
            <col />
            <col className={s.colKind} />
            <col className={s.colIssues} />
            <col className={s.colCreated} />
          </colgroup>
          <thead>
            <tr>
              <th>タイトル</th>
              <th>種類</th>
              <th>リンク先 Issue</th>
              <th>作成日</th>
            </tr>
          </thead>
          <tbody>
            {items === undefined ? (
              <tr>
                <td colSpan={4} className={s.muted}>
                  <span role="status">読み込み中…</span>
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={4} className={s.muted}>
                  Document はありません
                </td>
              </tr>
            ) : (
              items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className={s.name}>
                      <span className={s.iconBox}>
                        <Icon name={d.kind === "plan" ? "list-checks" : "file-text"} size={13} />
                      </span>
                      <Link to="/documents/$documentId" params={{ documentId: String(d.id) }} className={s.nameLink}>
                        {d.title}
                      </Link>
                      <span className={s.path} title={d.path}>
                        {displayPath(d.path, root.data?.docsDir)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <Pill tone={KIND_TONES[d.kind]}>{KIND_LABELS[d.kind]}</Pill>
                  </td>
                  <td>
                    {d.issues.length ? (
                      <span className={s.chips}>
                        {d.issues.map((id) => (
                          <Link key={id} to="/issues/$issueId" params={{ issueId: id }} className={s.chip}>
                            {id}
                          </Link>
                        ))}
                      </span>
                    ) : (
                      <span className={s.muted}>—</span>
                    )}
                  </td>
                  <td className={s.date}>{documentDate(d.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
