## 目的

先週の動きをまとめ、人が次の週の判断をしやすくする。

## 手順

- [ ] `nod summary --since 7d --json` で先週の動き（完了・レビュー提出・差し戻し・ブロッカー・質問）を集める
- [ ] `nod issue diagnose --stale-days 7 --json` で停滞候補とブロッカーを確かめる
- [ ] まとめを `nod doc create reports/weekly-<YYYY-MM-DD>.md --title "週次レポート <YYYY-MM-DD>" --kind doc --issue <この Issue の id>` で Document にする

## 結果

- 完了したこと：
- 止まっていること・人に判断してほしいこと：
- 来週の候補：
