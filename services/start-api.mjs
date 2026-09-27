// Kubeletto supplies PORT=8080. Preserve the local API_PORT fallback for
// development, but let the hosting platform's assigned port take precedence.
process.env.API_PORT = process.env.PORT ?? process.env.API_PORT ?? "8080";

await import("./api.ts");
