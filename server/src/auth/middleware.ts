import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { AppError, forbidden } from "../http/errors.js";
import type { Actor, Role } from "./actor.js";

declare module "express-serve-static-core" {
  interface Request { actor?: Actor; requestId?: string; }
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.JWT_SECRET, { algorithm: "HS256", expiresIn: "8h" });
}

/**
 * Verifies the bearer token, then loads the user FRESH from the database: a deactivated user or a changed
 * scope takes effect immediately instead of when the token expires. The token carries only the user id.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError(401, "UNAUTHENTICATED", "Login required");
    let sub: string;
    try {
      const payload = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ["HS256"] });
      if (typeof payload === "string" || typeof payload.sub !== "string") throw new Error("bad payload");
      sub = payload.sub;
    } catch {
      throw new AppError(401, "UNAUTHENTICATED", "Invalid or expired token");
    }
    const [u] = await db.select().from(users).where(eq(users.id, sub)).limit(1);
    if (!u || !u.active) throw new AppError(401, "UNAUTHENTICATED", "Account not available");
    req.actor = { id: u.id, name: u.name, role: u.role as Role, centreId: u.centreId, districtId: u.districtId };
    next();
  } catch (e) {
    next(e);
  }
}

/** Route-level role gate. Object-level (scope) checks happen in the services, next to the data. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor || !roles.includes(req.actor.role)) return next(forbidden("Your role cannot do this"));
    next();
  };
