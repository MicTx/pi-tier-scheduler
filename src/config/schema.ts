import {
  MAX_ATTEMPTS_PER_REQUEST,
  MAX_TIER_SWITCHES,
  SCHEMA_VERSION,
} from "./constants";
import type {
  ConfigError,
  ConfigFile,
  EffectiveConfigWithoutProvenance,
} from "./types";

/**
 * Pure schema validators for config layers and merged effective values
 * (02-config.md §4.2/§6.2). No file system, no parsing: `NOT_JSON` is emitted
 * by the discover step (F2.2), never here — these functions only judge
 * already-parsed values.
 *
 * Layer mode ("layer") checks a partial ConfigFile: only `schemaVersion` is
 * required, everything else is optional. Effective mode ("effective") checks
 * the complete merged shape: every required key must be present. Both modes
 * collect every violation, not just the first.
 */

const ROOT_KEYS: readonly string[] = ["schemaVersion", "tiers", "policy", "retry"];
const TIER_NAMES: readonly string[] = ["brain", "pillar", "crowd"];
const THINKING_BIASES: readonly string[] = ["low", "medium", "high"];

/** C0, DEL, and C1 control characters. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const PROVIDER_CHARSET = /^[A-Za-z0-9._-]+$/;

/** Cap on any `received` preview so error text stays short and leak-free. */
const PREVIEW_LIMIT = 60;

type WalkMode = "layer" | "effective";

type WalkContext = {
  source: string;
  mode: WalkMode;
  errors: ConfigError[];
};

function error(
  ctx: WalkContext,
  path: string,
  code: ConfigError["code"],
  message: string,
  expected?: string,
  received?: string,
): void {
  const entry: ConfigError = { source: ctx.source, path, code, message };
  if (expected !== undefined) entry.expected = expected;
  if (received !== undefined) entry.received = received;
  ctx.errors.push(entry);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type label used in `received` when the value is not a scalar. */
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Short, sanitized preview of a scalar for `received`. JSON.stringify escapes
 * control characters (and quotes), so the output never carries raw control
 * bytes; long values are truncated to PREVIEW_LIMIT plus an ellipsis.
 */
function preview(value: unknown): string {
  if (typeof value === "number") {
    // JSON.stringify renders NaN/Infinity as "null"; name them explicitly.
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length > PREVIEW_LIMIT) {
    return `${text.slice(0, PREVIEW_LIMIT)}…`;
  }
  return text;
}

/** `received` for a scalar slot: previews keep JSON/lexical distinctions visible. */
function receivedOf(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return preview(value);
  }
  return typeName(value);
}

function validateRoot(ctx: WalkContext, raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) {
    error(ctx, "", "TYPE_MISMATCH", "config root must be a JSON object", "object", typeName(raw));
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.includes(key)) {
      error(
        ctx,
        key,
        "UNKNOWN_KEY",
        `unknown root key ${JSON.stringify(key)}`,
        "one of schemaVersion, tiers, policy, retry",
      );
    }
  }
  return raw;
}

function validateSchemaVersion(ctx: WalkContext, root: Record<string, unknown>): void {
  if (!("schemaVersion" in root)) {
    error(
      ctx,
      "schemaVersion",
      "SCHEMA_VERSION_MISSING",
      "config must declare schemaVersion",
      `integer ${SCHEMA_VERSION}`,
      "missing",
    );
    return;
  }
  const version = root.schemaVersion;
  if (typeof version !== "number") {
    error(
      ctx,
      "schemaVersion",
      "TYPE_MISMATCH",
      "schemaVersion must be a number",
      `integer ${SCHEMA_VERSION}`,
      receivedOf(version),
    );
    return;
  }
  if (!Number.isInteger(version)) {
    error(
      ctx,
      "schemaVersion",
      "INVALID_VALUE",
      "schemaVersion must be an integer",
      `integer ${SCHEMA_VERSION}`,
      receivedOf(version),
    );
    return;
  }
  if (version !== SCHEMA_VERSION) {
    error(
      ctx,
      "schemaVersion",
      "SCHEMA_VERSION_UNSUPPORTED",
      `config declares schemaVersion ${version}; this release supports schemaVersion ${SCHEMA_VERSION}`,
      `integer ${SCHEMA_VERSION}`,
      receivedOf(version),
    );
  }
}

