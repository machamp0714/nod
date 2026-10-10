import { createJevClient, JEV_QUESTION, JEV_MODEL } from "../../packages/core/src/ops/jev-client";

// 通常テストとは分離し、明示実行時だけ実際のAPIを呼ぶ。
const cases = await Bun.file(new URL("cases.json", import.meta.url)).json();
const candidates = [
  { version: "question-only", question: { type: "noul" as const, instructions: JEV_QUESTION.instructions } },
  { version: "needs-spec-v1", question: JEV_QUESTION },
];
const rows = [];
for (const candidate of candidates) {
  const client = createJevClient({ question: candidate.question });
  for (const example of cases) {
    const result = await client(example.body);
    rows.push({ id: example.id, split: example.split, expected: example.expected, candidate: candidate.version, ...result });
    console.log(example.id, candidate.version, result.kind, result.kind === "success" ? result.probability : result.failureKind);
  }
}
const summary = candidates.flatMap(candidate => [0.3, 0.5, 0.7].flatMap(threshold => ["tuning", "confirmation"].map(split => {
  const selected = rows.filter(row => row.candidate === candidate.version && row.split === split);
  return { candidate: candidate.version, threshold, split, count: selected.length,
    misses: selected.filter(row => row.kind === "success" && row.expected === true && row.probability < threshold).length,
    excess: selected.filter(row => row.kind === "success" && row.expected === false && row.probability >= threshold).length,
    failures: selected.filter(row => row.kind !== "success").length,
  };
})));
const output = { measuredAt: new Date().toISOString(), model: JEV_MODEL, priceUsdPerMillionInputTokens: 0.042, rows, summary };
await Bun.write(new URL("results.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(summary));
