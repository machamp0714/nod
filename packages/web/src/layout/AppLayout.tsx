import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useReminderExpiry } from "../api/hooks/notifications";
import { useServerEvents } from "../api/useServerEvents";
import { IssueSearchDialog } from "../components/search/IssueSearchDialog";
import { isIssueSearchShortcut } from "../lib/issue-search";
import s from "./layout.module.css";
import { Sidebar } from "./Sidebar";

// SSE の購読は画面ごとのデータではないため、A の「src/layout/ は props だけでデータを受け取る」の対象外とし、ここで1回だけ行う
export function AppLayout() {
  useServerEvents();
  // リマインダーの期限（#47）も画面によらないため、同じ理由でここで1回だけ見る
  useReminderExpiry();
  // Issue 検索（Shift + Cmd + F）もどの画面からでも開くため、ここで受ける。ブラウザの同じキーの動作は止める
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !isIssueSearchShortcut(event)) return;
      event.preventDefault();
      setSearching(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div className={s.shell}>
      <Sidebar onOpenSearch={() => setSearching(true)} />
      <main className={s.main}>
        <Outlet />
      </main>
      {searching && <IssueSearchDialog onClose={() => setSearching(false)} />}
    </div>
  );
}
