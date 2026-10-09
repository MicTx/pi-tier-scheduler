/**
 * Public catalog surface (03-catalog.md §6.3): constants, types, snapshotting,
 * and resolution. Later phases (Phase 4 routing, /ts doctor, /ts status)
 * consume the catalog through this barrel only.
 */
export * from "./constants";
export * from "./types";
export * from "./snapshot";
export * from "./resolve";
export * from "./capabilities";
export * from "./policy";
