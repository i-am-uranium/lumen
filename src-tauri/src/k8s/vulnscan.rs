//! Container-image vulnerability scanning via the user's `trivy` binary.
//!
//! We deliberately keep this as an opt-in shell-out rather than a bundled
//! dependency. Three reasons:
//! 1. Trivy carries its own database (~600MB). Shipping it would inflate
//!    the Lumen bundle 10x and the user already has good install paths
//!    (brew, apt, scoop).
//! 2. Many users already run trivy in CI / on registries — they have
//!    config (private registries, ignore-files) we'd otherwise need to
//!    re-implement.
//! 3. If trivy isn't on PATH, the UI surfaces an install hint and falls
//!    back to "scanner not available" rather than failing loudly.
//!
//! Future iteration can support `grype` as an alternate scanner by
//! abstracting the parser; v1 is trivy-only.
use std::process::Stdio;

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct VulnFinding {
    pub id: String,
    pub package: String,
    pub installed_version: String,
    pub fixed_version: Option<String>,
    pub severity: String,
    pub title: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct VulnSeverityCounts {
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct VulnReport {
    pub image: String,
    /// `true` when trivy ran and produced a result; `false` when the binary
    /// wasn't found or exited non-zero. The UI uses this to surface an
    /// install hint instead of "0 findings".
    pub scanner_available: bool,
    /// Free-form note when scanner_available == false (e.g. "trivy not
    /// installed", "trivy exited 2 — see logs").
    pub note: Option<String>,
    pub counts: VulnSeverityCounts,
    pub findings: Vec<VulnFinding>,
}

/// Quick existence check — returns `true` when `trivy --version` succeeds.
/// Used by the UI to decide whether to render the "Scan" button at all.
pub async fn is_trivy_available() -> bool {
    Command::new("trivy")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

#[derive(Debug, Deserialize)]
struct TrivyOutput {
    #[serde(rename = "Results")]
    results: Option<Vec<TrivyResult>>,
}

#[derive(Debug, Deserialize)]
struct TrivyResult {
    #[serde(rename = "Vulnerabilities")]
    vulnerabilities: Option<Vec<TrivyVuln>>,
}

#[derive(Debug, Deserialize)]
struct TrivyVuln {
    #[serde(rename = "VulnerabilityID")]
    vulnerability_id: String,
    #[serde(rename = "PkgName")]
    pkg_name: Option<String>,
    #[serde(rename = "InstalledVersion")]
    installed_version: Option<String>,
    #[serde(rename = "FixedVersion")]
    fixed_version: Option<String>,
    #[serde(rename = "Severity")]
    severity: Option<String>,
    #[serde(rename = "Title")]
    title: Option<String>,
    #[serde(rename = "Description")]
    description: Option<String>,
}

/// Run `trivy image --format json --quiet <image>` and fold the (verbose)
/// output into a flat per-image report. We pass `--quiet` so trivy doesn't
/// stream progress on stderr — we only care about the final JSON.
pub async fn scan_image(image: &str) -> AppResult<VulnReport> {
    if image.is_empty() {
        return Err(AppError::K8s("image must not be empty".into()));
    }
    if !is_trivy_available().await {
        return Ok(VulnReport {
            image: image.to_string(),
            scanner_available: false,
            note: Some(
                "trivy not detected on PATH — install via brew/apt/scoop to enable image scanning"
                    .into(),
            ),
            counts: VulnSeverityCounts::default(),
            findings: Vec::new(),
        });
    }

    let output = Command::new("trivy")
        .arg("image")
        .arg("--format")
        .arg("json")
        .arg("--quiet")
        .arg(image)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::K8s(format!("spawn trivy: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // Don't bubble as an error — the UI prefers a structured report
        // with a note over a toast.
        return Ok(VulnReport {
            image: image.to_string(),
            scanner_available: false,
            note: Some(format!(
                "trivy exited {} — {}",
                output.status.code().unwrap_or(-1),
                if stderr.is_empty() {
                    "no stderr".to_string()
                } else {
                    stderr
                }
            )),
            counts: VulnSeverityCounts::default(),
            findings: Vec::new(),
        });
    }

    let parsed: TrivyOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Internal(format!("parse trivy output: {e}")))?;

    let mut findings = Vec::new();
    let mut counts = VulnSeverityCounts::default();
    if let Some(results) = parsed.results {
        for r in results {
            for v in r.vulnerabilities.unwrap_or_default() {
                let severity = v
                    .severity
                    .clone()
                    .unwrap_or_else(|| "UNKNOWN".to_string())
                    .to_uppercase();
                match severity.as_str() {
                    "CRITICAL" => counts.critical += 1,
                    "HIGH" => counts.high += 1,
                    "MEDIUM" => counts.medium += 1,
                    "LOW" => counts.low += 1,
                    _ => counts.unknown += 1,
                }
                findings.push(VulnFinding {
                    id: v.vulnerability_id,
                    package: v.pkg_name.unwrap_or_default(),
                    installed_version: v.installed_version.unwrap_or_default(),
                    fixed_version: v.fixed_version,
                    severity,
                    title: v
                        .title
                        .or(v.description)
                        .unwrap_or_else(|| "(no title)".into()),
                });
            }
        }
    }
    // Sort by severity rank (critical first), then by id for stable output.
    findings.sort_by(|a, b| {
        severity_rank(&b.severity)
            .cmp(&severity_rank(&a.severity))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(VulnReport {
        image: image.to_string(),
        scanner_available: true,
        note: None,
        counts,
        findings,
    })
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "CRITICAL" => 4,
        "HIGH" => 3,
        "MEDIUM" => 2,
        "LOW" => 1,
        _ => 0,
    }
}
