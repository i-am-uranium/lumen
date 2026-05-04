## Summary

## Testing

- [ ] `npm run lint`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`

## Security and UX Checklist

- [ ] No kubeconfig, token, Secret value, or private cluster data is committed.
- [ ] Mutating Kubernetes actions are RBAC-gated and confirmed.
- [ ] Secret values are masked or redacted by default.
- [ ] New UI handles loading, empty, error, and partial-permission states.
- [ ] Large lists/logs/events are bounded or virtualized.
