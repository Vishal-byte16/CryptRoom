import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "./_core/trpc";
import { closeBurnedRoomSockets } from "./roomRelay";
import { beginRoomJoin, burnRoom, completeRoomJoin, createRoom, getRequestIp, getRoomSnapshot, leaveRoom } from "./rooms";

const roomCredentials = z.object({ roomId: z.string().min(1).max(20), guestToken: z.string().min(32).max(128) });
const roomIdInput = z.object({ roomId: z.string().min(1).max(20) });

function roomError(error: unknown): never {
  const message = error instanceof Error ? error.message : "The room request could not be completed.";
  const code = message.includes("Too many") ? "TOO_MANY_REQUESTS" : "BAD_REQUEST";
  throw new TRPCError({ code, message });
}

export const appRouter = router({
  room: router({
    create: publicProcedure.input(z.object({ secretVerifier: z.string().length(43) })).mutation(async ({ ctx, input }) => {
      try { return await createRoom(getRequestIp(ctx.req.headers, ctx.req.ip), input.secretVerifier); } catch (error) { return roomError(error); }
    }),
    beginJoin: publicProcedure.input(roomIdInput).mutation(async ({ ctx, input }) => {
      try { return await beginRoomJoin(input.roomId, getRequestIp(ctx.req.headers, ctx.req.ip)); } catch (error) { return roomError(error); }
    }),
    completeJoin: publicProcedure.input(z.object({ roomId: z.string().min(1).max(20), challengeId: z.string().length(32), proof: z.string().length(43) })).mutation(async ({ ctx, input }) => {
      try { return await completeRoomJoin(input.roomId, input.challengeId, input.proof, getRequestIp(ctx.req.headers, ctx.req.ip)); } catch (error) { return roomError(error); }
    }),
    status: publicProcedure.input(roomCredentials).query(async ({ input }) => {
      try { return await getRoomSnapshot(input.roomId, input.guestToken); } catch (error) { return roomError(error); }
    }),
    leave: publicProcedure.input(roomCredentials).mutation(async ({ input }) => {
      try { return await leaveRoom(input.roomId, input.guestToken); } catch (error) { return roomError(error); }
    }),
    burn: publicProcedure.input(roomCredentials).mutation(async ({ input }) => {
      try {
        const result = await burnRoom(input.roomId, input.guestToken);
        closeBurnedRoomSockets(result.roomId);
        return result;
      } catch (error) { return roomError(error); }
    }),
  }),
});

export type AppRouter = typeof appRouter;
