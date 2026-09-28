import type { Request, Response } from "express";
import app, { initializeApi } from "../services/api.js";

/**
 * Vercel catch-all API function. The frontend calls /api/* on the same
 * origin; strip that prefix before handing the request to the shared Express
 * router. No local files are used for application data.
 */
export default async function handler(req: Request, res: Response) {
  try {
    await initializeApi();
    req.url = (req.url ?? "/").replace(/^\/api(?=\/|$)/, "") || "/";
    return app(req, res);
  } catch (error) {
    console.error(JSON.stringify({ service: "api", action: "initialization_failed", error: String(error) }));
    return res.status(503).json({ error: "api_initialization_failed" });
  }
}
