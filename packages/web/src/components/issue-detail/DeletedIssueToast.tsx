import { useLocation, useRouter } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import s from "./issue-detail.module.css";

// 画面を移った先で1回だけ知らせる内容。URL には残さず、履歴の state で渡す
export interface DeletedIssueState {
  deletedIssue?: string; // 完全に削除した Issue の ID
}

// Issue を完全に削除して移ってきた一覧で出すトースト（Pencil「アーカイブ済み｜完全に削除」の Toast）。
// 履歴の state から読んで消すので、再読み込みや戻る操作ではもう出さない
export function DeletedIssueToast() {
  const router = useRouter();
  const location = useLocation();
  const deleted = (location.state as DeletedIssueState).deletedIssue;
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!deleted) return;
    setShown(deleted);
    const { deletedIssue: _d, ...rest } = location.state as DeletedIssueState;
    router.history.replace(location.href, rest);
  }, [deleted, location.href, location.state, router]);
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), 3000);
    return () => clearTimeout(timer);
  }, [shown]);
  if (!shown) return null;
  return <div role="status" className={s.deletedToast}><Trash2 size={14} aria-hidden="true" />{shown} を完全に削除しました</div>;
}
