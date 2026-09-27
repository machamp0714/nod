import type { Database } from "bun:sqlite";

export const POLL_INTERVAL_MS = 1000;

export interface ChangeFeed {
  readonly version: number;
  readonly listenerCount: number;
  check(): boolean;
  subscribe(listener: (version: number) => void): () => void;
}

// PRAGMA data_version は、同じ接続での書き込みでは変わらず、ほかの接続（nod の実行など）のコミットで変わる。
// ルートが書き込むのと同じ db を渡すことで、外部の書き込みだけを知らせる
export function createChangeFeed(db: Database): ChangeFeed {
  const read = () => (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  let version = read();
  const listeners = new Set<(version: number) => void>();
  return {
    get version() {
      return version;
    },
    get listenerCount() {
      return listeners.size;
    },
    check() {
      const current = read();
      if (current === version) return false;
      version = current;
      for (const listener of [...listeners]) {
        try {
          listener(current);
        } catch (e) {
          console.error(e);
        }
      }
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
