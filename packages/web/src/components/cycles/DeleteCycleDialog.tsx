import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage } from "../../api/errors";
import { useDeleteCycle } from "../../api/hooks/cycles";
import type { CycleDetail } from "../../api/types";
import { DeleteDialog } from "../../pages/WorkspaceSettingsPage";

// Pencil「Cycles｜周期の設定・編集・削除（NOD-2）」の (e)。件数は canceled も含む所属の件数（アーカイブ以外）。
// 消した後の詳細は見つからないため、一覧へ移ってから読み直す
export function DeleteCycleDialog({ cycle, onClose }: { cycle: Pick<CycleDetail, "id" | "name" | "issues">; onClose: () => void }) {
  const remove = useDeleteCycle(cycle.id);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  return (
    <DeleteDialog
      title={`${cycle.name} を削除しますか？`}
      message={error ?? `所属する ${cycle.issues.length} 件は Cycle なしに戻ります。Issue 自体は消えません。この操作は元に戻せません。`}
      confirmLabel="削除"
      busy={remove.isPending}
      onClose={onClose}
      onConfirm={() =>
        remove.mutate(undefined, {
          onSuccess: () => void navigate({ to: "/cycles" }).then(remove.refresh),
          onError: (err) => setError(`削除できませんでした：${errorMessage(err)}`),
        })
      }
    />
  );
}
