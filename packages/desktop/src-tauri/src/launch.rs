// 起動シーケンス: ログインシェルから環境を取得 → ポートを決めて sidecar を起動 →
// URL 行と /api/workspaces の 200 の両方が揃うまで待つ。
use crate::log::Stage;
use crate::platform::{Platform, Proc, ProcEvent, SpawnSpec};
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 4700;

#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub sidecar: PathBuf,
    pub web_dir: PathBuf,
    pub preferred_port: u16,
    pub env_timeout: Duration,
    pub startup_timeout: Duration,
    pub poll_interval: Duration,
    /// 環境取得の出力を囲む印に使う一意な文字列。
    pub nonce: String,
    /// None なら `$SHELL`、それも無ければ /bin/zsh。
    pub shell: Option<String>,
    /// シェルを起動するときだけ環境へ重ねる値（テスト用）。
    pub shell_env_overlay: Vec<(String, String)>,
}

impl LaunchConfig {
    pub fn new(sidecar: PathBuf, web_dir: PathBuf, nonce: String) -> Self {
        Self {
            sidecar,
            web_dir,
            preferred_port: DEFAULT_PORT,
            env_timeout: Duration::from_secs(5),
            startup_timeout: Duration::from_secs(15),
            poll_interval: Duration::from_millis(50),
            nonce,
            shell: None,
            shell_env_overlay: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    /// 環境取得の失敗（原因の要約のみ。環境の内容は含めない）。
    EnvFailed(String),
    EnvTimeout,
    NoHome,
    SpawnFailed(String),
    /// URL 行を出す前、または 200 になる前に sidecar が終了した。
    EarlyExit(Option<i32>),
    /// 4700 に別の nod ui がいて、sidecar が再利用を選んだ。
    PortReused,
    StartupTimeout { url_seen: bool },
    /// DB の版が sidecar より新しい（sidecar の出力の `SCHEMA_TOO_NEW` で検出）。
    SchemaTooNew,
    Cancelled,
}

impl fmt::Display for LaunchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EnvFailed(s) => write!(f, "環境の取得に失敗しました: {s}"),
            Self::EnvTimeout => write!(f, "環境の取得が制限時間内に終わりませんでした"),
            Self::NoHome => write!(f, "HOME を決められません"),
            Self::SpawnFailed(s) => write!(f, "sidecar を起動できません: {s}"),
            Self::EarlyExit(c) => write!(f, "起動の完了前に sidecar が終了しました（終了コード: {c:?}）"),
            Self::PortReused => write!(f, "ポートを別の nod ui が使っています"),
            Self::StartupTimeout { url_seen } => write!(
                f,
                "sidecar の起動が制限時間内に完了しませんでした（URL 行: {}）",
                if *url_seen { "受信済み" } else { "未受信" }
            ),
            Self::SchemaTooNew => write!(f, "DB の版が nod より新しいため開けません"),
            Self::Cancelled => write!(f, "起動は取り消されました"),
        }
    }
}

pub struct Launched {
    pub url: String,
    pub proc: Arc<dyn Proc>,
    pub port_requested: u16,
}

/// `env -0` の出力から、begin と end の印の間にある NUL 区切りの `KEY=VALUE` を取り出す。
/// 印の前後に混ざったシェルの出力（motd や rc の echo）は捨てる。
pub fn parse_env_block(out: &[u8], begin: &str, end: &str) -> Result<Vec<(String, String)>, String> {
    let b = find(out, begin.as_bytes(), 0).ok_or("開始の印がありません")?;
    let start = b + begin.len();
    let e = find(out, end.as_bytes(), start).ok_or("終了の印がありません")?;
    let mut vars = Vec::new();
    for entry in out[start..e].split(|&c| c == 0) {
        let Some(eq) = entry.iter().position(|&c| c == b'=') else { continue };
        if eq == 0 {
            continue;
        }
        vars.push((
            String::from_utf8_lossy(&entry[..eq]).into_owned(),
            String::from_utf8_lossy(&entry[eq + 1..]).into_owned(),
        ));
    }
    if vars.is_empty() {
        return Err("環境変数が 1 つも取れません".into());
    }
    Ok(vars)
}

fn find(h: &[u8], n: &[u8], from: usize) -> Option<usize> {
    if n.is_empty() || h.len() < n.len() || from > h.len() - n.len() {
        return None;
    }
    (from..=h.len() - n.len()).find(|&i| &h[i..i + n.len()] == n)
}

