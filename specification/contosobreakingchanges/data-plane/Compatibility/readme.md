# Contoso breaking change demo

This is a non-shipping compatibility fixture, not a proposed Azure service or SDK.
The low-level HTTP shapes and intentionally closed unions isolate compatibility
rules without unrelated service-design lint diagnostics.

```yaml
openapi-type: data-plane
tag: package-2026-10-01
```

## Releases

### Release 2026-06-01

These settings apply only when `--tag=package-2026-06-01` is specified.

```yaml $(tag) == 'package-2026-06-01'
version: "2026-06-01"
input-file:
  - generated/openapi.2026-06-01.yaml
```

### Release 2026-01-01

These settings apply only when `--tag=package-2026-01-01` is specified.

```yaml $(tag) == 'package-2026-01-01'
version: "2026-01-01"
input-file:
  - generated/openapi.2026-01-01.yaml
```

The demo analyzer builds Azure/typespec-azure at the revision pinned in
`.github/workflows/src/typespec-breaking-change-demo/policy.ts`. It runs combined
base/head analysis once, then evaluates the two approval gates independently.
The local entry point is:

```powershell
node .github\workflows\src\typespec-breaking-change-demo\analyze.ts <upstream-root> <base-ref> <report-directory>
```

Both approval families are reviewer-controlled. Regular approval requires a
matching Azure Core approval decorator. Bugfix approval does not require a
decorator. Neither can override compilation or other analysis failures.

These are deliberately non-shipping fixtures: SDK naming/customization and SDK
generation are inapplicable. Their PRs use the same service-scope project discovery,
main-branch core-file policy, protected labels, and required status gates configured
on the integration base branch.

### Release 2026-10-01

These settings apply only when `--tag=package-2026-10-01` is specified.

```yaml $(tag) == 'package-2026-10-01'`
version: "2026-10-01"
input-file:
  - generated/openapi.2026-10-01.yaml
```
