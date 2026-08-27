import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
};

export function createContext(opts: CreateExpressContextOptions): TrpcContext {
  return { req: opts.req, res: opts.res };
}