#[derive(Debug, PartialEq, Eq)]
enum Line {
    Url(String),
    Reused,
    Other,
}

/// `nod ui: http://127.0.0.1:PORT/（DB: ...）` の行から URL を取り出す。
/// 既存の nod ui を再利用した場合の行（`すでに起動している nod ui を開きます: URL`）は Reused。
fn classify_line(line: &str) -> Line {
    if line.contains("すでに起動している") || line.contains("\"reused\":true") {
        return Line::Reused;
    }
    let Some(i) = line.find("http://127.0.0.1:") else { return Line::Other };
    let url: String = line[i..]
        .chars()
        .take_while(|c| c.is_ascii() && !c.is_whitespace() && !matches!(c, '"' | ',' | ')' | '('))
        .collect();
    let port = &url["http://127.0.0.1:".len()..];
    let digits: String = port.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.parse::<u16>().is_err() {
        return Line::Other;
    }
    Line::Url(format!("http://127.0.0.1:{digits}/"))
}

fn fetch_env(
    p: &dyn Platform,
    cfg: &LaunchConfig,
    cancel: &dyn Fn() -> bool,
) -> Result<Vec<(String, String)>, LaunchError> {
    let started = p.now();
    let r = fetch_env_inner(p, cfg, cancel);
    if let Err(e) = &r {
        if !matches!(e, LaunchError::Cancelled) {
            // 原因の文字列（シェルのエラー文など）は載せず、分類と所要時間だけを残す。
            let kind = match e {
                LaunchError::EnvTimeout => "タイムアウト",
                LaunchError::EnvFailed(_) => "シェルの起動または出力の解析に失敗",
                _ => "その他",
            };
            p.log_at(
                Stage::Environment,
                &format!("環境の取得に失敗しました（{kind}、{} ms）", p.now().saturating_sub(started).as_millis()),
            );
        }
    }
    r
}

