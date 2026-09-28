import { Button } from "../ui";
import s from "./issue-detail.module.css";

export function DescriptionSection({ description }: { description: string | null }) {
  return (
    <section className={s.section} aria-label="説明">
      <header className={s.sectionHead}>
        <h2 className={s.sectionTitle}>説明</h2>
        <span className={s.spacer} />
        <Button icon="square-pen" disabled title="準備中">
          編集
        </Button>
      </header>
      {description ? <div className={s.description}>{description}</div> : <p className={s.muted}>説明はありません</p>}
    </section>
  );
}
