import type { ReactNode } from "react";
import { useAllWorkspaceLabels } from "../../api/hooks/workspace-labels";
import { labelColor } from "../../lib/workspace-labels";
import s from "./ui.module.css";

// Issue のラベルのチップ（#117）。Dot だけを Workspace で定義した色にし、未定義のラベルは既定の灰色（--ink3）
export function LabelDot({ workspace, name }: { workspace: string | null | undefined; name: string }) {
  const labels = useAllWorkspaceLabels();
  const color = labelColor(labels.data, workspace, name);
  return <span className={s.labelDot} style={color ? { background: color } : undefined} data-label-color={color ?? "default"} aria-hidden="true" />;
}

export function LabelChip({ workspace, name, className, children }: { workspace: string | null | undefined; name: string; className?: string; children?: ReactNode }) {
  return (
    <span className={[s.labelChip, className].filter(Boolean).join(" ")} data-label={name}>
      <LabelDot workspace={workspace} name={name} />
      <span className={s.labelText}>{name}</span>
      {children}
    </span>
  );
}
