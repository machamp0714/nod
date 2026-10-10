// ログ。純粋なロガー（書き込み先ディレクトリとサイズ上限を引数に取る）と、秘密を書かないための整形。
// 環境変数の一覧・トークン・本文は渡さない設計だが、渡されても `NAME=値` と鍵らしい文字列は伏せる。
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

pub const LOG_FILE: &str = "nod.log";
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_FILES: usize = 5;
pub const LOG_DIR_ENV: &str = "NOD_DESKTOP_LOG_DIR";
const MAX_MESSAGE_CHARS: usize = 300;
const REDACTED: &str = "[省略]";

/// 処理段階。ログと失敗画面の「どこで失敗したか」に使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    App,
    Environment,
    Spawn,
    Startup,
    Running,
    Shutdown,
}

impl Stage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Environment => "environment",
            Self::Spawn => "spawn",
            Self::Startup => "startup",
            Self::Running => "running",
            Self::Shutdown => "shutdown",
        }
    }
    pub fn label_ja(&self) -> &'static str {
        match self {
            Self::App => "アプリの初期化",
            Self::Environment => "環境の取得",
            Self::Spawn => "sidecar の起動",
            Self::Startup => "起動の完了待ち",
            Self::Running => "稼働中",
            Self::Shutdown => "終了処理",
        }
    }
}

