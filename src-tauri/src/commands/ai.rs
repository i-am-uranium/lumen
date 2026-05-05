use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
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
            let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let mut exit_code = output.status.code();
            if output.status.success() {
                if let Some(filter) = parsed.grep_filter.as_ref() {
                    let filtered = apply_grep_filter(&stdout, filter);
                    stdout = filtered.stdout;
                    exit_code = Some(filtered.exit_code);
                }
            }

            Ok(AiCommandRunResult {
                command: parsed.display_command,
                stdout: truncate_utf8(&stdout, MAX_OUTPUT_BYTES),
                stderr: truncate_utf8(&String::from_utf8_lossy(&output.stderr), MAX_OUTPUT_BYTES),
                exit_code,
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
    grep_filter: Option<GrepFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GrepFilter {
    pattern: String,
    before_context: usize,
    after_context: usize,
    case_insensitive: bool,
    display_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GrepOutput {
    stdout: String,
    exit_code: i32,
}

fn parse_ai_command(command: &str, context: Option<&str>) -> AppResult<ParsedAiCommand> {
    let tokens = shell_split(command)?;
    if tokens.is_empty() {
        return Err(AppError::Internal("command is empty".into()));
    }
    let pipe_index = tokens.iter().position(|token| token == "|");
    let (kubectl_tokens, grep_filter) = if let Some(index) = pipe_index {
        if tokens[index + 1..].iter().any(|token| token == "|") {
            return Err(AppError::Internal(
                "only one safe grep pipeline is supported for assistant-run commands".into(),
            ));
        }
        if index == 0 || index + 1 >= tokens.len() {
            return Err(AppError::Internal(
                "pipeline must contain a kubectl command followed by grep".into(),
            ));
        }
        let left = tokens[..index].to_vec();
        let right = tokens[index + 1..].to_vec();
        if left.iter().any(|token| is_shell_operator(token))
            || right.iter().any(|token| is_shell_operator(token))
        {
            return Err(AppError::Internal(
                "shell operators are not supported for assistant-run commands".into(),
            ));
        }
        (left, Some(parse_safe_grep_filter(&right)?))
    } else {
        if tokens.iter().any(|token| is_shell_operator(token)) {
            return Err(AppError::Internal(
                "shell operators and pipelines are not supported for assistant-run commands".into(),
            ));
        }
        (tokens, None)
    };

    if kubectl_tokens.is_empty() {
        return Err(AppError::Internal("command is empty".into()));
    }

    let program = kubectl_tokens[0]
        .trim_start_matches("`")
        .trim_end_matches("`");
    if program != "kubectl" {
        return Err(AppError::Internal(
            "only kubectl inspection commands can be run from the assistant".into(),
        ));
    }

    let mut args = kubectl_tokens[1..].to_vec();
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
    let display_command = if let Some(filter) = grep_filter.as_ref() {
        format!(
            "{display_command} | grep {}",
            filter
                .display_args
                .iter()
                .map(|arg| quote_arg(arg))
                .collect::<Vec<_>>()
                .join(" ")
        )
    } else {
        display_command
    };

    Ok(ParsedAiCommand {
        program: program.to_string(),
        args,
        display_command,
        grep_filter,
    })
}

fn parse_safe_grep_filter(tokens: &[String]) -> AppResult<GrepFilter> {
    let program = tokens
        .first()
        .map(|token| token.trim_start_matches("`").trim_end_matches("`"))
        .unwrap_or_default();
    if program != "grep" {
        return Err(AppError::Internal(
            "assistant-run pipelines only support grep after kubectl".into(),
        ));
    }

    let mut filter = GrepFilter {
        pattern: String::new(),
        before_context: 0,
        after_context: 0,
        case_insensitive: false,
        display_args: tokens[1..].to_vec(),
    };
    let mut i = 1;
    while i < tokens.len() {
        let token = &tokens[i];
        match token.as_str() {
            "-i" | "--ignore-case" => filter.case_insensitive = true,
            "-F" | "--fixed-strings" => {}
            "-A" | "--after-context" => {
                i += 1;
                filter.after_context = parse_grep_context(tokens.get(i), token)?;
            }
            "-B" | "--before-context" => {
                i += 1;
                filter.before_context = parse_grep_context(tokens.get(i), token)?;
            }
            "-C" | "--context" => {
                i += 1;
                let context = parse_grep_context(tokens.get(i), token)?;
                filter.before_context = context;
                filter.after_context = context;
            }
            "-e" | "--regexp" => {
                i += 1;
                filter.pattern = tokens.get(i).cloned().ok_or_else(|| {
                    AppError::Internal(format!("{token} requires a grep pattern"))
                })?;
            }
            _ if token.starts_with("--after-context=") => {
                filter.after_context = parse_context_value(
                    token.trim_start_matches("--after-context="),
                    "--after-context",
                )?;
            }
            _ if token.starts_with("--before-context=") => {
                filter.before_context = parse_context_value(
                    token.trim_start_matches("--before-context="),
                    "--before-context",
                )?;
            }
            _ if token.starts_with("--context=") => {
                let context =
                    parse_context_value(token.trim_start_matches("--context="), "--context")?;
                filter.before_context = context;
                filter.after_context = context;
            }
            _ if token.starts_with("-A") && token.len() > 2 => {
                filter.after_context = parse_context_value(&token[2..], "-A")?;
            }
            _ if token.starts_with("-B") && token.len() > 2 => {
                filter.before_context = parse_context_value(&token[2..], "-B")?;
            }
            _ if token.starts_with("-C") && token.len() > 2 => {
                let context = parse_context_value(&token[2..], "-C")?;
                filter.before_context = context;
                filter.after_context = context;
            }
            _ if token.starts_with('-') => {
                return Err(AppError::Internal(format!(
                    "grep option {token} is not supported for assistant-run commands"
                )));
            }
            _ => {
                if filter.pattern.is_empty() {
                    filter.pattern = token.clone();
                } else {
                    return Err(AppError::Internal(
                        "assistant-run grep pipelines support one pattern".into(),
                    ));
                }
            }
        }
        i += 1;
    }

    if filter.pattern.is_empty() {
        return Err(AppError::Internal(
            "grep pipeline requires a pattern".into(),
        ));
    }
    Ok(filter)
}

fn parse_grep_context(value: Option<&String>, flag: &str) -> AppResult<usize> {
    parse_context_value(
        value
            .map(String::as_str)
            .ok_or_else(|| AppError::Internal(format!("{flag} requires a context value")))?,
        flag,
    )
}

fn parse_context_value(value: &str, flag: &str) -> AppResult<usize> {
    value.parse::<usize>().map_err(|_| {
        AppError::Internal(format!(
            "{flag} requires a non-negative integer context value"
        ))
    })
}

fn apply_grep_filter(stdout: &str, filter: &GrepFilter) -> GrepOutput {
    let lines: Vec<&str> = stdout.lines().collect();
    let mut selected = BTreeSet::new();
    let pattern = if filter.case_insensitive {
        filter.pattern.to_lowercase()
    } else {
        filter.pattern.clone()
    };

    for (index, line) in lines.iter().enumerate() {
        let haystack = if filter.case_insensitive {
            line.to_lowercase()
        } else {
            (*line).to_string()
        };
        if haystack.contains(&pattern) {
            let start = index.saturating_sub(filter.before_context);
            let end = usize::min(
                lines.len().saturating_sub(1),
                index.saturating_add(filter.after_context),
            );
            for selected_index in start..=end {
                selected.insert(selected_index);
            }
        }
    }

    let stdout = selected
        .iter()
        .map(|index| lines[*index])
        .collect::<Vec<_>>()
        .join("\n");
    GrepOutput {
        stdout: if stdout.is_empty() {
            stdout
        } else {
            format!("{stdout}\n")
        },
        exit_code: if selected.is_empty() { 1 } else { 0 },
    }
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
        | "api-versions" | "version" | "cluster-info" | "diff" => true,
        "auth" => matches!(
            kubectl_subcommand_after_verb(args, "auth").as_deref(),
            Some("can-i" | "whoami")
        ),
        "config" => matches!(
            kubectl_subcommand_after_verb(args, "config").as_deref(),
            Some("view" | "current-context" | "get-contexts")
        ),
        "rollout" => args.iter().any(|arg| arg == "history" || arg == "status"),
        _ => false,
    }
}

fn kubectl_subcommand_after_verb(args: &[String], verb: &str) -> Option<String> {
    let mut found_verb = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with('-') {
            if matches!(
                arg.as_str(),
                "--context" | "-n" | "--namespace" | "-o" | "--output"
            ) {
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if !found_verb {
            found_verb = arg.eq_ignore_ascii_case(verb);
            i += 1;
            continue;
        }
        return Some(arg.to_lowercase());
    }
    None
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
    fn rejects_mutating_kubectl_config_command() {
        let err = parse_ai_command(
            "kubectl config set-context --current --namespace prod",
            Some("ctx"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn allows_read_only_kubectl_config_and_auth_commands() {
        parse_ai_command("kubectl config current-context", Some("ctx"))
            .expect("current-context should be allowed");
        parse_ai_command("kubectl config get-contexts", Some("ctx"))
            .expect("get-contexts should be allowed");
        parse_ai_command("kubectl auth can-i list pods", Some("ctx"))
            .expect("auth can-i should be allowed");
    }

    #[test]
    fn rejects_mutating_kubectl_auth_command() {
        let err = parse_ai_command("kubectl auth reconcile -f rbac.yaml", Some("ctx")).unwrap_err();
        assert!(err.to_string().contains("not allowed"));
    }

    #[test]
    fn parses_read_only_kubectl_command_with_safe_grep_pipeline() {
        let parsed = parse_ai_command(
            "kubectl describe pod metabase-867b759b5b-fg7j8 -n metabase | grep -A 10 'Last State'",
            Some("ctx"),
        )
        .expect("safe grep pipeline should parse");

        assert_eq!(parsed.program, "kubectl");
        assert_eq!(parsed.args[0], "--context=ctx");
        assert!(parsed.args.iter().any(|arg| arg == "describe"));
        assert!(parsed.display_command.contains("| grep -A 10 'Last State'"));
    }

    #[test]
    fn filters_grep_output_with_after_context() {
        let filter = parse_safe_grep_filter(&[
            "grep".to_string(),
            "-A".to_string(),
            "2".to_string(),
            "Last State".to_string(),
        ])
        .expect("grep filter should parse");

        let output = apply_grep_filter(
            "Name: api\nState: Running\nLast State: Terminated\nReason: OOMKilled\nExit Code: 137\nReady: False\n",
            &filter,
        );

        assert_eq!(
            output.stdout,
            "Last State: Terminated\nReason: OOMKilled\nExit Code: 137\n"
        );
        assert_eq!(output.exit_code, 0);
    }

    #[test]
    fn rejects_non_grep_pipeline() {
        let err = parse_ai_command("kubectl get pods | awk '{print $1}'", Some("ctx")).unwrap_err();
        assert!(err.to_string().contains("only support grep"));
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
