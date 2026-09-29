// Single-process entrypoint for hosts that allow only one ArcTick app.
// Set the platform-assigned listener port before loading either service.
process.env.API_PORT = process.env.PORT?.trim() || process.env.API_PORT?.trim() || "8080";
process.env.ARCTICK_EMBEDDED = "true";

// Importing starts the API listener, then the keeper poll loop in this same
// Node process. The keeper retains its PID lock and graceful SIGTERM handling.
await import("./start-api.mjs");
await import("./keeper.ts");
