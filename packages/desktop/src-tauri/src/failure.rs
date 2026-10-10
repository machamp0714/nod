// 起動の失敗を、画面に出す分類・要約へ変える。環境変数・トークン・本文は扱わない
// （LaunchError の文字列は画面に出さず、分類ごとの固定文だけを使う）。
use crate::launch::LaunchError;
use crate::log::Stage;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    EnvFailed,
    EnvTimeout,
    NoHome,
    SpawnFailed,
    EarlyExit,
    PortReused,
    StartupTimeout,
    SchemaTooNew,
    Internal,
}

impl FailureKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EnvFailed => "env_failed",
            Self::EnvTimeout => "env_timeout",
            Self::NoHome => "no_home",
            Self::SpawnFailed => "spawn_failed",
            Self::EarlyExit => "early_exit",
            Self::PortReused => "port_reused",
            Self::StartupTimeout => "startup_timeout",
            Self::SchemaTooNew => "schema_too_new",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub stage: Stage,
    pub kind: FailureKind,
    /// 原因の要約（1 文）。
    pub summary: String,
    /// 次に試すこと。
    pub hint: String,
    /// 終了コード（sidecar が終了した場合）。
    pub exit_code: Option<i32>,
}

impl Failure {
    pub fn is_schema_too_new(&self) -> bool {
        self.kind == FailureKind::SchemaTooNew
    }
}

fn failure(stage: Stage, kind: FailureKind, summary: &str, hint: &str) -> Failure {
    Failure { stage, kind, summary: summary.into(), hint: hint.into(), exit_code: None }
}

pub fn classify(e: &LaunchError) -> Failure {
    match e {
        LaunchError::EnvFailed(_) => failure(
            Stage::Environment,
            FailureKind::EnvFailed,
            "ログインシェルから環境を取得できませんでした。",
            "SHELL の指す実行ファイルと、シェルの設定ファイル（.zshrc など）を確認してください。",
        ),
        LaunchError::EnvTimeout => failure(
            Stage::Environment,
            FailureKind::EnvTimeout,
            "環境の取得が 5 秒以内に終わりませんでした。",
            "シェルの設定ファイルに時間のかかる処理や、入力待ちがないか確認してください。",
        ),
        LaunchError::NoHome => failure(
            Stage::Environment,
            FailureKind::NoHome,
            "ホームディレクトリを決められませんでした。",
            "ユーザーの環境（HOME）を確認してください。",
        ),
        LaunchError::SpawnFailed(_) => failure(
            Stage::Spawn,
            FailureKind::SpawnFailed,
            "nod の本体（sidecar）を起動できませんでした。",
            "nod.app が壊れている可能性があります。.app を入れ直してください。",
        ),
        LaunchError::EarlyExit(code) => Failure {
            exit_code: *code,
            ..failure(
                Stage::Startup,
                FailureKind::EarlyExit,
                "起動の完了前に nod の本体が終了しました。",
                "ログを開いて原因を確認してから、再試行してください。",
            )
        },
        LaunchError::PortReused => failure(
            Stage::Startup,
            FailureKind::PortReused,
            "別の nod ui がポートを使っているため、起動できませんでした。",
            "手動で起動している nod ui を止めてから、再試行してください。",
        ),
        LaunchError::StartupTimeout { .. } => failure(
            Stage::Startup,
            FailureKind::StartupTimeout,
            "起動の完了が 15 秒以内に確認できませんでした。",
            "ログを開いて確認し、再試行してください。",
        ),
        LaunchError::SchemaTooNew => failure(
            Stage::Startup,
            FailureKind::SchemaTooNew,
            "データベースの版がこの nod より新しいため、開けません。",
            ".app を更新してください（新しい版の nod.app に入れ替えます）。",
        ),
        LaunchError::Cancelled => {
            failure(Stage::Startup, FailureKind::Internal, "起動は取り消されました。", "再試行してください。")
        }
    }
}

/// アプリ自身の初期化の失敗（設定の解決など）。
pub fn internal(stage: Stage) -> Failure {
    failure(
        stage,
        FailureKind::Internal,
        "アプリの初期化に失敗しました。",
        "アプリを終了してから、もう一度起動してください。",
    )
}

/// 失敗画面（静的 HTML）へ渡すクエリ。固定文と分類だけを含む。
pub fn page_query(f: &Failure) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("stage", f.stage.label_ja())
        .append_pair("kind", f.kind.as_str())
        .append_pair("summary", &f.summary)
        .append_pair("hint", &f.hint)
        .append_pair("update", if f.is_schema_too_new() { "1" } else { "0" })
        .finish()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Starting,
    Running,
    Failed,
}

impl RunState {
    fn label(&self) -> &'static str {
        match self {
            Self::Starting => "起動中",
            Self::Running => "稼働中",
            Self::Failed => "失敗",
        }
    }
}

pub struct DiagInput<'a> {
    pub app_version: &'a str,
    pub commit: &'a str,
    pub launch_id: &'a str,
    pub state: RunState,
    pub failure: Option<&'a Failure>,
    pub sidecar_pid: Option<u32>,
    pub port: Option<u16>,
    pub os: &'a str,
    pub arch: &'a str,
    pub log_dir: &'a str,
}

