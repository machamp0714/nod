import type { ReactNode } from "react";
import { axisDate, type StatsBy } from "../../lib/analytics";
import s from "../../pages/analytics.module.css";
import { Spacer } from "../ui";
import type { Slot } from "./charts";

export function slotsOf(buckets: { start: string; end: string }[], by: StatsBy): Slot[] {
  return buckets.map((b) => ({ start: b.start, label: by === "day" ? axisDate(b.start) : `${axisDate(b.start)} 週` }));
}

export function Card({ title, legend, children }: { title: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.card} aria-label={title}>
      <div className={s.cardHeader}>
        <h2 className={s.cardTitle}>{title}</h2>
        <Spacer />
        {legend}
      </div>
      {children}
    </section>
  );
}
