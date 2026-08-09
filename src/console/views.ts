/**
 * Public console DTO facade.
 *
 * Domain-owned view contracts live under `console/views/`; this module keeps
 * existing imports stable while exposing the explicit console contract.
 */
export * from "./views/errors";
export * from "./views/settings";
export * from "./views/api-keys";
export * from "./views/providers";
export * from "./views/models";
export * from "./views/accounts";
export * from "./views/proxies";
export * from "./views/routing";
export * from "./views/policies";
export * from "./views/telemetry";
export * from "./views/backup";
export * from "./views/transitions";
export * from "./views/bundle";
