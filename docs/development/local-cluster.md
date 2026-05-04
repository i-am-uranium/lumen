# Local cluster fixture

Use this when validating Lumen against real Kubernetes objects before opening a PR.

Requirements:

- Docker
- kind
- kubectl

Run:

```bash
./scripts/kind-fixture.sh
```

The script creates or reuses `kind-lumen-dev`, applies `testdata/k8s/lumen-fixtures.yaml`, and waits for the demo deployment.

Open Lumen and select:

- context: `kind-lumen-dev`
- namespace: `lumen-demo`

The fixture covers workloads, logs, shell, services, ingress, NetworkPolicy, RBAC, Secrets, PVCs, ResourceQuota, LimitRange, PDB, and HPA.
