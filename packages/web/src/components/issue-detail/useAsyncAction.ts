import { useState } from "react";
import { errorMessage } from "../../api/errors";

// 部品が受け取った操作（Promise を返す関数）を実行し、操作中と失敗のメッセージを持つ
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, failure: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(`${failure}：${errorMessage(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run, clearError: () => setError(null) };
}
