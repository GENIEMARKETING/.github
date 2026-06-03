# .github — org-wide CI & config

Define a check once here; it applies to every repo in the org.

## Reusable workflows

### CI — `.github/workflows/ci.yml`
The gate DAG: **typecheck → Biome → Playwright + axe → Lighthouse-CI → gitleaks**.

```yaml
# <site>/.github/workflows/ci.yml
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  ci:
    uses: GENIEMARKETING/.github/.github/workflows/ci.yml@main
    secrets: inherit
```

Inputs: `node-version` (22), `build-command`, `start-command`, `lighthouse-url`,
`run-lighthouse`. The Lighthouse + axe budgets come from `@vinny/foundation`.

### Release — `.github/workflows/release.yml`
Publishes changed `@vinny/*` packages to GitHub Packages on a `v*` tag.

## Renovate

Org preset in `default.json`. Repos opt in:

```json
{ "extends": ["github>GENIEMARKETING/.github"] }
```

Auto-merges `@vinny/*` and security patches once CI is green; majors need review.

## Starter template

`workflow-templates/ci.yml` shows up in the org's **Actions → New workflow** picker so a new
repo wires into the reusable CI in one click.

## Branch protection

Applied per-repo on `main` (PR required + CI status checks). Not an org ruleset, to avoid
touching pre-existing org repos.
