import { getRedisClient } from "../config/redis.js";

const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const keyOf = (key: string) => `login_fail:${key}`;

// All three fail open if Redis is down: the per-IP limiter still applies.
export async function isLocked(key: string): Promise<boolean> {
  const fails = Number(await getRedisClient().get(keyOf(key)).catch(() => 0)) || 0;
  return fails >= MAX_FAILS;
}

export function recordFailure(key: string): void {
  getRedisClient().multi().incr(keyOf(key)).expire(keyOf(key), LOCK_SECONDS).exec().catch(() => {});
}

export function clearFailures(key: string): void {
  getRedisClient().del(keyOf(key)).catch(() => {});
}

// true if the caller may proceed; false while a cooldown for `key` is active. Fails open.
export async function takeCooldown(key: string, seconds: number): Promise<boolean> {
  const r = await getRedisClient().set(`cooldown:${key}`, "1", "EX", seconds, "NX").catch(() => "OK");
  return r === "OK";
}