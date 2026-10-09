# AGENTS.md

## Project direction

Recon Engine deterministically models the target system so LLMs can reason over it with quality: Source → Facts → ReconState → semantic models (SSEM/ESM) → LLM reasoning (observations → assumptions → hypotheses). Normative: every modeled item is deterministic, provenance-backed, and auditable; anything unprovable is explicit UNKNOWN, never absence — reasoning quality stands or falls on evidence quality. See `RECON_STATE_SPEC.md` §§22–23 and `docs/esm-spec.md` §§1–2. Never build detectors, exploits, or PoCs.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
