// 骨格。sidecar（同梱した nod）に `nod ui` を起動させ、WebView でその URL を開く。
// ポート 4700 優先・環境取得・15 秒判定・Single Instance などは後続の Task で入れる。
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Sidecar(Mutex<Option<Child>>);

/// `nod ui: http://127.0.0.1:PORT/（DB: ...）` の行から URL を取り出す。
fn parse_url(line: &str) -> Option<String> {
    let i = line.find("http://127.0.0.1:")?;
    let url: String = line[i..]
        .chars()
        .take_while(|c| c.is_ascii() && !c.is_whitespace())
        .collect();
    Some(url)
}

fn sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // .../nod.app/Contents/MacOS/<main> と同じディレクトリに externalBin の nod がある。
    Ok(exe.parent().ok_or("exe に親がありません")?.join("nod"))
}

fn start_sidecar(handle: tauri::AppHandle) -> Result<(), String> {
    let web_dir = handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("web");
    let mut child = Command::new(sidecar_path()?)
        .args(["ui", "--port", "0", "--no-open", "--web-dir"])
        .arg(&web_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("sidecar を起動できません: {e}"))?;
    let stdout = child.stdout.take().ok_or("sidecar の標準出力がありません")?;
    handle.state::<Sidecar>().0.lock().unwrap().replace(child);

    let mut url = None;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    while url.is_none() {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("URL を出力する前に sidecar が終了しました".into());
        }
        url = parse_url(&line);
    }
    let url = url.unwrap();
    println!("nod: sidecar url = {url}");

    let h = handle.clone();
    handle
        .run_on_main_thread(move || {
            let parsed = url.parse().expect("URL");
            let _ = WebviewWindowBuilder::new(&h, "main", WebviewUrl::External(parsed))
                .title("nod")
                .inner_size(1280.0, 800.0)
                .build();
        })
        .map_err(|e| e.to_string())?;

    // パイプを詰まらせないよう、以降の出力は読み捨てる。
    for _ in reader.lines() {}
    Ok(())
}

fn stop_sidecar(app: &tauri::AppHandle) {
    if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = start_sidecar(handle.clone()) {
                    eprintln!("nod: 起動に失敗しました: {e}");
                    stop_sidecar(&handle);
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri の初期化に失敗しました");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_sidecar(handle);
        }
    });
}
