# EXOCHAIN HardShell

HardShell is the **environment + operations layer** for EXOCHAIN: reproducible dev/test/staging scaffolding, controlled run wrappers, and evidence bundles (hashes, logs, configs) suitable for audits.

## Design principles
- **Lean + clean:** minimal host assumptions; reproducible toolchains.
- **Slow is smooth:** we prefer explicit checklists and deterministic builds.
- **Two is one:** caching + fallbacks; evidence-by-default.

## Local layout
- `environments/` — environment-specific configs (dev/test/staging)
- `scripts/` — build/run/evidence scripts
- `evidence/` — exported evidence bundles (gitignored by default)

## Today’s scope
- Build EXOCHAIN from source locally (inside our current container)
- Define conventions so we can later migrate to GitHub Actions + org repos cleanly
