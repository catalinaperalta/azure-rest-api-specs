# Contoso breaking change peer

Independent non-shipping fixture used to verify that a failing project is not
overwritten by a clean project's report.

```yaml
openapi-type: data-plane
tag: package-2026-01-01
```

### Release 2026-01-01

These settings apply only when `--tag=package-2026-01-01` is specified.

```yaml $(tag) == 'package-2026-01-01'
version: "2026-01-01"
input-file:
  - generated/openapi.2026-01-01.yaml
```
