import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useLegacyCycle } from "../api/hooks/sprints";
import { errorMessage } from "../api/errors";
import { Button, PageError, PageLoading } from "../components/ui";
import { NotFoundMessage } from "./NotFoundPage";

const route = getRouteApi("/cycles/$cycleId");

export function CycleDetailPage() {
  const { cycleId } = route.useParams();
  const search = route.useSearch();
  const legacy = useLegacyCycle(cycleId);
  const navigate = useNavigate();
  useEffect(() => {
    if (legacy.data?.kind === "imported") void navigate({ to: "/sprints/$sprintId", params: { sprintId: legacy.data.sprintId }, search, replace: true });
  }, [legacy.data, navigate, search]);
  if (legacy.error) return <><PageError message={errorMessage(legacy.error)} /><Button onClick={() => void legacy.refetch()}>再試行</Button></>;
  if (!legacy.data || legacy.data.kind === "imported") return <PageLoading />;
  return <NotFoundMessage title={legacy.data.kind === "deleted" ? "削除済みの旧Cycleです" : "旧Cycleが見つかりません"} />;
}