/// ログのディレクトリ。環境変数の指定があればそれ、なければ `~/Library/Logs/io.github.machamp0714.nod`。
pub fn log_dir(override_dir: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    if let Some(d) = override_dir.filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let home = home.filter(|h| !h.is_empty())?;
    Some(Path::new(home).join("Library/Logs/io.github.machamp0714.nod"))
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn looks_secret(tok: &str) -> bool {
    const PREFIXES: [&str; 6] = ["ghp_", "gho_", "github_pat_", "sk-", "xoxb-", "xoxp-"];
    if PREFIXES.iter().any(|p| tok.starts_with(p)) {
        return true;
    }
    tok.len() >= 32 && tok.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 1 行に収め、`NAME=値` の値と鍵らしい文字列を伏せ、長さを制限する。
pub fn sanitize(msg: &str) -> String {
    let flat: String = msg.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut out: Vec<String> = Vec::new();
    let mut prev_bearer = false;
    for tok in flat.split_whitespace() {
        let redacted = if prev_bearer {
            REDACTED.to_string()
        } else if let Some(eq) = tok.find('=') {
            let (name, _) = tok.split_at(eq);
            if !name.is_empty() && name.chars().all(is_name_char) {
                format!("{name}={REDACTED}")
            } else {
                REDACTED.to_string()
            }
        } else if looks_secret(tok) {
            REDACTED.to_string()
        } else {
            tok.to_string()
        };
        prev_bearer = tok.eq_ignore_ascii_case("bearer");
        out.push(redacted);
    }
    let joined = out.join(" ");
    if joined.chars().count() > MAX_MESSAGE_CHARS {
        let mut s: String = joined.chars().take(MAX_MESSAGE_CHARS).collect();
        s.push('…');
        s
    } else {
        joined
    }
}

/// UTC の `YYYY-MM-DDTHH:MM:SS.mmmZ`。
pub fn utc_timestamp(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // days since 1970-01-01 → civil date（Howard Hinnant の algorithm）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// サイズで回転するファイル。`nod.log`（最新）→ `nod.log.1` → … 。
pub struct RotatingLog {
    dir: PathBuf,
    max_bytes: u64,
    max_files: usize,
    lock: Mutex<()>,
}

impl RotatingLog {
    pub fn new(dir: PathBuf, max_bytes: u64, max_files: usize) -> Self {
        Self { dir, max_bytes, max_files: max_files.max(1), lock: Mutex::new(()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, n: usize) -> PathBuf {
        if n == 0 {
            self.dir.join(LOG_FILE)
        } else {
            self.dir.join(format!("{LOG_FILE}.{n}"))
        }
    }

    fn rotate(&self) {
        let last = self.max_files - 1;
        if last == 0 {
            let _ = fs::remove_file(self.path(0));
            return;
        }
        let _ = fs::remove_file(self.path(last));
        for n in (0..last).rev() {
            let _ = fs::rename(self.path(n), self.path(n + 1));
        }
    }

    /// 1 行を追記する（末尾に改行を付ける）。上限を超えるなら先に回転する。
    pub fn append(&self, line: &str) -> std::io::Result<()> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(&self.dir)?;
        let size = fs::metadata(self.path(0)).map(|m| m.len()).unwrap_or(0);
        let add = line.len() as u64 + 1;
        if size > 0 && size + add > self.max_bytes {
            self.rotate();
        }
        let mut f = OpenOptions::new().create(true).append(true).open(self.path(0))?;
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")
    }
}

/// アプリ版と起動単位の識別子を付けて書くロガー。書けなくてもアプリの動作は止めない。
pub struct Logger {
    sink: RotatingLog,
    app_version: String,
    launch_id: Mutex<String>,
}

impl Logger {
    pub fn new(dir: PathBuf, app_version: String) -> Self {
        Self::with_limits(dir, app_version, MAX_BYTES, MAX_FILES)
    }

    pub fn with_limits(dir: PathBuf, app_version: String, max_bytes: u64, max_files: usize) -> Self {
        Self {
            sink: RotatingLog::new(dir, max_bytes, max_files),
            app_version: sanitize(&app_version),
            launch_id: Mutex::new("-".into()),
        }
    }

    pub fn dir(&self) -> &Path {
        self.sink.dir()
    }

    pub fn set_launch_id(&self, id: &str) {
        *self.launch_id.lock().unwrap_or_else(|e| e.into_inner()) = sanitize(id);
    }

    pub fn launch_id(&self) -> String {
        self.launch_id.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn event(&self, stage: Stage, msg: &str) {
        let line = format!(
            "{} app={} launch={} stage={} {}",
            utc_timestamp(SystemTime::now()),
            self.app_version,
            self.launch_id(),
            stage.as_str(),
            sanitize(msg)
        );
        let _ = self.sink.append(&line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nod-log-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn rotates_and_keeps_at_most_max_files() {
        let dir = tmp("rot");
        let log = RotatingLog::new(dir.clone(), 100, 3);
        for i in 0..40 {
            log.append(&format!("line-{i:02}-{}", "x".repeat(20))).unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["nod.log", "nod.log.1", "nod.log.2"]);
        for n in &names {
            assert!(fs::metadata(dir.join(n)).unwrap().len() <= 100, "{n} が上限超え");
        }
        // 新しいほど番号が小さい。
        let newest = fs::read_to_string(dir.join("nod.log")).unwrap();
        let older = fs::read_to_string(dir.join("nod.log.2")).unwrap();
        assert!(newest.contains("line-39"));
        assert!(older.contains("line-") && !older.contains("line-39"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_limits_are_2mib_and_5_files() {
        assert_eq!(MAX_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_FILES, 5);
    }

    #[test]
    fn env_pairs_and_secret_looking_tokens_are_redacted() {
        let s = sanitize("失敗 GITHUB_TOKEN=ghp_abcdef PATH=/usr/bin:/bin FOO=bar");
        assert_eq!(s, "失敗 GITHUB_TOKEN=[省略] PATH=[省略] FOO=[省略]");
        assert_eq!(sanitize("token ghp_abcdefghijkl"), "token [省略]");
        assert_eq!(sanitize("Authorization: Bearer abc.def"), "Authorization: Bearer [省略]");
        let long = "a".repeat(40);
        assert_eq!(sanitize(&format!("key {long}")), "key [省略]");
        // パスと通常の文は残る。
        assert_eq!(
            sanitize("sidecar を起動しました（pid 12、ポート 4701）/Applications/nod.app/Contents/MacOS/nod"),
            "sidecar を起動しました（pid 12、ポート 4701）/Applications/nod.app/Contents/MacOS/nod"
        );
    }

    #[test]
    fn multiline_output_becomes_one_bounded_line() {
        let s = sanitize(&format!("a\nb\0c\r\n{}", "あ".repeat(1000)));
        assert!(!s.contains('\n') && !s.contains('\0'));
        assert!(s.chars().count() <= MAX_MESSAGE_CHARS + 1);
        assert!(s.starts_with("a b c "));
    }

    #[test]
    fn logger_line_has_version_launch_stage_and_no_env_values() {
        let dir = tmp("line");
        let l = Logger::with_limits(dir.clone(), "0.1.0".into(), 10_000, 2);
        l.set_launch_id("abc123");
        l.event(Stage::Environment, "環境を取得しました（42 個、120 ms） SECRET_KEY=hunter2");
        let text = fs::read_to_string(dir.join("nod.log")).unwrap();
        assert!(text.contains(" app=0.1.0 launch=abc123 stage=environment "));
        assert!(text.contains("42 個"));
        assert!(!text.contains("hunter2"));
        assert!(text.starts_with("20") && text.contains('Z'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn timestamp_formats_utc() {
        let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(1_791_606_245_123);
        assert_eq!(utc_timestamp(t), "2026-10-10T04:24:05.123Z");
        assert_eq!(utc_timestamp(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn log_dir_prefers_override_then_library_logs() {
        assert_eq!(log_dir(Some("/x/y"), Some("/h")), Some(PathBuf::from("/x/y")));
        assert_eq!(
            log_dir(None, Some("/h")),
            Some(PathBuf::from("/h/Library/Logs/io.github.machamp0714.nod"))
        );
        assert_eq!(log_dir(Some(""), None), None);
    }
}
