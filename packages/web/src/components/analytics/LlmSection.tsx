import { useLlmStats } from "../../api/hooks/analytics";
import type { LlmStats } from "../../api/types";
import { agentInitial } from "../../lib/color";
import { llmColors } from "../../lib/analytics";
import { Card, slotsOf } from "./parts";
import s from "../../pages/analytics.module.css";
import { ErrorMessage, LoadingMessage } from "../ui";
import { Legend, StackedBars } from "./charts";

// LLM 別の操作回数。
export function LlmSection({ query }: { query: string }) {
  const stats = useLlmStats(query);
  return (
    <section className={s.llmSection} aria-label="LLM 別">
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>LLM 別</h2>
        <span className={s.sectionNote}>操作した書き手ごとの回数を集計</span>
      </div>
      {stats.error ? (
        <ErrorMessage error={stats.error} />
      ) : !stats.data ? (
        <LoadingMessage />
      ) : stats.data.llms.length === 0 ? (
        <div className={s.llmEmpty}>この期間に LLM の作業はありません</div>
      ) : (
        <LlmBody stats={stats.data} />
      )}
    </section>
  );
}

function LlmBody({ stats }: { stats: LlmStats }) {
  const colors = llmColors(stats.llms.map((l) => l.name));
  const unit = stats.by === "day" ? "日" : "週";
  const slots = slotsOf(stats.buckets, stats.by);
  return (
    <div className={s.row}>
      <div className={`${s.card} ${s.llmTable}`}>
        <table aria-label="LLM ごとの合計">
          <thead>
            <tr>
              <th>LLM</th>
              <th>完了数</th>
              <th>開始</th>
              <th>完了報告</th>
            </tr>
          </thead>
          <tbody>
            {stats.llms.map((l) => (
              <tr key={l.name}>
                <td>
                  <span className={s.llmName}>
                    <span className={s.llmAvatar} style={{ background: colors.get(l.name) }} aria-hidden="true">
                      {agentInitial(l.name)}
                    </span>
                    {l.name}
                  </span>
                </td>
                <td>{l.totals.completed}</td>
                <td>{l.totals.started}</td>
                <td>{l.totals.submitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Card
        title={`${unit}ごとの完了数（LLM 別）`}
        legend={<Legend items={stats.llms.map((l) => ({ key: l.name, color: colors.get(l.name)! }))} />}
      >
        <StackedBars
          label={`${unit}ごとの完了数（LLM 別）`}
          slots={slots}
          series={stats.buckets.map((_, n) =>
            stats.llms.map((l) => ({ key: l.name, value: l.buckets[n]!.completed, color: colors.get(l.name)! })),
          )}
          table={{
            head: [unit, ...stats.llms.map((l) => l.name)],
            rows: slots.map((slot, n) => [slot.label, ...stats.llms.map((l) => String(l.buckets[n]!.completed))]),
          }}
        />
      </Card>
    </div>
  );
}
