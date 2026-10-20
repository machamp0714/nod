import { afterEach, expect, test } from "bun:test";
import { desktopInvoke } from "./desktop-notifications";
const originalWindow = globalThis.window;
afterEach(() => { Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }); });
test("ネイティブIPCの文字列rejectをErrorへ変換して原因を表示できる", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __NOD_DESKTOP__: true,
    __TAURI_INTERNALS__: { invoke: () => Promise.reject("Command notification_permission not allowed by ACL") },
  } });
  try { await desktopInvoke("notification_permission", { request: false }); throw new Error("rejectされませんでした"); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Command notification_permission not allowed by ACL");
  }
});
