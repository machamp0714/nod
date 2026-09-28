import { useId } from "react";
import { errorMessage } from "../../api/errors";
import { useUpdateProject } from "../../api/hooks/projects";
import type { Project, ProjectStatus } from "../../api/types";
import s from "./project-status-control.module.css";

export function ProjectStatusControl({ project }: { project: Project }) {
  const id = useId();
  const update = useUpdateProject(project.id);
  return (
    <div className={s.control}>
      <label htmlFor={id}>Project のステータス</label>
      <select
        id={id}
        value={project.status}
        disabled={update.isPending}
        onChange={(event) => {
          const status = event.target.value as ProjectStatus;
          if (status !== project.status && !update.isPending) update.mutate({ status });
        }}
      >
        <option value="planned">Planned</option>
        <option value="started">Started</option>
        <option value="completed">Completed</option>
        <option value="canceled">Canceled</option>
      </select>
      {update.isPending && <span role="status">保存中…</span>}
      {update.error && <span role="alert" className={s.error}>{errorMessage(update.error)}</span>}
    </div>
  );
}
