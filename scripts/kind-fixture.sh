#!/usr/bin/env bash
set -euo pipefail

cluster="${KIND_CLUSTER_NAME:-lumen-dev}"
manifest_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/testdata/k8s"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing dependency: $1" >&2
    exit 1
  fi
}

need kind
need kubectl

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster"
fi

kubectl config use-context "kind-$cluster" >/dev/null
kubectl apply -f "$manifest_dir/lumen-fixtures.yaml"
kubectl wait --for=condition=Available deployment/api -n lumen-demo --timeout=120s

cat <<EOF
kind fixture ready
context: kind-$cluster
namespace: lumen-demo

Run Lumen and select the context above to exercise:
- workloads, logs, shell, delete, YAML apply
- services, ingress, network policy
- RBAC details and security scan findings
- PVC/PV/storage class, quotas, limits, PDB, HPA
EOF
