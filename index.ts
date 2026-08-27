import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { registerRoomCleanupRoute } from "../roomCleanup";
import { registerRoomRelay } from "../roomRelay";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port += 1) if (await isPortAvailable(port)) return port;
  throw new Error("No available application port.");
}

function applySecurityHeaders(app: express.Express) {
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
      res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    }
    next();
  });
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  applySecurityHeaders(app);
  app.use(express.json({ limit: "50kb" }));
  app.use(express.urlencoded({ limit: "50kb", extended: true }));
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  registerRoomCleanupRoute(app);
  registerRoomRelay(server);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  let port = preferredPort;
  if (process.env.NODE_ENV !== "production" && !(await isPortAvailable(preferredPort))) {
    port = await findAvailablePort(preferredPort);
    console.warn(`Port ${preferredPort} is already in use (likely a stale dev server still running) — falling back to ${port}. Stop the other process and reload at the new port, or free ${preferredPort} and restart.`);
  }
  server.listen(port, () => console.info(`CryptRoom listening on port ${port}`));
}

startServer().catch(() => process.exitCode = 1);
