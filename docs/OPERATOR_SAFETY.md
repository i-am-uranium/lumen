# Protected contexts and kubeconfig sources

## Protect a context

Open a cluster workspace and choose **Protect context** in its protection bar.
Protection applies to every pane using that context, while other contexts keep
their own settings. Choosing protection is explicit; a production-like name
alone does not enable it.

To make changes, choose **Unlock for 10 minutes** and type the context name.
The bar shows the remaining time. **Lock now** ends the grant early. Removing
protection permanently requires a separate confirmation. Restarting Lumen
preserves protection and discards temporary unlocks.

Protected contexts remain available for browsing, logs, and dry-run previews.
Native commands enforce protection for workload and node changes, YAML apply,
Helm changes, Argo actions, Tekton cancellation, RBAC/token operations, and pod
shells. An existing shell cannot retain write access after its grant expires or
the context is locked. The global read-only setting continues to take precedence
in the interface.

Confirmations identify their target context, namespace and resource. Changing
the owning target invalidates pending confirmation. Permission checks and
execution use the same captured cluster configuration; changing a context's
effective configuration invalidates its temporary unlock.

The unlock controls when new operations may start. It does not roll back an
operation already submitted to Kubernetes. Kubernetes RBAC remains authoritative.
If Lumen cannot read or save protection settings, it blocks changes and reports
the storage problem instead of silently allowing them.

## Use multiple kubeconfig files

Configure `KUBECONFIG` in the environment used to launch Lumen. Separate file
paths with `:` on macOS/Linux or `;` on Windows. Without an override, Lumen uses
the standard home-directory `.kube/config` file. Desktop launchers may have a
different environment from a terminal.

Files are considered in order. The first definition of a context, cluster or
user wins as a whole; credentials from later duplicate definitions are not
combined with it. Relative certificate, key and token paths are resolved against
the file that supplied that definition. Missing files are skipped; an existing
invalid file produces a source-specific configuration error.

Connection diagnostics show source paths and definition provenance without
showing credentials or executing credential tools. This helps explain which
definition is active when files contain duplicate names.

Deleting a context changes its owning source, not a flattened merged file.
Definitions still referenced by other contexts are retained. Restoration uses
the original source recorded in the backup. Resolve duplicate context names
before deleting an ambiguous context; Lumen rejects that operation to avoid
unexpectedly revealing a different context with the same name.

Reading a source through a symbolic link is supported, with relative references
resolved beside the link. Deleting or restoring through a symbolic link is
rejected; edit the original configuration file directly in that case.

Cached clients are refreshed when their configuration sources change. Editing
source files does not carry an existing protected-context unlock onto a different
effective cluster configuration.
