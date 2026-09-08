# Operator diagnostics

Lumen helps connect an investigation to the evidence and next action. Network
analysis is read-only. Creating a diagnostic container changes the selected pod
and requires the existing context protection and Kubernetes permissions.

## Explain a request path

Open the network debugger, choose source and destination namespaces, then select
the source pod and destination Service, pod, or Ingress. A specific source pod
provides stronger evidence than a selector spanning multiple pods.

Policy results combine source egress and destination ingress. Policies within a
direction are additive; both isolated directions must allow the connection.
Named ports are evaluated on the destination container, and different backend
pods can have different outcomes.

The Gateway evidence section shows listener and route-parent relationships,
conditions, backend references, cross-namespace ReferenceGrants, and available
Service/endpoint information. Basic resource presence is not proof of effective
attachment. Status from the wrong controller or an older generation is not a
current success signal.

Read each result as a configuration explanation:

- **Allowed by model** means the supported configuration checks permit the path.
- **Blocked** identifies a supported configuration or policy failure.
- **Unknown** means Lumen lacks evidence or does not model the relevant behavior.

Permission failures remain separate from empty resource lists. The debugger reads
the explicitly selected source and destination namespaces; a reference into a
third unloaded namespace remains unknown. Gateway controller ownership, route
matches/filters, TLS behavior, CNI enforcement, DNS, and external connectivity
are not verified by this increment. There are no automatic probes or repairs.

## Debug a workload without rebuilding its image

Open a pod's detail drawer and choose its debug action. Review the captured
context, namespace, pod identity, and target container. Choose a diagnostic image
that contains the tools you need and a command that keeps it running. The default
command runs `sleep` for one hour; the terminal executable is configured separately.
The command field accepts a JSON argument array, preserving argument boundaries.

The diagnostic profiles target Linux pods. Both run without privilege escalation, drop capabilities, and use a
non-root user. Restricted also makes the diagnostic root filesystem read-only;
Baseline permits writes to that diagnostic filesystem. Neither profile grants
privileged access to the target container. Admission policies or image contents
may prevent a profile from running; inspect the returned failure before changing
the configuration.

After creation, open the running diagnostic container in the existing terminal.
Target process visibility depends on runtime support and permissions. Sharing
the pod network does not automatically mount the target application's filesystem.

Retry retains the same generated name and configuration, so an uncertain response
does not silently add another container. Refresh status to inspect a waiting,
running, or terminated container. Configuring another container is explicit and
leaves the previous one present. If the pod is replaced, select it again rather
than reusing the old identity.

Ephemeral containers cannot be individually removed or restarted. Closing the
dialog or terminal does not remove them, and closing the dialog does not cancel
an already submitted creation request. A terminated container requires a new
diagnostic container if further debugging is needed. Context protection remains
authoritative for creation and terminal access, including reopened sessions.
Creation uses pod UID and resource-version checks. Terminal opening checks the
UID immediately before exec, but Kubernetes does not provide an atomic UID
precondition for exec; a read-to-exec race cannot be completely eliminated.

## Hand off incident evidence

Open a selected triage investigation. Its related events are verified against the
resource UID when available; events with missing or different UIDs are excluded
from verified evidence rather than associated solely by name.

Choose the container and current or retained previous logs, then explicitly
capture an excerpt. Review the preview, remove irrelevant or sensitive text,
and choose whether to include it when exporting the investigation. Capture is
bounded and does not start a background recording service or upload data.

The report records source context, requested log selection, capture times,
identity limitations, and unavailable or truncated evidence. Edited excerpts are
reviewed material, not an immutable cluster record. Redaction is best effort;
review the output before sharing it with another person.

Pod identity is different from a container runtime instance. Replaced pods are
rejected when detected during capture, but current/previous selection must not be
read as proof of an exact container instance. Kubernetes may have discarded logs
after rotation, restarts, or eviction; Lumen cannot recreate that history. Current
controller snapshots and nearby events also do not establish a rollout cause.

## Validation boundaries

Automated tests cover partial API visibility, policy and Gateway model outcomes,
capture state and bounds, native diagnostic-container requests, and protected
terminal identity. The disposable `scripts/test-kind.sh` fixture additionally
exercises restricted debug creation, retry reuse, UID rejection, and denied
mutation permissions. It creates its own local kubeconfig and cluster.

The kind fixture does not establish NetworkPolicy enforcement by a production
CNI, Gateway controller behavior, or compatibility with every admission policy.
Use the network results to choose the next check in the actual environment.
