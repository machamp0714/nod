import type { ReactNode } from "react";
import s from "./split.module.css";

// Inbox、Reviews、Triage の2列（一覧と詳細）。一覧の見出しをページの <h1> にする。
export function SplitLayout({
  title,
  description,
  headerExtra,
  count,
  listLabel,
  list,
  detail,
}: {
  title: string;
  description?: string;
  headerExtra?: ReactNode;
  count: number;
  listLabel: string;
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className={s.split}>
      <section className={s.list} aria-label={listLabel}>
        <header className={s.listHeader}>
          <h1 className={s.listTitle}>{title}</h1>
          <span className={s.listCount}>{count}</span>
        </header>
        {description && <p className={s.description}>{description}</p>}
        {headerExtra}
        {list}
      </section>
      <section className={s.detail} aria-label="詳細">
        {detail}
      </section>
    </div>
  );
}
