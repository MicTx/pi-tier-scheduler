# pi-tier-scheduler

[![npm](https://img.shields.io/npm/v/pi-tier-scheduler)](https://www.npmjs.com/package/pi-tier-scheduler)
[![License: PolyForm-NC-1.0.0](https://img.shields.io/badge/License-PolyForm--NC--1.0.0-blue.svg)](LICENSE)
[![Pi](https://img.shields.io/badge/Pi-1.0.4%2B-5f5fff.svg)](#requirements)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](#requirements)

Tiered model scheduling for the Pi coding agent — one virtual model routes every request across brain/pillar/crowd tiers.

**English** | [简体中文](README.zh-CN.md)

Select one virtual model — `ts/auto` — and the scheduler routes each request to the right physical model for the work at hand: strong models plan and reason, balanced models implement and debug, efficient models handle light work. Routing is deterministic and explainable, manual override is always one command away, and every fallback is bounded.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Tiers and routing](#tiers-and-routing)
- [Commands](#commands)
- [Credentials](#credentials)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)
- [Changelog](#changelog)

## Requirements

- Pi **1.0.4 or newer**. This is the verified compatibility floor: the package is built and tested against the Pi 1.0.4 extension API, and `/ts doctor` reports the floor it was verified against.
- Node **20 or newer** is only needed to run the development checks from a checkout; installing and using the package inside Pi requires no separate Node setup.

## Installation

### From npm (recommended)

The package is published to npm as `pi-tier-scheduler`:

```sh
$ pi install npm:pi-tier-scheduler
```

One command, all of it: the package is resolved from the npm registry, installed under Pi's package directory, and registered for every new Pi session — `pi list` shows it, `pi remove npm:pi-tier-scheduler` uninstalls it. The npm page at [npmjs.com/package/pi-tier-scheduler](https://www.npmjs.com/package/pi-tier-scheduler) mirrors this README and the version history. (Plain `npm install pi-tier-scheduler` only drops the files into a project's `node_modules` — Pi loads packages it installed itself.)

### From GitHub

```sh
$ pi install git:github.com/MicTx/pi-tier-scheduler@v0.2.0
```

The `git:` form works from any git remote you can clone — a company Gitea, your own server, or a fork. Pin with `@<tag>`: package updates reconcile the checkout but never move a pinned ref. Authentication is whatever your git already uses to clone that host; the package itself stores no secrets. `pi remove` takes the same source.

### From a local checkout

The package installs from a local clone as well:

```sh
$ pi install ./
```

Local packages load from the resolved path on your disk — nothing is copied or published. After installing, `pi list` shows `pi-tier-scheduler`, and `pi config` can toggle its resources. Remove it with the same source path from the package root:

```sh
$ pi remove ./
```

To try the package in a single session without installing it:

```sh
$ pi -e ./
```

`pi install ./` makes the package available to every new Pi session on the machine; `pi -e ./` loads it only for that one invocation. Neither command needs credentials: the package stores no secrets and reads no key material (see [Credentials](#credentials)).

## Quick start

Three steps from install to your first routed request:

1. Start Pi in your project and run `/ts init` — the guided wizard (TUI) reads the models your Pi install already knows and lets you pick one per tier, no typing. No wizard available? Copy the complete example from [Configuration](#configuration) instead.
2. Select `ts/auto` as the session model — via `/model`, `--model`, or settings; it appears like any other model.
3. Ask for something. `/ts status` then shows which physical model answered and why.

```sh
$ /ts init
$ /ts status
$ /ts use brain
$ /ts auto
```

The last two commands are the manual escape hatch: `/ts use brain` pins planning work to your strongest tier, `/ts auto` returns to automatic routing.

## Configuration

Configuration is two optional JSON files, both named after the package:

- **User level**: `<agent-dir>/tier-scheduler.json` — by default `~/.pi/agent/tier-scheduler.json`. The agent directory follows Pi's `PI_CODING_AGENT_DIR` override.
- **Project level**: `.pi/tier-scheduler.json` in the working directory of the session. No parent directories are searched.

Layers are deep-merged with the precedence **built-in defaults < user < project**. Every layer is partial: a file may set only the keys it cares about, and the minimal valid file is `{ "schemaVersion": 1 }`. A complete example:

```json
{
  "schemaVersion": 1,
  "tiers": {
    "brain": { "candidates": [{ "provider": "your-provider", "id": "strong-model" }] },
    "pillar": { "candidates": [{ "provider": "your-provider", "id": "balanced-model" }] },
    "crowd": { "candidates": [{ "provider": "your-provider", "id": "fast-model" }] }
  },
  "policy": {
    "defaultBias": "medium",
    "sticky": true
  },
  "retry": {
    "maxAttemptsPerRequest": 3,
    "maxTierSwitches": 2
  }
}
```

- `tiers.<tier>.candidates` is an ordered list of `{ "provider", "id" }` entries. The list is your own model inventory: **example IDs above are illustrative, user-supplied values — the built-in candidate arrays are empty** and routing has nothing to dispatch until you configure at least one candidate.
- `policy.defaultBias` (`low` | `medium` | `high`, default `medium`) is the thinking-strength bias applied when the session has no explicit manual selection.
- `policy.sticky` (default `true`) keeps continuation requests on the previous physical model when it is still eligible, preserving prompt caches.
- `retry.maxAttemptsPerRequest` (default `3`) and `retry.maxTierSwitches` (default `2`) bound recovery walks. These are ceilings you can narrow, not raise: the code enforces hard caps of 5 attempts per request and 3 tier switches per route.

A layer that fails schema validation is reported and skipped — the remaining layers still apply. Malformed JSON is quarantined to a `.corrupt-*` sibling so you can repair it; nothing is silently overwritten.

## Tiers and routing

Three tiers describe what a model is for:

| Tier | Bias level | Intended work |
| --- | --- | --- |
| `brain` | high | Planning, architecture, hard reasoning, cross-cutting analysis |
| `pillar` | medium | Implementation, debugging, refactoring — the workhorse default |
| `crowd` | low | Conversation, light or repetitive execution |

Select `ts/auto` as your session model (via `/model`, `--model`, or settings — it appears like any other model). Before each request, the router decides deterministically, in this order:

1. **Manual override** — `/ts use <tier>` always wins over automatic routing.
2. **Work phase** — the conversation is classified: planning → `brain`, implementation/verification → `pillar`, conversation → `crowd`, unclassifiable → `pillar`.
3. **Complexity** — high-complexity work steps one tier up, low-complexity one tier down.
4. **Thinking bias** — the selected virtual thinking level (or `policy.defaultBias`) nudges the tier the same way.
5. **Candidate selection** — the first eligible candidate in the tier's configured order wins. Eligibility filters for configured-and-credentialed providers and task constraints (image input, reasoning requirements), and the requested thinking strength is clamped to what the physical model supports.

Every decision produces a machine-readable reason (`work_phase`, `complexity_adjustment`, `thinking_bias`, `manual_override`, `manual_override_fallback`, `automatic_fallback`, `direct`); `/ts status` shows the last one.

Fallback is bounded by design. When an attempt fails, the failure is classified and the next alternate is picked from the same tier first, then from the configured fallback order — never an unbounded loop, always inside the attempt and tier-switch ceilings. On a sticky continuation the previous physical model is retained whenever it is still eligible. `ts/auto` always dispatches a **physical** model and never another virtual model. A classifier-based routing refinement is deferred and not part of this release; the deterministic rules above are the shipped contract.

## Commands

One command family, registered as `/ts`:

| Command | Modes | Behavior |
| --- | --- | --- |
| `/ts` or `/ts status` | all | Current selection, last dispatched physical model, active override, last route reason, effective config summary |
| `/ts use <tier>` | all | Manual override to `brain`, `pillar`, or `crowd`; selects `ts/auto` and sets the matching bias level |
| `/ts brain` · `/ts pillar` · `/ts crowd` | all | Short aliases for `/ts use <tier>` |
| `/ts auto` | all | Release the manual override and return to automatic routing |
| `/ts init` | TUI | Guided first-run setup — pick candidates from your installed models |
| `/ts config` | all / TUI | View the effective merged configuration in any mode; **editing is TUI-only** |
| `/ts doctor` | all | Config validity, model availability, credential presence, router-state health, compatibility floor |

Mode behavior: `/ts init` and the editing half of `/ts config` open interactive Pi dialogs and therefore require TUI mode; in RPC, JSON, and print modes they respond with a plain notice and make no changes. Status, override, release, and doctor work identically in every mode with plain text output.

## Credentials

Pi resolves provider credentials through its own mechanisms (its auth store and the provider environment conventions). This package **never stores, writes, proxies, or logs credentials** — it only asks Pi whether a provider is configured. Configure your keys exactly as you already do for Pi; nothing extra is needed for the scheduler.

## Troubleshooting

- **Doctor reports missing credentials** — the provider of a configured candidate has no key in Pi. Add the credential the way Pi expects; the scheduler has no separate key store. Doctor never prints credential values.
- **`no_eligible_physical_model` or empty tier in status** — a tier's candidates are absent, misnamed, or none of them is currently available (provider not credentialed or model not in the catalog). Check spelling of `provider`/`id` pairs against the models Pi lists, and check `/ts doctor` for per-provider auth status.
- **Config problems reported at load** — a schema-invalid layer is skipped with a JSON-path error pointing at the offending key; other layers still apply. Fix the reported key; only the malformed-file (not-schema) case produces a `.corrupt-*` quarantine copy.
- **Malformed JSON** — if a config file cannot be parsed, the original bytes are preserved as a `.corrupt-*` sibling next to it and the file is treated as absent. Repair or delete the sibling; the scheduler never discards it silently.
- **Context overflow on a route** — the failure classifier marks it and the retry walk prefers a compatible larger-capacity candidate within the tier bounds; if ceilings are exhausted the request ends with a bounded error rather than looping.
- **Retry ceiling hit (`route_limit_exceeded`)** — the bounded walk stopped after `maxAttemptsPerRequest` attempts or `maxTierSwitches` tier moves. Lowering per-candidate duplication, adding a healthy candidate to the tier, or narrowing the retry values in config changes the walk; raising them past the hard caps (5 / 3) is not possible.
- **Commands respond but dialogs do not appear** — you are in RPC, JSON, or print mode. `/ts init` and `/ts config` editing are TUI-only by design; every other subcommand works in all modes.
- **Extension fails to load after a Pi upgrade** — the compatibility floor is Pi 1.0.4. Run `/ts doctor` (its version check reports the floor); on a newer host with drift, re-verification is required before use — see the changelog for the floor this release was verified against.

## Development

From a checkout:

```sh
$ npm install
$ npm run typecheck
$ npm test
$ npm run test:release
$ npm run test:coverage
```

Run them from the package root of your checkout.

`test:release` runs typecheck plus the full suite — the release gate. The test suite is deterministic and hermetic: fake model registries and in-memory providers, a failure-injection corpus, and config/routing/command/mode matrices. Verification makes **no real network calls and uses no real credentials**.

## Contributing

Issues and pull requests are welcome at [MicTx/pi-tier-scheduler](https://github.com/MicTx/pi-tier-scheduler). By submitting a pull request you agree your contribution is licensed under the repository's [PolyForm Noncommercial 1.0.0](LICENSE) terms.

## License

Released under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal, research, educational, and other noncommercial use is free; **commercial use requires separate written authorization** from the author.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history and the compatibility floor of each release.
