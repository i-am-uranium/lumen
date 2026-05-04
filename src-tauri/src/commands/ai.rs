use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsStr,
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
    pub models: Vec<String>,
    pub default_model: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiRunRequest {
    pub provider: String,
    pub prompt: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiRunResult {
    pub provider: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AiCommandRunRequest {
    pub command: String,
    pub context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiCommandRunResult {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 96 * 1024;
const AI_TIMEOUT: Duration = Duration::from_secs(120);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[tauri::command]
pub fn detect_ai_providers() -> Vec<AiProviderStatus> {
    vec![
        provider_status(
            "codex",
            "Codex CLI",
            "codex",
            "codex exec --model <model> --sandbox read-only --skip-git-repo-check --ephemeral --output-last-message <file> -",
            &["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
            "gpt-5.5",
        ),
        provider_status(
            "claude",
            "Claude Code",
            "claude",
            "claude -p --model <model> --permission-mode default --tools \"\" <prompt>",
            &["sonnet", "opus"],
            "sonnet",
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

    let provider_models = match request.provider.as_str() {
        "codex" => vec!["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
        "claude" => vec!["sonnet", "opus"],
        _ => vec![],
    };
    let model = request
        .model
        .as_deref()
        .filter(|m| provider_models.iter().any(|allowed| allowed == m))
        .unwrap_or(match request.provider.as_str() {
            "codex" => "gpt-5.5",
            "claude" => "sonnet",
            _ => "",
        });

    let output_last_message_path = if request.provider == "codex" {
        Some(env::temp_dir().join(format!(
            "lumen-codex-answer-{}-{}.md",
            std::process::id(),
            chrono_like_millis()
        )))
    } else {
        None
    };

    match request.provider.as_str() {
        "codex" => {
            let output_path = output_last_message_path
                .as_ref()
                .expect("codex output path should be set")
                .display()
                .to_string();
            cmd.args([
                "exec",
                "--model",
                model,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "--output-last-message",
                &output_path,
                "-",
            ]);
        }
        "claude" => {
            cmd.args([
                "-p",
                "--model",
                model,
                "--permission-mode",
                "default",
                "--tools",
                "",
            ]);
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
            let stdout = if let Some(path) = output_last_message_path.as_ref() {
                std::fs::read_to_string(path)
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                String::from_utf8_lossy(&output.stdout).to_string()
            };
            if let Some(path) = output_last_message_path.as_ref() {
                let _ = std::fs::remove_file(path);
            }
            Ok(AiRunResult {
                provider: request.provider,
                stdout: truncate_utf8(&stdout, MAX_OUTPUT_BYTES),
                stderr: truncate_utf8(&String::from_utf8_lossy(&output.stderr), MAX_OUTPUT_BYTES),
                exit_code: output.status.code(),
                timed_out: false,
            })
        }
        Err(_) => {
            if let Some(path) = output_last_message_path.as_ref() {
                let _ = std::fs::remove_file(path);
            }
            Ok(AiRunResult {
                provider: request.provider,
                stdout: String::new(),
                stderr: format!(
                    "AI provider timed out after {} seconds",
                    AI_TIMEOUT.as_secs()
                ),
                exit_code: None,
                timed_out: true,
            })
        }
    }
}

#[tauri::command]
pub async fn run_ai_command(request: AiCommandRunRequest) -> AppResult<AiCommandRunResult> {
    let parsed = parse_ai_command(&request.command, request.context.as_deref())?;
    let executable = find_on_path(&parsed.program)
        .ok_or_else(|| AppError::Internal(format!("{} was not found on PATH", parsed.program)))?;

    let mut cmd = Command::new(executable);
    cmd.args(&parsed.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    match time::timeout(COMMAND_TIMEOUT, cmd.output()).await {
        Ok(output) => {
            let output =
                output.map_err(|e| AppError::Internal(format!("failed to run command: {e}")))?;
            Ok(AiCommandRunResult {
                command: parsed.display_command,
                stdout: truncate_utf8(&String::from_utf8_lossy(&output.stdout), MAX_OUTPUT_BYTES),
                stderr: truncate_utf8(&String::from_utf8_lossy(&output.stderr), MAX_OUTPUT_BYTES),
                exit_code: output.status.code(),
                timed_out: false,
            })
        }
        Err(_) => Ok(AiCommandRunResult {
            command: parsed.display_command,
            stdout: String::new(),
            stderr: format!(
                "command timed out after {} seconds",
                COMMAND_TIMEOUT.as_secs()
            ),
            exit_code: None,
            timed_out: true,
        }),
    }
}

#[derive(Debug, Clone)]
struct ParsedAiCommand {
    program: String,
    args: Vec<String>,
    display_command: String,
}

fn parse_ai_command(command: &str, context: Option<&str>) -> AppResult<ParsedAiCommand> {
    let tokens = shell_split(command)?;
    if tokens.is_empty() {
        return Err(AppError::Internal("command is empty".into()));
    }
    if tokens.iter().any(|token| is_shell_operator(token)) {
        return Err(AppError::Internal(
            "shell operators and pipelines are not supported for assistant-run commands".into(),
        ));
    }

    let program = tokens[0].trim_start_matches("`").trim_end_matches("`");
    if program != "kubectl" {
        return Err(AppError::Internal(
            "only kubectl inspection commands can be run from the assistant".into(),
        ));
    }

    let mut args = tokens[1..].to_vec();
    let verb = first_kubectl_verb(&args)
        .ok_or_else(|| AppError::Internal("could not identify kubectl verb".into()))?;
    if !is_read_only_kubectl_verb(&verb, &args) {
        return Err(AppError::Internal(format!(
            "kubectl {verb} is not allowed from the assistant"
        )));
    }
    if let Some(ctx) = context.filter(|ctx| !ctx.trim().is_empty()) {
        let has_context = args
            .iter()
            .any(|arg| arg == "--context" || arg.starts_with("--context="));
        if !has_context {
            args.insert(0, format!("--context={ctx}"));
        }
    }
    let display_command = std::iter::once(program.to_string())
        .chain(args.iter().map(|arg| quote_arg(arg)))
        .collect::<Vec<_>>()
        .join(" ");

    Ok(ParsedAiCommand {
        program: program.to_string(),
        args,
        display_command,
    })
}

fn shell_split(input: &str) -> AppResult<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = input.trim().chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some('"') if ch == '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if quote.is_some() {
        return Err(AppError::Internal(
            "command contains an unterminated quote".into(),
        ));
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

fn is_shell_operator(token: &str) -> bool {
    matches!(
        token,
        "|" | "||" | "&" | "&&" | ";" | ">" | ">>" | "<" | "<<" | "$(" | "`"
    ) || token.contains("$(")
        || token.contains('`')
}

fn first_kubectl_verb(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !arg.starts_with('-') {
            return Some(arg.to_lowercase());
        }
        if matches!(
            arg.as_str(),
            "--context" | "-n" | "--namespace" | "-o" | "--output"
        ) {
            i += 2;
        } else {
            i += 1;
        }
    }
    None
}

fn is_read_only_kubectl_verb(verb: &str, args: &[String]) -> bool {
    match verb {
        "get" | "describe" | "logs" | "top" | "events" | "explain" | "api-resources"
        | "api-versions" | "version" | "cluster-info" | "auth" | "diff" | "config" => true,
        "rollout" => args.iter().any(|arg| arg == "history" || arg == "status"),
        _ => false,
    }
}

fn quote_arg(arg: &str) -> String {
    if arg.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '=' | ',')
    }) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn provider_status(
    id: &str,
    label: &str,
    command: &str,
    preview: &str,
    models: &[&str],
    default_model: &str,
) -> AiProviderStatus {
    let path = find_on_path(command);
    AiProviderStatus {
        id: id.to_string(),
        label: label.to_string(),
        command: command.to_string(),
        available: path.is_some(),
        path: path.map(|p| p.display().to_string()),
        command_preview: preview.to_string(),
        models: models.iter().map(|m| m.to_string()).collect(),
        default_model: default_model.to_string(),
    }
}

fn chrono_like_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH");
    let fallback_dirs = fallback_executable_dirs();
    find_in_path_or_fallbacks(command, path_var.as_deref(), &fallback_dirs)
}

fn find_in_path_or_fallbacks(
    command: &str,
    path_var: Option<&OsStr>,
    fallback_dirs: &[PathBuf],
) -> Option<PathBuf> {
    for dir in path_var.into_iter().flat_map(env::split_paths) {
        let candidate = dir.join(command);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    for dir in fallback_dirs {
        let candidate = dir.join(command);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn fallback_executable_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
        PathBuf::from("/opt/local/bin"),
    ];
    if let Some(home_dir) = dirs::home_dir() {
        dirs.extend([
            home_dir.join(".volta").join("bin"),
            home_dir.join(".npm-global").join("bin"),
            home_dir.join(".local").join("bin"),
            home_dir.join(".bun").join("bin"),
            home_dir.join(".cargo").join("bin"),
        ]);
    }
    dirs
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_read_only_kubectl_command_with_context() {
        let parsed = parse_ai_command(
            "kubectl get pod -n kafka clinikk-medblocks-streams -o jsonpath='{.spec.containers[*].resources}'",
            Some("kind-lumen-dev"),
        )
        .expect("command should parse");

        assert_eq!(parsed.program, "kubectl");
        assert_eq!(parsed.args[0], "--context=kind-lumen-dev");
        assert!(parsed.args.iter().any(|arg| arg == "get"));
        assert!(parsed
            .args
            .iter()
            .any(|arg| arg == "jsonpath={.spec.containers[*].resources}"));
    }

    #[test]
    fn rejects_mutating_kubectl_command() {
        let err = parse_ai_command("kubectl delete pod api-1", Some("ctx")).unwrap_err();
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn rejects_shell_pipeline() {
        let err = parse_ai_command("kubectl get pods | grep CrashLoop", Some("ctx")).unwrap_err();
        assert!(err.to_string().contains("shell operators"));
    }

    #[test]
    fn finds_cli_in_fallback_dir_when_path_misses_user_install_location() {
        let root = unique_test_dir("lumen-cli-fallback");
        let path_dir = root.join("system-bin");
        let fallback_dir = root.join("home").join(".local").join("bin");
        std::fs::create_dir_all(&path_dir).expect("path dir should be created");
        std::fs::create_dir_all(&fallback_dir).expect("fallback dir should be created");

        let executable = fallback_dir.join("codex");
        std::fs::write(&executable, "#!/bin/sh\n").expect("executable should be written");
        make_executable(&executable);

        let found = find_in_path_or_fallbacks(
            "codex",
            Some(path_dir.as_os_str()),
            std::slice::from_ref(&fallback_dir),
        );

        assert_eq!(found, Some(executable));

        std::fs::remove_dir_all(root).ok();
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}", chrono_like_millis()))
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path)
            .expect("metadata should be readable")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).expect("permissions should be set");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}
}
