import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

/**
 * One of OWASP's equivalent scrypt settings (N=2^15, r=8, p=3): 32 MiB per hash instead of the 128 MiB of
 * N=2^17, so a small instance can check a few logins at once. Stored with each hash, so it can be raised later.
 */
const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 32;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

/** `scrypt$N$r$p$salt$key`, salt and key in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...COST, maxmem: memoryFor(COST) });
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  const expected = Buffer.from(key, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, { ...cost, maxmem: memoryFor(cost) });
  return timingSafeEqual(actual, expected);
}

/** A hash no password matches, checked when the email is unknown so that answering takes as long as for a real one. */
export const UNUSABLE_PASSWORD_HASH = `scrypt$${COST.N}$${COST.r}$${COST.p}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(KEY_LENGTH).toString("base64url")}`;

function memoryFor(cost: { N: number; r: number; p: number }): number {
  // scrypt needs 128 * N * r bytes; node's default cap (32 MiB) is exactly that for COST, so leave headroom.
  return 128 * cost.N * cost.r * 2;
}
