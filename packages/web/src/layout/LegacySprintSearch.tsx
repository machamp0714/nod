import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useLegacyCycle } from "../api/hooks/sprints";
import { errorMessage } from "../api/errors";
import { Button, PageError, PageLoading } from "../components/ui";

// 旧検索URLは条件を落とす前に専用対応で解決する。旧番号を新Sprint番号へ読み替えない。
export function LegacySprintSearch({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = location.search as Record<string, unknown>;
  const hasLegacy = raw.cycle !== undefined && raw.sprint === undefined;
  const ref = hasLegacy ? String(raw.cycle) : "";
  const relative = ref === "current" || ref === "none";
  const fixed = /^\d+$/.test(ref);
  const legacy = useLegacyCycle(ref, hasLegacy && !relative && fixed);
  const resolved = relative ? ref : !fixed ? `unresolved:cycle:${ref}` : legacy.data?.kind === "imported" ? legacy.data.sprintId : legacy.data ? `unresolved:cycle:${ref}` : null;
  useEffect(() => {
    if (!hasLegacy || resolved === null) return;
    void navigate({ to: location.pathname, search: (previous) => {
      const { cycle: _cycle, ...rest } = previous as Record<string, unknown>;
      return { ...rest, sprint: resolved };
    }, replace: true });
  }, [hasLegacy, resolved, location.pathname, navigate]);
  if (!hasLegacy) return children;
  if (legacy.error) return <><PageError message={errorMessage(legacy.error)} /><Button onClick={() => void legacy.refetch()}>再試行</Button></>;
  return <PageLoading />;
}
