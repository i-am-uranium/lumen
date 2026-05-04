# Security Policy

Lumen is a local-first Kubernetes desktop application. Security reports are taken seriously because Lumen can interact with production Kubernetes clusters and sensitive cluster data.

## Supported Versions

Until the first stable release, security fixes are made on `main` and included in the next release.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| `< 1.0.0` releases | Best effort |

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not enabled, contact the maintainer privately and include:

- Affected Lumen version or commit.
- Operating system.
- Kubernetes version and distribution, if relevant.
- Whether the issue requires a malicious cluster, malicious kubeconfig, local user access, or remote network access.
- Steps to reproduce.
- Impact, including whether credentials, secrets, arbitrary command execution, or cluster mutation are involved.

We aim to acknowledge reports within 7 days and provide a remediation plan or status update after triage.

## Security Boundaries

Lumen's v1.0 design goal is local-first:

- It reads kubeconfig from the local machine.
- It talks directly to Kubernetes API servers from the desktop app.
- It does not require a hosted backend or SaaS account.
- It must not send cluster data to external services by default.

## High-Impact Vulnerability Classes

Please report issues involving:

- Credential, token, kubeconfig, or Secret disclosure.
- Cross-site scripting or unsafe rendering of cluster-controlled fields.
- Unintended Kubernetes resource mutation.
- RBAC bypass in the UI or command layer.
- Command injection through kubeconfig, shell, logs, Helm, or plugin-like workflows.
- Local file disclosure beyond explicit user-selected files and kubeconfig resolution.
- Unsafe update, signing, or release artifact behavior.

## Disclosure

Security fixes may be released without full technical details until users have had time to upgrade. Public advisories should include impact, affected versions, fixed versions, and mitigations.