fn fetch_env_inner(
    p: &dyn Platform,
    cfg: &LaunchConfig,
    cancel: &dyn Fn() -> bool,
) -> Result<Vec<(String, String)>, LaunchError> {
    let shell = cfg
        .shell
        .clone()
        .or_else(|| p.var("SHELL").filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let begin = format!("__NOD_ENV_BEGIN_{}__", cfg.nonce);
    let end = format!("__NOD_ENV_END_{}__", cfg.nonce);
    let script = format!("printf '%s' '{begin}'; /usr/bin/env -0; printf '%s' '{end}'");
    let spec = SpawnSpec {
        program: PathBuf::from(&shell),
        args: vec!["-ilc".into(), script],
        extra_env: cfg.shell_env_overlay.clone(),
        new_group: true,
        ..Default::default()
    };
    let started = p.now();
    let proc = p.spawn(&spec).map_err(LaunchError::EnvFailed)?;
    let mut out = Vec::new();
    let code = loop {
        match proc.poll() {
            Some(ProcEvent::Stdout(b)) => {
                out.extend_from_slice(&b);
                continue;
            }
            Some(ProcEvent::Exited(c)) => break c,
            None => {}
        }
        if cancel() {
            proc.kill();
            return Err(LaunchError::Cancelled);
        }
        if p.now().saturating_sub(started) >= cfg.env_timeout {
            proc.kill();
                        return Err(LaunchError::EnvTimeout);
        }
        p.sleep(cfg.poll_interval);
    };
    if code != Some(0) {
        return Err(LaunchError::EnvFailed(format!("シェルが終了コード {code:?} で終了しました")));
    }
    let vars = parse_env_block(&out, &begin, &end).map_err(LaunchError::EnvFailed)?;
    p.log_at(Stage::Environment, &format!(
        "環境を取得しました（{} 個、{} ms）",
        vars.len(),
        p.now().saturating_sub(started).as_millis()
    ));
    Ok(vars)
}

/// 環境取得 → sidecar 起動 → 起動完了の判定。
/// `cancel` が true を返したら途中で打ち切る。`on_spawn` は sidecar を起動した直後に呼ぶ
/// （終了処理が、起動待機中の子も止められるようにするため）。
pub fn launch(
    p: &dyn Platform,
    cfg: &LaunchConfig,
    cancel: &dyn Fn() -> bool,
    on_spawn: &dyn Fn(&Arc<dyn Proc>),
) -> Result<Launched, LaunchError> {
    let env = fetch_env(p, cfg, cancel)?;
    let home = env
        .iter()
        .find(|(k, _)| k == "HOME")
        .map(|(_, v)| v.clone())
        .or_else(|| p.var("HOME"))
        .filter(|h| !h.is_empty())
        .ok_or(LaunchError::NoHome)?;

    // 判定と起動の間に取られる競合に備え、先頭が失敗したら 0 で 1 回だけやり直す。
    let ports: Vec<u16> = if p.port_is_free(cfg.preferred_port) {
        vec![cfg.preferred_port, 0]
    } else {
        p.log_at(
            Stage::Spawn,
            &format!("ポート {} は使用中のため空きポートを使います", cfg.preferred_port),
        );
        vec![0]
    };
    let deadline = p.now() + cfg.startup_timeout;
    let mut last = LaunchError::StartupTimeout { url_seen: false };
    for (i, port) in ports.iter().enumerate() {
        match attempt(p, cfg, &env, &home, *port, deadline, cancel, on_spawn) {
            Ok(l) => return Ok(l),
            Err(e @ (LaunchError::PortReused | LaunchError::EarlyExit(_)))
                if *port != 0 && i + 1 < ports.len() =>
            {
                p.log_at(
                    Stage::Spawn,
                    &format!("ポート {port} での起動に失敗したため、空きポートでやり直します（{e}）"),
                );
                last = e;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

#[allow(clippy::too_many_arguments)]
fn attempt(
    p: &dyn Platform,
    cfg: &LaunchConfig,
    env: &[(String, String)],
    home: &str,
    port: u16,
    deadline: Duration,
    cancel: &dyn Fn() -> bool,
    on_spawn: &dyn Fn(&Arc<dyn Proc>),
) -> Result<Launched, LaunchError> {
    let spec = SpawnSpec {
        program: cfg.sidecar.clone(),
        args: vec![
            "ui".into(),
            "--port".into(),
            port.to_string(),
            "--no-open".into(),
            "--web-dir".into(),
            cfg.web_dir.to_string_lossy().into_owned(),
        ],
        env: Some(env.to_vec()),
        cwd: Some(PathBuf::from(home)),
        new_group: true,
        inherit_stderr: true,
        ..Default::default()
    };
    let proc = p.spawn(&spec).map_err(LaunchError::SpawnFailed)?;
    on_spawn(&proc);
    p.log_at(
        Stage::Spawn,
        &format!("sidecar を起動しました（pid {}、要求ポート {port}）", proc.pid()),
    );

    let fail = |e: LaunchError| -> Result<Launched, LaunchError> {
        proc.kill();
        Err(e)
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut url: Option<String> = None;
    loop {
        if cancel() {
            return fail(LaunchError::Cancelled);
        }
        // 届いている出力を先に読み切る。
        let mut exited = None;
        while let Some(ev) = proc.poll() {
            match ev {
                ProcEvent::Stdout(b) => buf.extend_from_slice(&b),
                ProcEvent::Exited(c) => {
                    exited = Some(c);
                    break;
                }
            }
        }
        while let Some(nl) = buf.iter().position(|&c| c == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            match classify_line(&String::from_utf8_lossy(&line)) {
                Line::Reused => return fail(LaunchError::PortReused),
                Line::Url(u) if url.is_none() => url = Some(u),
                _ => {}
            }
        }
        if let Some(code) = exited {
            let signal = proc.exit_signal();
            p.log_at(
                Stage::Startup,
                &format!(
                    "sidecar が起動の完了前に終了しました（pid {}、終了コード {code:?}、シグナル {signal:?}）",
                    proc.pid()
                ),
            );
            // 版が新しすぎる場合は標準エラー（または標準出力）の `SCHEMA_TOO_NEW` で分かる。
            if proc.stderr_tail().contains("SCHEMA_TOO_NEW")
                || String::from_utf8_lossy(&buf).contains("SCHEMA_TOO_NEW")
            {
                return Err(LaunchError::SchemaTooNew);
            }
            return Err(LaunchError::EarlyExit(code));
        }
        if let Some(u) = &url {
            if p.http_status(&format!("{u}api/workspaces")) == Some(200) {
                proc.discard_output();
                p.log_at(Stage::Startup, &format!("起動完了: {u}（pid {}）", proc.pid()));
                return Ok(Launched { url: u.clone(), proc, port_requested: port });
            }
        }
        if p.now() >= deadline {
            return fail(LaunchError::StartupTimeout { url_seen: url.is_some() });
        }
        p.sleep(cfg.poll_interval);
    }
}