function validateTiers(ctx: WalkContext, root: Record<string, unknown>): void {
  if (!("tiers" in root)) {
    if (ctx.mode === "effective") {
      error(ctx, "tiers", "TYPE_MISMATCH", "effective config must define tiers", "object", "missing");
    }
    return;
  }
  const tiers = root.tiers;
  if (!isPlainObject(tiers)) {
    error(
      ctx,
      "tiers",
      "TYPE_MISMATCH",
      "tiers must be an object keyed by brain, pillar, or crowd",
      "object",
      typeName(tiers),
    );
    return;
  }
  for (const key of Object.keys(tiers)) {
    if (!TIER_NAMES.includes(key)) {
      error(
        ctx,
        `tiers.${key}`,
        "UNKNOWN_KEY",
        `unknown tier ${JSON.stringify(key)}`,
        "one of brain, pillar, crowd",
      );
    }
  }
  for (const name of TIER_NAMES) {
    const tier = tiers[name];
    if (tier === undefined) {
      if (ctx.mode === "effective") {
        error(
          ctx,
          `tiers.${name}`,
          "TYPE_MISMATCH",
          `effective config must define tier "${name}"`,
          "object",
          "missing",
        );
      }
      continue;
    }
    validateTier(ctx, name, tier);
  }
}

function validateTier(ctx: WalkContext, name: string, tier: unknown): void {
  const path = `tiers.${name}`;
  if (!isPlainObject(tier)) {
    error(ctx, path, "TYPE_MISMATCH", `tier "${name}" must be an object`, "object", typeName(tier));
    return;
  }
  for (const key of Object.keys(tier)) {
    if (key !== "candidates") {
      error(
        ctx,
        `${path}.${key}`,
        "UNKNOWN_KEY",
        `unknown field ${JSON.stringify(key)} in tier "${name}"`,
        "candidates",
      );
    }
  }
  if (!("candidates" in tier)) {
    if (ctx.mode === "effective") {
      error(
        ctx,
        `${path}.candidates`,
        "TYPE_MISMATCH",
        `tier "${name}" must define candidates`,
        "array",
        "missing",
      );
    }
    return;
  }
  validateCandidates(ctx, path, tier.candidates);
}

function validateCandidates(ctx: WalkContext, tierPath: string, candidates: unknown): void {
  const path = `${tierPath}.candidates`;
  if (!Array.isArray(candidates)) {
    error(
      ctx,
      path,
      "TYPE_MISMATCH",
      "candidates must be an array",
      "array",
      typeName(candidates),
    );
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const candidatePath = `${path}[${i}]`;
    const candidate = candidates[i];
    if (!isPlainObject(candidate)) {
      error(
        ctx,
        candidatePath,
        "TYPE_MISMATCH",
        "candidate must be an object with provider and id",
        "object",
        typeName(candidate),
      );
      continue;
    }
    validateCandidate(ctx, candidatePath, candidate, seen);
  }
}

function validateCandidate(
  ctx: WalkContext,
  path: string,
  candidate: Record<string, unknown>,
  seen: Set<string>,
): void {
  for (const key of Object.keys(candidate)) {
    if (key !== "provider" && key !== "id") {
      error(
        ctx,
        `${path}.${key}`,
        "UNKNOWN_KEY",
        `unknown candidate field ${JSON.stringify(key)}`,
        "provider and id",
      );
    }
  }
  const provider = validateCandidateField(ctx, path, candidate, "provider");
  const id = validateCandidateField(ctx, path, candidate, "id");
  // Duplicate tracking only engages when both fields are valid strings, so a
  // broken candidate never shadows or mutes its own field errors.
  if (provider === null || id === null) return;
  const pair = `${provider}/${id}`;
  if (seen.has(pair)) {
    error(
      ctx,
      path,
      "DUPLICATE_CANDIDATE",
      `duplicate candidate ${JSON.stringify(pair)} in this tier`,
      "unique (provider, id) pairs within a tier",
      preview(pair),
    );
    return;
  }
  seen.add(pair);
}

