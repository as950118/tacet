import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlDriver } from "../index-store/driver.js";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, UNUSABLE_PASSWORD_HASH, verifyPassword } from "./password.js";

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface Session {
  /** Shown to the client once; only its hash is stored. */
  token: string;
  expiresAt: string;
  user: User;
}

/** A sign-up or login the caller should answer with 4xx; `code` says which. */
export class AccountError extends Error {
  constructor(
    readonly code: "invalid-email" | "invalid-password" | "email-taken" | "wrong-credentials",
    message: string,
  ) {
    super(message);
  }
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session used again after this long gets a fresh expiry (sliding expiration), at most one write per this interval. */
const SESSION_TOUCH_MS = 60 * 60 * 1000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

/** Users and their login sessions (ADR-0002), over the account tables made by `migratePlatform`. */
export class PlatformAccounts {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async signUp(input: { email: string; password: string; displayName?: string }): Promise<Session> {
    const email = normalizeEmail(input.email);
    checkPassword(input.password);
    const displayName = input.displayName?.trim().slice(0, 100) || null;
    const passwordHash = await hashPassword(input.password);
    const user: User = { id: randomUUID(), email, displayName, createdAt: this.now().toISOString() };
    try {
      await this.db.run("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)", [
        user.id,
        user.email,
        passwordHash,
        user.displayName,
        user.createdAt,
      ]);
    } catch (err) {
      if (await this.userByEmail(email)) throw new AccountError("email-taken", "An account with this email already exists");
      throw err;
    }
    return this.startSession(user);
  }

  /** Throws `wrong-credentials` for an unknown email and a wrong password alike, after the same amount of work. */
  async logIn(input: { email: string; password: string }): Promise<Session> {
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const row = email ? await this.userByEmail(email) : undefined;
    // No stored password is longer than the maximum, so a longer one fails (without hashing megabytes).
    const usable = typeof input.password === "string" && input.password.length <= PASSWORD_MAX_LENGTH;
    const password = usable ? (input.password as string) : "";
    const ok = (await verifyPassword(password, (usable && row?.password_hash) || UNUSABLE_PASSWORD_HASH)) && usable;
    if (!row || !ok) throw new AccountError("wrong-credentials", "Wrong email or password");
    return this.startSession(toUser(row));
  }

  /** The user a session token belongs to, or null when it is unknown or expired. Extends the session when due. */
  async authenticate(token: string): Promise<User | null> {
    const rows = await this.db.all<UserRow & { expires_at: string; last_used_at: string; token_hash: string }>(
      `SELECT u.id, u.email, u.display_name, u.created_at, s.expires_at, s.last_used_at, s.token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      [tokenHash(token)],
    );
    const row = rows[0];
    const now = this.now();
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime()) {
      await this.db.run("DELETE FROM sessions WHERE token_hash = ?", [row.token_hash]);
      return null;
    }
    if (now.getTime() - Date.parse(row.last_used_at) >= SESSION_TOUCH_MS) {
      await this.db.run("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?", [
        now.toISOString(),
        new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        row.token_hash,
      ]);
    }
    return toUser(row);
  }

  async logOut(token: string): Promise<void> {
    await this.db.run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
  }

  /** Ends every session of a user, e.g. after a password change. */
  async logOutEverywhere(userId: string): Promise<void> {
    await this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  }

  /**
   * Deletes the sessions past their expiry. `authenticate` drops an expired session when it is shown again, but most
   * never are (the browser was closed); this keeps them from piling up. Returns how many were deleted.
   */
  async purgeExpiredSessions(): Promise<number> {
    const expired = await this.db.all<{ n: number | string }>("SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ?", [
      this.now().toISOString(),
    ]);
    const count = Number(expired[0]?.n ?? 0);
    if (count) await this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [this.now().toISOString()]);
    return count;
  }

  private async userByEmail(email: string): Promise<(UserRow & { password_hash: string }) | undefined> {
    return (
      await this.db.all<UserRow & { password_hash: string }>(
        "SELECT id, email, display_name, created_at, password_hash FROM users WHERE email = ?",
        [email],
      )
    )[0];
  }

  private async startSession(user: User): Promise<Session> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    await this.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)", [
      tokenHash(token),
      user.id,
      now.toISOString(),
      expiresAt,
      now.toISOString(),
    ]);
    return { token, expiresAt, user };
  }
}

export function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) throw new AccountError("invalid-email", "Enter a valid email address");
  return email;
}

function checkPassword(value: unknown): void {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new AccountError(
      "invalid-password",
      `The password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long`,
    );
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
}
