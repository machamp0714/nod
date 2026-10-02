import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useIssueList } from "../../api/hooks/issues";
import { errorMessage } from "../../api/errors";
import { matchIssueSearch } from "../../lib/issue-search";
import { Icon, StatusIcon } from "../ui";
import s from "./issue-search.module.css";

// 入力が止まってから API を呼ぶまでの待ち時間
const DEBOUNCE_MS = 200;

// どの画面からでも開く Issue 検索（Shift + Cmd + F、Sidebar の検索ボタン）。ID とタイトルで探し、選ぶと詳細を開く。
// 対象は全 Workspace・全ステータスの Issue で、アーカイブ済みは API の既定どおり除く。開いている間だけ描画する
export function IssueSearchDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const optionId = useId();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // 閉じたら、開く前にフォーカスがあった場所（Sidebar の検索ボタンなど）へ戻す。showModal で入力欄へ移る前の要素を、最初の描画で覚える
  const [before] = useState(() => document.activeElement);

  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  useEffect(() => {
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [before]);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const list = useIssueList({ q: query }, query !== "");
  const results = list.data ? matchIssueSearch(list.data.issues, query) : [];
  const current = Math.min(active, results.length - 1);

  function open(issueId: string) {
    onClose();
    void navigate({ to: "/issues/$issueId", params: { issueId } });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // 入力が問い合わせに届くまでは、前の語の結果に移らないよう何もしない
      if (query !== text.trim() || list.isFetching) return;
      const issue = results[current];
      if (issue) open(issue.id);
    }
  }

  let status: string | null = null;
  if (query !== text.trim() || (query !== "" && list.isPending)) status = "検索中…";
  else if (list.error) status = errorMessage(list.error);
  else if (query !== "" && results.length === 0) status = "一致する Issue はありません";

  return (
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label="Issue を検索"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // 背景（dialog 自身）を押したら閉じる
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={s.field}>
        <Icon name="search" color="var(--ink3)" />
        <input
          className={s.input}
          role="combobox"
          aria-label="Issue を検索"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? listId : undefined}
          aria-activedescendant={results.length > 0 ? `${optionId}-${current}` : undefined}
          aria-autocomplete="list"
          placeholder="ID・タイトルで検索"
          autoFocus
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {results.length > 0 && (
        <ul id={listId} role="listbox" aria-label="検索結果" className={s.list}>
          {results.map((issue, index) => (
            <li
              key={issue.id}
              id={`${optionId}-${index}`}
              role="option"
              aria-selected={index === current}
              className={s.option}
              onMouseMove={() => setActive(index)}
              onClick={() => open(issue.id)}
            >
              <StatusIcon status={issue.status} />
              <span className={s.id}>{issue.id}</span>
              <span className={s.title}>{issue.title}</span>
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p className={s.status} role="status">
          {status}
        </p>
      )}
    </dialog>
  );
}
