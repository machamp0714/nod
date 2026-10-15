import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { desktopInvoke, isDesktopApp } from "../lib/desktop-notifications";
import { Button } from "../components/ui";
import s from "./workspace-settings.module.css";
interface Settings { enabled: boolean; lastEnabledAt: string | null }
const permissionText: Record<string, string> = { granted: "許可済み", denied: "許可されていません", notDetermined: "未要求" };
export function DesktopNotificationSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [permission, setPermission] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const desktop = isDesktopApp();
  async function refreshPermission() {
    try { setPermission(await desktopInvoke<string>("notification_permission", { request: false })); }
    catch { setPermission("error"); }
  }
  useEffect(() => {
    apiFetch<Settings>("/desktop-notifications/settings").then(setSettings).catch(() => setError("通知設定を読み込めませんでした"));
    if (!desktop) return;
    void refreshPermission();
    const refresh = () => { void refreshPermission(); };
    window.addEventListener("focus", refresh);
    // 許可要求の完了ハンドラとOS設定の反映時刻が一致しない場合も実状態へ追従する。
    const timer = setInterval(refresh, 2000);
    return () => { window.removeEventListener("focus", refresh); clearInterval(timer); };
  }, [desktop]);
  async function toggle() {
    if (!settings || busy) return;
    setBusy(true); setError(undefined);
    try {
      const saved = await apiFetch<Settings>("/desktop-notifications/settings", { method: "POST", body: { enabled: !settings.enabled } });
      setSettings(saved);
      if (saved.enabled) setPermission(await desktopInvoke<string>("notification_permission", { request: true }));
    } catch (e) { setError(e instanceof Error ? e.message : "通知設定を保存できませんでした"); }
    finally { setBusy(false); }
  }
  return <section className={s.section} aria-label="デスクトップ通知">
    <h2>デスクトップ通知</h2>
    <p>この Mac 全体に適用します。すべての Workspace の個別リマインダーと期日到来を通知します。</p>
    <p>アプリ設定：{settings ? settings.enabled ? "ON" : "OFF" : "読み込み中"}</p>
    <p>OS の通知許可：{desktop ? permissionText[permission ?? ""] ?? (permission === "error" ? "取得できません" : "確認中") : "デスクトップアプリで確認できます"}</p>
    {permission === "denied" && <p>macOS の「システム設定 → 通知 → nod」で通知を許可してください。Inbox は引き続き利用できます。</p>}
    {!desktop && <p>通知の有効化・許可要求は、この Mac の nod デスクトップアプリで行ってください。</p>}
    <Button disabled={!desktop || !settings || busy} onClick={() => void toggle()}>{settings?.enabled ? "通知を OFF にする" : "通知を ON にする"}</Button>
    {desktop && <Button disabled={busy} onClick={() => void refreshPermission()}>OS 許可を再確認</Button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
