// 実プロセス（tests/fixtures のスタブ）を使う契約テスト。時計・HTTP・ポート判定は実物。
use nod_desktop::*;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// /api/workspaces に 200 を返す簡易サーバー。ポートを返す。
fn http_server() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let mut s = s;
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]");
        }
    });
    port
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nod-desktop-test-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn cfg(dir: &Path, shell: &str, mode: &str, stub_port: u16) -> LaunchConfig {
    let mut c = LaunchConfig::new(fixture("fake-nod.sh"), dir.join("web"), "NONCE".into());
    c.shell = Some(fixture(shell).to_string_lossy().into_owned());
    c.preferred_port = free_port();
    c.env_timeout = Duration::from_millis(400);
    c.startup_timeout = Duration::from_millis(1500);
    c.shell_env_overlay = vec![
        ("HOME".into(), dir.to_string_lossy().into_owned()),
        ("STUB_MODE".into(), mode.into()),
        ("STUB_PORT".into(), stub_port.to_string()),
        ("STUB_RECORD_DIR".into(), dir.to_string_lossy().into_owned()),
        ("STUB_PID_FILE".into(), dir.join("shell.pid").to_string_lossy().into_owned()),
        ("STUB_CHILD_PID_FILE".into(), dir.join("child.pid").to_string_lossy().into_owned()),
    ];
    c
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_dead(pid: i32) -> bool {
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn 実プロセス_起動完了_環境と_cwd_の引き渡し_sigterm_停止() {
    let dir = tmp("ok");
    let port = http_server();
    let c = cfg(&dir, "fake-shell.sh", "ok", port);
    let real = RealPlatform::new();
    let l = launch(&real, &c, &|| false, &|_| {}).expect("起動できる");
    assert_eq!(l.url, format!("http://127.0.0.1:{port}/"));
    // preferred_port は空いていたのでそれを要求している
    assert_eq!(l.port_requested, c.preferred_port);
    let args = fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.starts_with(&format!("ui --port {} --no-open --web-dir", c.preferred_port)), "{args}");
    let cwd = fs::read_to_string(dir.join("cwd")).unwrap();
    assert_eq!(fs::canonicalize(cwd.trim()).unwrap(), fs::canonicalize(&dir).unwrap());
    let path = fs::read_to_string(dir.join("path")).unwrap();
    assert!(path.starts_with("/stub/bin:"), "シェルの PATH 補完が渡る: {path}");

    let pid = l.proc.pid() as i32;
    let t = Instant::now();
    stop_process(&real, l.proc.as_ref(), STOP_GRACE);
    assert!(t.elapsed() < Duration::from_secs(2), "SIGTERM で速やかに止まる");
    assert!(wait_dead(pid));
}

#[test]
fn 実プロセス_優先ポートが使用中なら_0_で起動する() {
    let dir = tmp("busy");
    let port = http_server();
    let mut c = cfg(&dir, "fake-shell.sh", "ok", port);
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    c.preferred_port = held.local_addr().unwrap().port();
    let real = RealPlatform::new();
    let l = launch(&real, &c, &|| false, &|_| {}).unwrap();
    assert_eq!(l.port_requested, 0);
    let args = fs::read_to_string(dir.join("args")).unwrap();
    assert!(args.starts_with("ui --port 0 "), "{args}");
    stop_process(&real, l.proc.as_ref(), STOP_GRACE);
}

#[test]
fn 実プロセス_終わらないシェルは打ち切られ孫も残らず_sidecar_は起動しない() {
    let dir = tmp("hang");
    let mut c = cfg(&dir, "fake-shell-hang.sh", "ok", 1);
    c.env_timeout = Duration::from_secs(1); // 負荷時の起動遅れで pid ファイルが間に合わないのを避ける
    let t = Instant::now();
    let r = launch(&RealPlatform::new(), &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::EnvTimeout));
    assert!(t.elapsed() < Duration::from_secs(3));
    assert!(!dir.join("args").exists(), "sidecar は起動していない");
    for f in ["shell.pid", "child.pid"] {
        let pid: i32 = fs::read_to_string(dir.join(f)).unwrap().trim().parse().unwrap();
        assert!(wait_dead(pid), "{f} のプロセスが残っている");
    }
}