/// クリップボードへ入れる診断情報。環境変数の一覧・秘密・本文は含まない。
pub fn diagnostics(d: &DiagInput) -> String {
    let mut s = String::from("nod 診断情報\n");
    s += &format!("アプリ版: {}（commit {}）\n", d.app_version, d.commit);
    s += &format!("起動単位: {}\n", d.launch_id);
    s += &format!("状態: {}\n", d.state.label());
    if let Some(f) = d.failure {
        s += &format!("失敗した段階: {}\n", f.stage.label_ja());
        s += &format!("原因の分類: {}\n", f.kind.as_str());
        s += &format!("原因: {}\n", f.summary);
        if let Some(c) = f.exit_code {
            s += &format!("sidecar の終了コード: {c}\n");
        }
    }
    if let Some(p) = d.sidecar_pid {
        s += &format!("sidecar の PID: {p}\n");
    }
    if let Some(p) = d.port {
        s += &format!("ポート: {p}\n");
    }
    s += &format!("OS: {}（{}）\n", d.os, d.arch);
    s += &format!("ログの場所: {}\n", d.log_dir);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_each_launch_error_with_stage() {
        let cases = [
            (LaunchError::EnvFailed("/nonexistent: x TOKEN=abc".into()), Stage::Environment, FailureKind::EnvFailed),
            (LaunchError::EnvTimeout, Stage::Environment, FailureKind::EnvTimeout),
            (LaunchError::NoHome, Stage::Environment, FailureKind::NoHome),
            (LaunchError::SpawnFailed("p".into()), Stage::Spawn, FailureKind::SpawnFailed),
            (LaunchError::EarlyExit(Some(1)), Stage::Startup, FailureKind::EarlyExit),
            (LaunchError::PortReused, Stage::Startup, FailureKind::PortReused),
            (LaunchError::StartupTimeout { url_seen: true }, Stage::Startup, FailureKind::StartupTimeout),
            (LaunchError::SchemaTooNew, Stage::Startup, FailureKind::SchemaTooNew),
        ];
        for (e, stage, kind) in cases {
            let f = classify(&e);
            assert_eq!((f.stage, f.kind), (stage, kind), "{e:?}");
            assert!(!f.summary.is_empty() && !f.hint.is_empty());
        }
    }

    #[test]
    fn summary_never_carries_the_raw_error_text() {
        let f = classify(&LaunchError::EnvFailed("GITHUB_TOKEN=ghp_secret".into()));
        let q = page_query(&f);
        assert!(!f.summary.contains("ghp_secret") && !f.hint.contains("ghp_secret"));
        assert!(!q.contains("ghp_secret") && !q.contains("TOKEN"));
    }

    #[test]
    fn schema_too_new_points_to_app_update() {
        let f = classify(&LaunchError::SchemaTooNew);
        assert!(f.is_schema_too_new());
        assert!(f.hint.contains(".app を更新"));
        assert!(page_query(&f).contains("update=1"));
        assert!(page_query(&classify(&LaunchError::EnvTimeout)).contains("update=0"));
    }

    #[test]
    fn early_exit_keeps_exit_code() {
        assert_eq!(classify(&LaunchError::EarlyExit(Some(3))).exit_code, Some(3));
        assert_eq!(classify(&LaunchError::EarlyExit(None)).exit_code, None);
    }

    #[test]
    fn diagnostics_lists_facts_and_no_env_like_pairs() {
        let f = classify(&LaunchError::EarlyExit(Some(1)));
        let text = diagnostics(&DiagInput {
            app_version: "0.1.0",
            commit: "abc1234",
            launch_id: "l1",
            state: RunState::Failed,
            failure: Some(&f),
            sidecar_pid: Some(77),
            port: Some(4701),
            os: "macOS 15.1",
            arch: "aarch64",
            log_dir: "/Users/u/Library/Logs/io.github.machamp0714.nod",
        });
        for want in [
            "アプリ版: 0.1.0（commit abc1234）",
            "起動単位: l1",
            "失敗した段階: 起動の完了待ち",
            "原因の分類: early_exit",
            "sidecar の終了コード: 1",
            "sidecar の PID: 77",
            "ポート: 4701",
            "OS: macOS 15.1（aarch64）",
            "ログの場所: /Users/u/Library/Logs/io.github.machamp0714.nod",
        ] {
            assert!(text.contains(want), "{want}\n{text}");
        }
        assert!(!text.contains('='), "環境変数らしい `=` を含む");
    }

    #[test]
    fn diagnostics_without_failure_still_works() {
        let text = diagnostics(&DiagInput {
            app_version: "不明",
            commit: "不明",
            launch_id: "-",
            state: RunState::Starting,
            failure: None,
            sidecar_pid: None,
            port: None,
            os: "macOS",
            arch: "aarch64",
            log_dir: "/l",
        });
        assert!(text.contains("状態: 起動中") && !text.contains("失敗した段階"));
    }
}
