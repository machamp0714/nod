import type { ReactNode } from "react";
import s from "./ui.module.css";

// 各画面の Header（高さ 44）。パンくずだけの画面は as="nav" と label で <nav> にする
export function PageHeader({ as: Tag = "header", label, className, children }: { as?: "header" | "nav"; label?: string; className?: string; children: ReactNode }) {
  return (
    <Tag aria-label={label} className={`${s.pageHeader} ${className ?? ""}`}>
      {children}
    </Tag>
  );
}

// Header の中の画面名。ページの <h1> にする
export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className={s.pageTitle}>{children}</h1>;
}

// Header の下のタブとアイコンボタンの行（高さ 43）。左右を分けるときは間に <Spacer /> を置く
export function ViewBar({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`${s.viewBar} ${className ?? ""}`}>{children}</div>;
}

export function Spacer() {
  return <span className={s.spacer} />;
}
