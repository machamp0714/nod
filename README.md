# nod

LLM（Claude Code、Codex）が作業し、人が判断するための個人用 Issue 管理ツール。
LLM は CLI（`nod`）で Issue を起票し、着手し、確認を依頼し、完了を報告する。
人は Web UI で、確認依頼への回答、レビュー、Triage を行う。
用語と UI は Linear に合わせ、データは SQLite に保存する。

もとは [beads](https://github.com/steveyegge/beads)（`bd`）のタスクを見るための UI（beads-ui）として始めたが、要件が増えたため独自のデータモデルに切り替えた。
