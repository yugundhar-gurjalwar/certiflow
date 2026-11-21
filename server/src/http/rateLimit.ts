import type { NextFunction, Request, Response } from "express";
import { AppError } from "./errors.js";
import { redis } from "../redis.js";

/** Fixed-window limiter in Redis (shared by all API replicas). Fails OPEN if Redis is down: availability first. */
export function rateLimit(name: string, limit: number, windowS: number, keyOf?: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = keyOf ? keyOf(req) : req.ip ?? "unknown";
      const key = `cf:rl:${name}:${id}:${Math.floor(Date.now() / 1000 / windowS)}`;
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, windowS + 1);
      res.setHeader("RateLimit-Limit", String(limit));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - n)));
      if (n > limit) return next(new AppError(429, "RATE_LIMITED", "Too many requests, slow down"));
    } catch { /* fail open */ }
    next();
  };
}
