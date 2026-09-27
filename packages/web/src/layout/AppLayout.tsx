import { Outlet } from "@tanstack/react-router";
import s from "./layout.module.css";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}
