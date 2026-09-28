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
    // Vercel's rewrite forwards every /api/* request to this single function
    // and places the original path in `path`; remove that routing parameter
    // before handing the request to Express.
    const forwardedPath = req.query.path;
    if (forwardedPath) {
      const segments = Array.isArray(forwardedPath) ? forwardedPath : [forwardedPath];
      const rewritten = new URL(req.url ?? "/", "http://vercel.local");
      rewritten.searchParams.delete("path");
      req.url = `/${segments.join("/")}${rewritten.search}`;
    } else {
      req.url = (req.url ?? "/").replace(/^\/api(?=\/|$)/, "") || "/";
    }
    return app(req, res);
  } catch (error) {
    console.error(JSON.stringify({ service: "api", action: "initialization_failed", error: String(error) }));
    return res.status(503).json({ error: "api_initialization_failed" });
  }
}
