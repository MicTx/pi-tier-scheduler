# Changelog

User-visible release history for `pi-tier-scheduler`. Dates are omitted until a release is tagged; the compatibility floor of each release is verified against the Pi extension API before shipping.

## 0.4.1 — 2026-10-10

### Changed

- **Elegant live routing surfaces** — the inline route line is now `→ glm-5.3 • high` (reason, attempts, and fallback details stay in the structured record and `/ts status`); the footer composition is `(ts) auto • high → glm-5.3 • high`, updating the moment a route decision lands.
- **Breathing active dot** — while a turn is in flight the footer leads with a size-breathing dot (`˙ · • ● • ·`); it settles back to the static line when the turn ends.

## 0.4.0 — 2026-10-09

### Added

- **Full thinking ladder** — `ts/auto` now exposes every Pi thinking strength (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), and `policy.defaultBias` accepts the same values. `xhigh`/`max` pin the brain tier and pass the deeper strength through, clamped per model.

### Changed

- **Table-form status and doctor output** — `/ts status` ends with a per-tier candidate table (ordered fallback chain rendered as `->`) instead of bare counts; `/ts doctor` renders checks as an aligned `check | status | summary` table.

## 0.3.2 — 2026-10-09

### Fixed

- **Picker shows only credentialed models** — providers without a working key no longer appear in the candidate picker; routing filters them at request time anyway, so offering them was noise. Manual entry remains for pre-configuration.
- **Two-level picker navigation** — pick the provider first, then the model. A flat model list overflowed Pi's select dialog, which does not scroll, hiding lower entries; grouping keeps every dialog short. Already-picked models stay hidden.

## 0.3.1 — 2026-10-09

### Fixed

- **Catalog picking everywhere in the config editor** — `/ts config`'s partial-layer editor and its replacement-list flow now offer the same one-keystroke model picks as `/ts init`; manual entry stays as the explicit fallback.
- **Release test suite is version-dynamic** — staging and README-snippet tests derive the expected tag from `package.json`, so version bumps no longer require test edits.

## 0.3.0 — 2026-10-09

### Added

- **License** — the package is now offered under the PolyForm Noncommercial License 1.0.0; commercial use requires separate written authorization.
- **Bilingual README** — English and 简体中文 versions, linked at the top of each file.
- **One-command git install** — `pi install git:<host>/<owner>/pi-tier-scheduler@<tag>` installs straight from any git remote that can clone the repository, pinned to the tag; documented in the README with a verified install/remove cycle.
- **Public channels** — GitHub mirror at `MicTx/pi-tier-scheduler` and npm publication of `pi-tier-scheduler@0.2.0` (`pi install npm:pi-tier-scheduler`); both verified end to end with isolated install/load/remove cycles.
- **Catalog-driven setup** — `/ts init` and `/ts config` now read the models your Pi install already knows and offer them as one-keystroke picks (context window, reasoning, and credential badges on each row); manual provider/id entry remains as a fallback.

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