/** Validates one candidate field; returns the string value when valid, else null. */
function validateCandidateField(
  ctx: WalkContext,
  candidatePath: string,
  candidate: Record<string, unknown>,
  field: "provider" | "id",
): string | null {
  const path = `${candidatePath}.${field}`;
  if (!(field in candidate)) {
    error(
      ctx,
      path,
      "TYPE_MISMATCH",
      `candidate must define ${field}`,
      "non-empty string without control characters",
      "missing",
    );
    return null;
  }
  const value = candidate[field];
  if (typeof value !== "string") {
    error(
      ctx,
      path,
      "TYPE_MISMATCH",
      `candidate ${field} must be a string`,
      "non-empty string",
      receivedOf(value),
    );
    return null;
  }
  if (value.length === 0) {
    error(
      ctx,
      path,
      "INVALID_VALUE",
      `candidate ${field} must not be empty`,
      "non-empty string",
      preview(value),
    );
    return null;
  }
  if (CONTROL_CHARS.test(value)) {
    error(
      ctx,
      path,
      "INVALID_VALUE",
      `candidate ${field} must not contain control characters`,
      "string without control characters",
      preview(value),
    );
    return null;
  }
  // Model ids stay opaque; only the provider name carries a charset constraint.
  if (field === "provider" && !PROVIDER_CHARSET.test(value)) {
    error(
      ctx,
      path,
      "INVALID_VALUE",
      "candidate provider must contain only letters, digits, dot, underscore, or hyphen",
      `provider name matching ${PROVIDER_CHARSET}`,
      preview(value),
    );
    return null;
  }
  return value;
}

function validatePolicy(ctx: WalkContext, root: Record<string, unknown>): void {
  if (!("policy" in root)) {
    if (ctx.mode === "effective") {
      error(ctx, "policy", "TYPE_MISMATCH", "effective config must define policy", "object", "missing");
    }
    return;
  }
  const policy = root.policy;
  if (!isPlainObject(policy)) {
    error(ctx, "policy", "TYPE_MISMATCH", "policy must be an object", "object", typeName(policy));
    return;
  }
  for (const key of Object.keys(policy)) {
    if (key !== "defaultBias" && key !== "sticky") {
      error(
        ctx,
        `policy.${key}`,
        "UNKNOWN_KEY",
        `unknown policy key ${JSON.stringify(key)}`,
        "one of defaultBias, sticky",
      );
    }
  }
  if ("defaultBias" in policy) {
    validateBias(ctx, policy.defaultBias);
  } else if (ctx.mode === "effective") {
    error(
      ctx,
      "policy.defaultBias",
      "TYPE_MISMATCH",
      "policy must define defaultBias",
      "one of low, medium, high",
      "missing",
    );
  }
  if ("sticky" in policy) {
    const sticky = policy.sticky;
    if (typeof sticky !== "boolean") {
      error(
        ctx,
        "policy.sticky",
        "TYPE_MISMATCH",
        "sticky must be a boolean",
        "boolean",
        receivedOf(sticky),
      );
    }
  } else if (ctx.mode === "effective") {
    error(
      ctx,
      "policy.sticky",
      "TYPE_MISMATCH",
      "policy must define sticky",
      "boolean",
      "missing",
    );
  }
}

