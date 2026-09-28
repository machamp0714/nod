import { Link } from "@tanstack/react-router";
import s from "./issue-list.module.css";

export function BlockedBy({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return <div className={s.blockedBy}>
    <span>ブロック元:</span>
    {ids.map(id => <Link key={id} to="/issues/$issueId" params={{ issueId: id }}>{id}</Link>)}
  </div>;
}
