//! Helm CLI write ops via a `helm` subprocess.
//!
//! Implementing Helm's templating + chart-deps + hook lifecycle natively in
//! Rust would be its own project, so for write paths (install/upgrade/
//! rollback/uninstall) Lumen shells out to the user's installed `helm` CLI.
//! Read paths (list/get/history) still decode the release Secret directly —
//! they don't need the helm binary.
//!
//! Each command streams stdout/stderr to a Tauri Channel so the UI can show
//! progress on long operations (chart download, hook waits). The underlying
//! `helm` process inherits Lumen's KUBECONFIG and we pass `--kube-context`
//! explicitly to keep the active-context flow consistent.
//!
//! `helm` must be on PATH; if it isn't we surface an actionable error
//! pointing at https://helm.sh/docs/intro/install/ rather than a generic
//! "command not found".

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HelmEvent {
    Stdout { line: String },
    Stderr { line: String },
    Exited { code: i32 },
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelmInstallRequest {
    pub release: String,
    pub chart: String,
    pub namespace: String,
    pub version: Option<String>,
    pub values_yaml: Option<String>,
    pub create_namespace: bool,
    pub wait: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelmUpgradeRequest {
    pub release: String,
    pub chart: String,
    pub namespace: String,
    pub version: Option<String>,
    pub values_yaml: Option<String>,
    pub install: bool,
    pub wait: bool,
    pub atomic: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelmRollbackRequest {
    pub release: String,
    pub namespace: String,
    pub revision: u32,
    pub wait: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HelmUninstallRequest {
    pub release: String,
    pub namespace: String,
    pub keep_history: bool,
}

fn helm_command(context: &str) -> AppResult<Command> {
    let mut cmd = Command::new("helm");
    cmd.arg("--kube-context").arg(context);
    cmd.kill_on_drop(true);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    Ok(cmd)
}

pub async fn install(
    context: &str,
    req: HelmInstallRequest,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let mut cmd = helm_command(context)?;
    cmd.arg("install")
        .arg(&req.release)
        .arg(&req.chart)
        .arg("--namespace")
        .arg(&req.namespace);
    if req.create_namespace {
        cmd.arg("--create-namespace");
    }
    if let Some(v) = &req.version {
        cmd.arg("--version").arg(v);
    }
    if req.wait {
        cmd.arg("--wait");
    }
    run_with_values(cmd, req.values_yaml.as_deref(), channel, cancel).await
}

pub async fn upgrade(
    context: &str,
    req: HelmUpgradeRequest,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let mut cmd = helm_command(context)?;
    cmd.arg("upgrade")
        .arg(&req.release)
        .arg(&req.chart)
        .arg("--namespace")
        .arg(&req.namespace);
    if req.install {
        cmd.arg("--install");
    }
    if let Some(v) = &req.version {
        cmd.arg("--version").arg(v);
    }
    if req.wait {
        cmd.arg("--wait");
    }
    if req.atomic {
        cmd.arg("--atomic");
    }
    run_with_values(cmd, req.values_yaml.as_deref(), channel, cancel).await
}

pub async fn rollback(
    context: &str,
    req: HelmRollbackRequest,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let mut cmd = helm_command(context)?;
    cmd.arg("rollback")
        .arg(&req.release)
        .arg(req.revision.to_string())
        .arg("--namespace")
        .arg(&req.namespace);
    if req.wait {
        cmd.arg("--wait");
    }
    run(cmd, channel, cancel).await
}

pub async fn uninstall(
    context: &str,
    req: HelmUninstallRequest,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let mut cmd = helm_command(context)?;
    cmd.arg("uninstall")
        .arg(&req.release)
        .arg("--namespace")
        .arg(&req.namespace);
    if req.keep_history {
        cmd.arg("--keep-history");
    }
    run(cmd, channel, cancel).await
}

async fn run_with_values(
    mut cmd: Command,
    values_yaml: Option<&str>,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    // Helm's `--values -` reads YAML from stdin, which avoids writing the
    // (potentially sensitive) values to a temp file on disk.
    let values = values_yaml.map(str::to_owned);
    if values.is_some() {
        cmd.arg("--values").arg("-");
        cmd.stdin(Stdio::piped());
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::K8s(
                "helm CLI not found on PATH. Install from https://helm.sh/docs/intro/install/ or add it to your shell PATH.".into(),
            ));
        }
        Err(e) => return Err(AppError::K8s(format!("spawn helm: {e}"))),
    };

    if let Some(v) = values {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            if let Err(e) = stdin.write_all(v.as_bytes()).await {
                let _ = channel.send(HelmEvent::Error {
                    message: format!("write values to helm stdin: {e}"),
                });
            }
        }
    }

    pump_to_channel(child, channel, cancel).await
}

async fn run(
    cmd: Command,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let mut cmd = cmd;
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::K8s(
                "helm CLI not found on PATH. Install from https://helm.sh/docs/intro/install/ or add it to your shell PATH.".into(),
            ));
        }
        Err(e) => return Err(AppError::K8s(format!("spawn helm: {e}"))),
    };
    pump_to_channel(child, channel, cancel).await
}

async fn pump_to_channel(
    mut child: tokio::process::Child,
    channel: Channel<HelmEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let ch = channel.clone();
    let ch2 = channel.clone();
    let c = cancel.clone();
    let c2 = cancel.clone();

    let stdout_task = stdout.map(|out| {
        tokio::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            loop {
                tokio::select! {
                    _ = c.cancelled() => break,
                    line = reader.next_line() => match line {
                        Ok(Some(line)) => { let _ = ch.send(HelmEvent::Stdout { line }); }
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        })
    });

    let stderr_task = stderr.map(|err| {
        tokio::spawn(async move {
            let mut reader = BufReader::new(err).lines();
            loop {
                tokio::select! {
                    _ = c2.cancelled() => break,
                    line = reader.next_line() => match line {
                        Ok(Some(line)) => { let _ = ch2.send(HelmEvent::Stderr { line }); }
                        Ok(None) | Err(_) => break,
                    }
                }
            }
        })
    });

    let exit_code = tokio::select! {
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            let _ = channel.send(HelmEvent::Error { message: "cancelled by user".into() });
            -1
        }
        status = child.wait() => match status {
            Ok(s) => s.code().unwrap_or(-1),
            Err(e) => {
                let _ = channel.send(HelmEvent::Error { message: format!("wait: {e}") });
                -1
            }
        }
    };

    if let Some(t) = stdout_task {
        let _ = t.await;
    }
    if let Some(t) = stderr_task {
        let _ = t.await;
    }

    let _ = channel.send(HelmEvent::Exited { code: exit_code });
    Ok(())
}
