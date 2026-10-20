// 通常ブラウザではネイティブIPCを呼ばない。アプリ側も現sidecarのoriginを検証する。
type DesktopWindow = Window & {
  __NOD_DESKTOP__?: boolean;
  __TAURI_INTERNALS__?: { invoke<T>(command: string, args: Record<string, unknown>): Promise<T> };
};
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && (window as DesktopWindow).__NOD_DESKTOP__ === true && !!(window as DesktopWindow).__TAURI_INTERNALS__;
}
export function desktopInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktopApp()) return Promise.reject(new Error("デスクトップアプリで操作してください"));
  return (window as DesktopWindow).__TAURI_INTERNALS__!.invoke<T>(command, args).catch((error: unknown) => {
    if (error instanceof Error) throw error;
    throw new Error(typeof error === "string" ? error : "ネイティブの通知操作に失敗しました");
  });
}
