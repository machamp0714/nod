// デスクトップアプリの起動・監督ロジック。Tauri のイベントループには依存せず、
// プロセス生成・HTTP・時計・ポート判定を Platform として差し替えられる。
pub mod about;
pub mod failure;
pub mod launch;
pub mod log;
pub mod navigation;
pub mod orphan;
pub mod platform;
pub mod recovery;
pub mod supervisor;
pub mod window_state;

pub use launch::{launch, parse_env_block, LaunchConfig, LaunchError, Launched, DEFAULT_PORT};
pub use orphan::stop_sidecar;
pub use platform::{
    http_status, Platform, Proc, ProcEvent, ProcInfo, RealPlatform, Signal, SpawnSpec,
};
pub use supervisor::{run_launch, stop_process, LaunchOutcome, Supervisor, STOP_GRACE};
pub use failure::{classify, diagnostics, DiagInput, Failure, FailureKind, RunState};
pub use log::{Logger, Stage};
