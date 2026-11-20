# Non-shipping ARM compatibility fixture

This project exercises shared-resource changes and deduplication through standard
ARM resource templates. It is not a service, release, or SDK-generation input.

```yaml
input-file:
  - generated/openapi.2026-01-01.yaml
  - generated/openapi.2026-06-01.yaml
  - generated/openapi.2026-10-01.yaml
```
