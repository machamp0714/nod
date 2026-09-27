import { Link } from "@tanstack/react-router";
import s from "./not-found.module.css";

export function NotFoundMessage({ title }: { title: string }) {
  return (
    <div className={s.wrap}>
      <h1 className={s.title}>{title}</h1>
      <Link to="/inbox" className={s.link}>
        Inbox に戻る
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return <NotFoundMessage title="ページが見つかりません" />;
}
