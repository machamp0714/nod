import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { connectServerEvents } from "./events";

// SSE を購読し、ready と change ですべてのクエリを無効にする。AppLayout で1回だけ呼ぶ。
// 接続の状態を <html data-server-events> に出す（e2e が、変更の通知を受けられる状態になるのを待つため）
export function useServerEvents(): void {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      connectServerEvents({
        open: () => new EventSource("/api/events"),
        onInvalidate: () => void queryClient.invalidateQueries(),
        onStateChange: (state) => {
          document.documentElement.dataset.serverEvents = state;
        },
      }),
    [queryClient],
  );
}
