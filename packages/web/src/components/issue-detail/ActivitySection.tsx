import type { ActivityItem } from "../../api/types";
import { ActivityLines, Button } from "../ui";
import s from "./issue-detail.module.css";

export function ActivitySection({ activity }: { activity: ActivityItem[] }) {
  return (
    <section className={s.section} aria-label="Activity">
      <h2 className={s.sectionTitle}>Activity</h2>
      {activity.length === 0 ? <p className={s.muted}>Activity はありません</p> : <ActivityLines items={activity} />}
      <div className={s.commentBox}>
        <textarea className={s.commentInput} aria-label="コメント" placeholder="コメントを書く…" />
        <div className={s.commentActions}>
          <Button variant="primary" disabled title="準備中">
            コメントする
          </Button>
        </div>
      </div>
    </section>
  );
}
