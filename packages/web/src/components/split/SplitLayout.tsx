import type { ReactNode } from "react";
import { PageHeader, PageTitle, Spacer } from "../ui";
import s from "./split.module.css";

// Inbox、Reviews、Triage の2列（一覧と詳細）。一覧の見出しをページの <h1> にする。
// 一覧の Header（高さ 44）は、題名、説明文、件数、タブ（headerTabs）の順に並べる。headerExtra は Header と行の間に置く
export function SplitLayout({
  title,
  description,
  headerTabs,
  headerExtra,
  count,
  listLabel,
  list,
  detail,
}: {
  title: string;
  description?: string;
  headerTabs?: ReactNode;
  headerExtra?: ReactNode;
  count: number;
  listLabel: string;
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className={s.split}>
      <section className={s.list} aria-label={listLabel}>
        <PageHeader>
          <PageTitle>{title}</PageTitle>
          {description && <span className={s.description} title={description}>{description}</span>}
          <Spacer />
          <span className={s.listCount}>{count}</span>
          {headerTabs && <div className={s.headerTabs}>{headerTabs}</div>}
        </PageHeader>
        {headerExtra}
        <div className={s.items}>{list}</div>
      </section>
      <section className={s.detail} aria-label="詳細">
        {detail}
      </section>
    </div>
  );
}
