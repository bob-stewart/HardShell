# Dev environment

This environment runs EXOCHAIN services locally with:
- state/logs under `run/` and `logs/`
- config under `config/`
- secrets under `secrets/` (gitignored)

## Commands
From HardShell root:
- Start:  `./scripts/service-start.sh`
- Status: `./scripts/service-status.sh`
- Logs:   `./scripts/service-logs.sh`
- Stop:   `./scripts/service-stop.sh`
- Smoke:  `./scripts/service-smoke.sh`

Default binds to localhost (127.0.0.1).