function validateBias(ctx: WalkContext, bias: unknown): void {
  if (typeof bias !== "string") {
    error(
      ctx,
      "policy.defaultBias",
      "TYPE_MISMATCH",
      "defaultBias must be a string",
      "one of low, medium, high",
      receivedOf(bias),
    );
    return;
  }
  if (!THINKING_BIASES.includes(bias)) {
    error(
      ctx,
      "policy.defaultBias",
      "INVALID_VALUE",
      "defaultBias must be one of low, medium, high",
      "one of low, medium, high",
      preview(bias),
    );
  }
}

function validateRetry(ctx: WalkContext, root: Record<string, unknown>): void {
  if (!("retry" in root)) {
    if (ctx.mode === "effective") {
      error(ctx, "retry", "TYPE_MISMATCH", "effective config must define retry", "object", "missing");
    }
    return;
  }
  const retry = root.retry;
  if (!isPlainObject(retry)) {
    error(ctx, "retry", "TYPE_MISMATCH", "retry must be an object", "object", typeName(retry));
    return;
  }
  for (const key of Object.keys(retry)) {
    if (key !== "maxAttemptsPerRequest" && key !== "maxTierSwitches") {
      error(
        ctx,
        `retry.${key}`,
        "UNKNOWN_KEY",
        `unknown retry key ${JSON.stringify(key)}`,
        "one of maxAttemptsPerRequest, maxTierSwitches",
      );
    }
  }
  validateBoundedInteger(ctx, retry, "maxAttemptsPerRequest", 1, MAX_ATTEMPTS_PER_REQUEST);
  validateBoundedInteger(ctx, retry, "maxTierSwitches", 0, MAX_TIER_SWITCHES);
}

function validateBoundedInteger(
  ctx: WalkContext,
  retry: Record<string, unknown>,
  field: "maxAttemptsPerRequest" | "maxTierSwitches",
  min: number,
  max: number,
): void {
  const path = `retry.${field}`;
  const expected = `integer between ${min} and ${max}`;
  if (!(field in retry)) {
    if (ctx.mode === "effective") {
      error(ctx, path, "TYPE_MISMATCH", `retry must define ${field}`, expected, "missing");
    }
    return;
  }
  const value = retry[field];
  if (typeof value !== "number") {
    error(ctx, path, "TYPE_MISMATCH", `${field} must be a number`, expected, receivedOf(value));
    return;
  }
  if (!Number.isInteger(value)) {
    error(ctx, path, "INVALID_VALUE", `${field} must be an integer`, expected, receivedOf(value));
    return;
  }
  if (value < min || value > max) {
    error(ctx, path, "BOUNDS_EXCEEDED", `${field} must be between ${min} and ${max}`, expected, receivedOf(value));
  }
}

function walk(ctx: WalkContext, raw: unknown): void {
  const root = validateRoot(ctx, raw);
  if (root === null) return;
  validateSchemaVersion(ctx, root);
  validateTiers(ctx, root);
  validatePolicy(ctx, root);
  validateRetry(ctx, root);
}

/**
 * Validates a partial config layer as loaded from disk. Only `schemaVersion`
 * is required; absent sections inherit during merge (F2.2). On success the
 * input value is returned as-is — the validator is pure and never rebuilds it.
 */
export function validateConfigLayer(
  raw: unknown,
  source: string,
): { ok: true; value: ConfigFile } | { ok: false; errors: ConfigError[] } {
  const ctx: WalkContext = { source, mode: "layer", errors: [] };
  walk(ctx, raw);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, value: raw as ConfigFile };
}

/**
 * Validates the fully merged configuration shape: every required key of every
 * section must be present. Returns the value without provenance — merge
 * (F2.2) attaches the provenance record.
 */
export function validateEffectiveConfig(
  raw: unknown,
  source: string,
): { ok: true; value: EffectiveConfigWithoutProvenance } | { ok: false; errors: ConfigError[] } {
  const ctx: WalkContext = { source, mode: "effective", errors: [] };
  walk(ctx, raw);
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, value: raw as EffectiveConfigWithoutProvenance };
}
