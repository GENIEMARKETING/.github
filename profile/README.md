# Vinny Agency

Web design / development / testing platform — a self-learning system that compounds reuse,
guardrails, and retrieval across every client site.

## Platform repos

| Repo | What |
|---|---|
| [`vinny-platform`](https://github.com/GENIEMARKETING/vinny-platform) | Turborepo — `@vinny/ui`, `@vinny/blocks`, foundation, templates |
| [`infrastructure`](https://github.com/GENIEMARKETING/infrastructure) | Shared multi-tenant Strapi + Medusa backend (Lightsail) |
| [`agency-ops`](https://github.com/GENIEMARKETING/agency-ops) | Global graphify graph · mistakes-registry · Mem0/RAGFlow IaC |
| [`.github`](https://github.com/GENIEMARKETING/.github) | Reusable CI + Renovate preset — defined once, applied org-wide |

Client sites stay polyrepo and consume `@vinny/*` packages + the shared backend API.
