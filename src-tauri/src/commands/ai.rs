use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, time};

#[derive(Debug, Clone, Serialize)]
pub struct AiProviderStatus {
    pub id: String,
    pub label: String,
    pub command: String,
    pub available: bool,
    pub path: Option<String>,
    pub command_preview: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiRunRequest {
    pub provider: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRunResult {
    pub provider: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 96 * 1024;
const AI_TIMEOUT: Duration = Duration::from_secs(120);

#[tauri::command]
pub fn detect_ai_providers() -> Vec<AiProviderStatus> {
    vec![
        provider_status(
            "codex",
            "Codex CLI",
            "codex",
            "codex exec --sandbox read-only --skip-git-repo-check --ephemeral -",
        ),
        provider_status(
            "claude",
            "Claude Code",
            "claude",
            "claude -p --permission-mode default --tools \"\" <prompt>",
        ),
    ]
}

#[tauri::command]
pub async fn run_ai_prompt(request: AiRunRequest) -> AppResult<AiRunResult> {
    if request.prompt.trim().is_empty() {
        return Err(AppError::Internal("prompt is empty".into()));
    }
    if request.prompt.len() > MAX_PROMPT_BYTES {
        return Err(AppError::Internal(format!(
            "prompt is too large: {} bytes > {} bytes",
            request.prompt.len(),
            MAX_PROMPT_BYTES
        )));
    }

    let executable = match request.provider.as_str() {
        "codex" => find_on_path("codex"),
        "claude" => find_on_path("claude"),
        other => {
            return Err(AppError::Internal(format!(
                "unsupported AI provider '{other}'"
            )))
        }
    }
    .ok_or_else(|| AppError::Internal(format!("{} CLI was not found on PATH", request.provider)))?;

    let mut cmd = Command::new(executable);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match request.provider.as_str() {
        "codex" => {
            cmd.args([
                "exec",
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "-",
            ]);
        }
        "claude" => {
            cmd.args(["-p", "--permission-mode", "default", "--tools", ""]);
        }
        _ => unreachable!(),
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Internal(format!("failed to start AI provider: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(request.prompt.as_bytes())
            .await
            .map_err(|e| AppError::Internal(format!("failed to write prompt: {e}")))?;
    }

    match time::timeout(AI_TIMEOUT, child.wait_with_output()).await {
        Ok(output) => {
            let output =
                output.map_err(|e| AppError::Internal(format!("AI provider failed: {e}")))?;
            Ok(AiRunResult {
                provider: request.provider,
                stdout: truncate_utf8(&String::from_utf8_lossy(&output.stdout), MAX_OUTPUT_BYTES),
                stderr: truncate_utf8(&String::from_utf8_lossy(&output.stderr), MAX_OUTPUT_BYTES),
                exit_code: output.status.code(),
                timed_out: false,
            })
        }
        Err(_) => Ok(AiRunResult {
            provider: request.provider,
            stdout: String::new(),
            stderr: format!(
                "AI provider timed out after {} seconds",
                AI_TIMEOUT.as_secs()
            ),
            exit_code: None,
            timed_out: true,
        }),
    }
}

fn provider_status(id: &str, label: &str, command: &str, preview: &str) -> AiProviderStatus {
    let path = find_on_path(command);
    AiProviderStatus {
        id: id.to_string(),
        label: label.to_string(),
        command: command.to_string(),
        available: path.is_some(),
        path: path.map(|p| p.display().to_string()),
        command_preview: preview.to_string(),
    }
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(command);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[output truncated by Lumen]", &value[..end])
}
