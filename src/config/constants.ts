/**
 * Schema constants owned by the config module (02-config.md §3.4/§6.1).
 *
 * schema.ts imports these and enforces them during validation; Phase 4 imports the same
 * constants, so the ceilings are enforced at both the config boundary and the router.
 */

/** Config schema version for this release; files declaring any other version are rejected. */
export const SCHEMA_VERSION = 1;

/**
 * Absolute retry ceilings. These are code constants, not values a config file can raise:
 * a file may narrow them (down to the minimum bounds) but never widen them.
 */
export const MAX_ATTEMPTS_PER_REQUEST = 5;
export const MAX_TIER_SWITCHES = 3;
