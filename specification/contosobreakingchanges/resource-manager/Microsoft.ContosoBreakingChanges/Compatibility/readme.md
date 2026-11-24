# Non-shipping ARM compatibility fixture

This project exercises shared-resource changes and deduplication through standard
ARM resource templates. It is not a service, release, or SDK-generation input.

```yaml
openapi-type: arm
tag: package-2026-06-01
```

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
