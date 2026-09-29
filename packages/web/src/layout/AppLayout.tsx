import { Outlet } from "@tanstack/react-router";
import { useReminderExpiry } from "../api/hooks/notifications";
import { useServerEvents } from "../api/useServerEvents";
import s from "./layout.module.css";
import { Sidebar } from "./Sidebar";

// SSE の購読は画面ごとのデータではないため、A の「src/layout/ は props だけでデータを受け取る」の対象外とし、ここで1回だけ行う
export function AppLayout() {
  useServerEvents();
  // リマインダーの期限（#47）も画面によらないため、同じ理由でここで1回だけ見る
  useReminderExpiry();
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}
