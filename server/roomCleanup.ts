import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { cleanupExpiredRooms } from "./rooms";

function matchesCleanupSecret(candidate: string | undefined, expected: string | undefined) {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

/** Optional scheduler endpoint; configure CLEANUP_SECRET before exposing it to a cron service. */
export function registerRoomCleanupRoute(app: Express) {
  app.post("/api/scheduled/cleanupRooms", async (req: Request, res: Response) => {
    const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!matchesCleanupSecret(token, process.env.CLEANUP_SECRET)) return res.status(403).json({ error: "forbidden" });
    try {
      const deletedRooms = await cleanupExpiredRooms();
      return res.json({ ok: true, deletedRooms });
    } catch {
      return res.status(503).json({ error: "service_unavailable" });
    }
  });
}
