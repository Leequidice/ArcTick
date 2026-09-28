// Kubeletto supplies PORT=8080. Preserve the local API_PORT fallback for
// development, but let the hosting platform's assigned port take precedence.
process.env.API_PORT = process.env.PORT ?? process.env.API_PORT ?? "8080";

const { app, initializeApi } = await import("./api.ts");
const { pool } = await import("./database.ts");
await initializeApi();
const port = Number(process.env.API_PORT);
const server = app.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ service: "api", action: "listening", port })));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(JSON.stringify({ service: "api", action: "stopping", signal }));
    server.close(() => void pool.end().finally(() => {
      if (process.env.ARCTICK_EMBEDDED !== "true") process.exit(0);
    }));
  });
}
