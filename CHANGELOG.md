# Changelog

User-visible release history for `pi-tier-scheduler`. Dates are omitted until a release is tagged; the compatibility floor of each release is verified against the Pi extension API before shipping.

## Unreleased

### Added

- **License** — the package is now offered under the PolyForm Noncommercial License 1.0.0; commercial use requires separate written authorization.
- **Bilingual README** — English and 简体中文 versions, linked at the top of each file.
- **One-command git install** — `pi install git:<host>/<owner>/pi-tier-scheduler@<tag>` installs straight from any git remote that can clone the repository, pinned to the tag; documented in the README with a verified install/remove cycle.

## 0.2.0 — 2026-10-09

Rebrand: `pi-model-switcher` becomes `pi-tier-scheduler`. The rename is identity-wide and breaking; this is a pre-release rename with no migration path.

### Changed

- **Package name** — `pi-tier-scheduler` (was `pi-model-switcher`).
- **Command family** — `/ts` replaces `/ms`: `/ts`, `/ts status`, `/ts use <tier>`, `/ts auto`, `/ts init`, `/ts config`, `/ts doctor`, with `/ts brain` / `/ts pillar` / `/ts crowd` aliases. Same grammar, same completions.
- **Virtual model** — `ts/auto` replaces `ms/auto` (provider namespace `ts`). Sessions pinned to `ms/auto` fall back to the last physical model that answered.
- **Config files** — `tier-scheduler.json` replaces `model-switcher.json` at both layers: `<agent-dir>/tier-scheduler.json` (user) and `.pi/tier-scheduler.json` (project). Schema is unchanged; renaming the file is the only step needed to carry an existing configuration over.
- **Status surfaces** — footer status key and prefix (`ts:auto/<bias>`), command headers (`pi-tier-scheduler status/doctor/configuration`), and the session route-decision entry type (`pi-tier-scheduler.route-decision`). Route-log entries recorded by 0.1.0 sessions render as untyped custom entries after the rename.

## 0.1.0

First release (as `pi-model-switcher`). Dynamic provider, model, and thinking-strength scheduling for Pi sessions through the `ms/auto` virtual model.

### Added

- **`ms/auto` virtual model** — select one model through `/model`, `--model`, or settings; each request is routed deterministically to a physical model by work phase, complexity, and thinking-level bias, with a machine-readable route reason on every decision.
- **Three tiers** — `brain` (planning and hard reasoning), `pillar` (implementation, debugging, refactoring), `crowd` (conversation and light execution), configured as ordered `{ "provider", "id" }` candidate lists in `model-switcher.json`. Built-in candidate lists are empty; users supply their own models.
- **`/ms` command family** — `/ms status`, `/ms use <tier>` with the `/ms brain`, `/ms pillar`, `/ms crowd` aliases, `/ms auto` to release a manual override, `/ms init` guided setup (TUI), `/ms config` to view the effective configuration everywhere and edit it in the TUI, and `/ms doctor` diagnostics. Manual override always wins over automatic routing.
- **Bounded fallback and retries** — failed attempts are classified and recovered inside per-route ceilings (configurable up to hard caps of 5 attempts and 3 tier switches); sticky continuations retain the previous physical model when still eligible. Every route decision is journaled to the session branch and surfaced in `/ms status`.
- **Layered configuration** — user `<agent-dir>/model-switcher.json` and project `.pi/model-switcher.json`, deep-merged over built-in defaults with partial layers, schema-validated with JSON-path errors, and quarantine-recovery of malformed files. Atomic writes with backup on replace.
- **Mode support** — the extension loads and the command family responds in TUI, RPC, JSON, and print modes; interactive configuration flows are TUI-only by design.

### Compatibility

- Verified against the Pi extension API floor **1.0.4**; `/ms doctor` reports the floor. Host packages (`@earendil-works/pi-coding-agent` and its `pi-ai`, `pi-agent-core`, `pi-tui`, `typebox` peers) are consumed as peer dependencies and never bundled.
- Credentials are resolved exclusively by Pi; this package stores, proxies, and logs none.
