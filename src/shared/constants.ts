// The only identifiers later phases must reuse (Phase 1 document §4).
// Single source of truth for the package name, the registered command,
// and the virtual-model namespace reserved by Phase 4.

export const PACKAGE_NAME = "pi-tier-scheduler";

/** registerCommand name — the whole /ts family is one command. */
export const COMMAND_NAME = "ts";

/** Virtual-model provider namespace (Phase 4 registers ts/auto). */
export const PROVIDER_NAMESPACE = "ts";

/** Virtual-model id (Phase 4 registers ts/auto). */
export const VIRTUAL_MODEL_ID = "auto";
