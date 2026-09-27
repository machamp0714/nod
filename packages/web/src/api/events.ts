// GET /api/events の購読。server は接続の直後に ready を、nod など外部の書き込みを検知するたびに change を送る。
// どちらを受け取ってもクエリを無効にする（ready は、切れていた間の変更を取りこぼさないため）。
export type ConnectionState = "connecting" | "ready";

export interface EventSourceLike {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

export function connectServerEvents(opts: {
  open: () => EventSourceLike;
  onInvalidate: () => void;
  onStateChange?: (state: ConnectionState) => void;
}): () => void {
  const source = opts.open();
  opts.onStateChange?.("connecting");
  source.addEventListener("ready", () => {
    opts.onStateChange?.("ready");
    opts.onInvalidate();
  });
  source.addEventListener("change", () => opts.onInvalidate());
  // EventSource は切れると自分で再接続し、つながると server がまた ready を送る
  source.addEventListener("error", () => opts.onStateChange?.("connecting"));
  return () => source.close();
}