#[test]
fn 実プロセス_url_行だけ_200_だけでは完了にならない() {
    // URL 行は出るが、そのポートには誰も待ち受けていない
    let dir = tmp("urlonly");
    let c = cfg(&dir, "fake-shell.sh", "ok", free_port());
    let r = launch(&RealPlatform::new(), &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::StartupTimeout { url_seen: true }));

    // 200 は返るが、URL 行を出さない
    let dir = tmp("200only");
    let c = cfg(&dir, "fake-shell.sh", "silent", http_server());
    let r = launch(&RealPlatform::new(), &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::StartupTimeout { url_seen: false }));
}

#[test]
fn 実プロセス_早期終了と再利用は失敗として扱う() {
    let dir = tmp("exit");
    let c = cfg(&dir, "fake-shell.sh", "exit", http_server());
    let r = launch(&RealPlatform::new(), &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::EarlyExit(Some(3))));

    let dir = tmp("reused");
    let c = cfg(&dir, "fake-shell.sh", "reused", http_server());
    let r = launch(&RealPlatform::new(), &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::PortReused));
}

#[test]
fn http_status_は_200_とそれ以外を区別する() {
    let port = http_server();
    assert_eq!(http_status(&format!("http://127.0.0.1:{port}/api/workspaces"), Duration::from_secs(1)), Some(200));
    assert_eq!(http_status(&format!("http://127.0.0.1:{}/", free_port()), Duration::from_millis(300)), None);
}

#[test]
fn 実プロセス_版が新しすぎる場合は標準エラーから検出し_失敗の記録に秘密を残さない() {
    let dir = tmp("schema");
    let mut c = cfg(&dir, "fake-shell.sh", "schema", 1);
    c.shell_env_overlay.push(("NOD_TEST_SECRET".into(), "sekret-value-12345".into()));
    let logs = dir.join("logs");
    let logger = std::sync::Arc::new(Logger::new(logs.clone(), "0.0.0-test".into()));
    logger.set_launch_id("test-launch");
    let real = RealPlatform::with_logger(logger);
    let r = launch(&real, &c, &|| false, &|_| {});
    assert_eq!(r.err(), Some(LaunchError::SchemaTooNew));

    let text = fs::read_to_string(logs.join("nod.log")).unwrap();
    assert!(text.contains("launch=test-launch") && text.contains("stage=environment"), "{text}");
    assert!(text.contains("環境を取得しました") && text.contains("sidecar を起動しました"), "{text}");
    assert!(text.contains("終了コード Some(1)"), "{text}");
    assert!(!text.contains("sekret-value-12345") && !text.contains("NOD_TEST_SECRET"), "{text}");
    assert!(!text.contains("/stub/bin"), "PATH の中身を記録しない: {text}");
}

#[test]
fn 実プロセス_環境取得の失敗は分類と所要時間だけを記録する() {
    let dir = tmp("envfail");
    let mut c = cfg(&dir, "fake-shell.sh", "ok", 1);
    c.shell = Some("/nonexistent/shell".into());
    let logs = dir.join("logs");
    let real = RealPlatform::with_logger(std::sync::Arc::new(Logger::new(logs.clone(), "t".into())));
    let r = launch(&real, &c, &|| false, &|_| {});
    assert!(matches!(r, Err(LaunchError::EnvFailed(_))));
    let text = fs::read_to_string(logs.join("nod.log")).unwrap();
    assert!(text.contains("環境の取得に失敗しました"), "{text}");
    assert!(!text.contains("/nonexistent/shell"), "シェルのエラー文は載せない: {text}");
}
