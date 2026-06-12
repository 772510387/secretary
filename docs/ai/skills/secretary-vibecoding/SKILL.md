# Secretary Vibecoding Skill

Use this skill when working inside the `secretary` project.

## Purpose

Keep AI-assisted coding aligned with the project's deterministic trading core, auditable memory, and safe AI boundaries.

## Required Reading

Before task work, read:

1. `AGENTS.md`
2. `README.md`
3. `docs/ai/context-map.md`
4. The target module `README.md`

## Rules

- Deterministic trading rules belong in code.
- LLM output is advisory until validated by deterministic policy and risk engines.
- Live trading must remain off by default.
- Do not copy proprietary TradingAgents-CN `app/` or `frontend/` code into this project.
- Do not store API keys or broker credentials in repository files.
- Update module README files when behavior or boundaries change.

## Workflow

1. Identify the target module.
2. Read the module README.
3. State the implementation boundary.
4. Implement the smallest coherent capability.
5. Add or update tests.
6. Run available validation.
7. Update docs if the contract changed.

## High-Risk Areas

- Cash and position calculation.
- T+1 availability.
- Order idempotency.
- Risk checks.
- Memory write permissions.
- Broker adapters.
- Provider credentials.

