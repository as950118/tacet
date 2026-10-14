import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openSqlDriver, type SqlDriver } from "../src/index-store/driver.js";
import { AccountError, PlatformAccounts, SESSION_TTL_MS } from "../src/platform/accounts.js";
import { migratePlatform } from "../src/platform/migrations.js";
import { hashPassword, verifyPassword } from "../src/platform/password.js";
import { FailureThrottle } from "../src/platform/throttle.js";

const PASSWORD = "correct horse battery";

describe("passwords", () => {
  it("verifies only the right password, with a fresh salt each time", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("wrong password", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "bcrypt$whatever")).toBe(false);
  });
});

describe("PlatformAccounts", () => {
  let dir: string;
  let db: SqlDriver;
  let now: Date;
  let accounts: PlatformAccounts;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-accounts-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    db = await openSqlDriver(join(dir, `${Date.now()}-${Math.random()}.db`));
    await migratePlatform(db);
    now = new Date("2026-10-14T00:00:00Z");
    accounts = new PlatformAccounts(db, () => now);
    return () => db.close();
  });

  const code = (p: Promise<unknown>) => p.then(() => "ok", (err: AccountError) => err.code);

  it("signs up with a normalized email and logs in", async () => {
    const signedUp = await accounts.signUp({ email: "  Dev@Example.com ", password: PASSWORD, displayName: " Dev " });
    expect(signedUp.user).toMatchObject({ email: "dev@example.com", displayName: "Dev" });
    expect(await accounts.authenticate(signedUp.token)).toEqual(signedUp.user);

    const loggedIn = await accounts.logIn({ email: "DEV@example.com", password: PASSWORD });
    expect(loggedIn.user.id).toBe(signedUp.user.id);
    expect(loggedIn.token).not.toBe(signedUp.token);
  });

  it("stores neither the password nor the session token", async () => {
    const { token } = await accounts.signUp({ email: "a@example.com", password: PASSWORD });
    const dump = JSON.stringify([await db.all("SELECT * FROM users"), await db.all("SELECT * FROM sessions")]);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(token);
  });

  it("rejects bad input, taken emails and wrong credentials alike", async () => {
    await accounts.signUp({ email: "a@example.com", password: PASSWORD });
    expect(await code(accounts.signUp({ email: "not-an-email", password: PASSWORD }))).toBe("invalid-email");
    expect(await code(accounts.signUp({ email: "b@example.com", password: "short" }))).toBe("invalid-password");
    expect(await code(accounts.signUp({ email: "b@example.com", password: "x".repeat(257) }))).toBe("invalid-password");
    expect(await code(accounts.signUp({ email: "A@example.com", password: PASSWORD }))).toBe("email-taken");
    expect(await code(accounts.logIn({ email: "a@example.com", password: "wrong password" }))).toBe("wrong-credentials");
    expect(await code(accounts.logIn({ email: "nobody@example.com", password: PASSWORD }))).toBe("wrong-credentials");
    expect(await code(accounts.logIn({ email: "a@example.com", password: PASSWORD + "x".repeat(300) }))).toBe("wrong-credentials");
  });

  it("expires idle sessions and extends used ones", async () => {
    const { token } = await accounts.signUp({ email: "a@example.com", password: PASSWORD });
    now = new Date(now.getTime() + SESSION_TTL_MS - 1000);
    expect(await accounts.authenticate(token)).not.toBeNull();
    // Used just before expiring, so it lives another full TTL from then.
    now = new Date(now.getTime() + SESSION_TTL_MS - 1000);
    expect(await accounts.authenticate(token)).not.toBeNull();
    now = new Date(now.getTime() + SESSION_TTL_MS);
    expect(await accounts.authenticate(token)).toBeNull();
    expect(await db.all("SELECT * FROM sessions")).toEqual([]);
  });

  it("purges sessions past their expiry and keeps the live ones", async () => {
    const stale = await accounts.signUp({ email: "a@example.com", password: PASSWORD });
    now = new Date(now.getTime() + SESSION_TTL_MS / 2);
    const live = await accounts.logIn({ email: "a@example.com", password: PASSWORD });
    now = new Date(stale.expiresAt);
    expect(await accounts.purgeExpiredSessions()).toBe(1);
    expect(await accounts.purgeExpiredSessions()).toBe(0);
    expect(await accounts.authenticate(live.token)).not.toBeNull();
  });

  it("logs out one session or all of them", async () => {
    const first = await accounts.signUp({ email: "a@example.com", password: PASSWORD });
    const second = await accounts.logIn({ email: "a@example.com", password: PASSWORD });
    await accounts.logOut(first.token);
    expect(await accounts.authenticate(first.token)).toBeNull();
    expect(await accounts.authenticate(second.token)).not.toBeNull();
    await accounts.logOutEverywhere(first.user.id);
    expect(await accounts.authenticate(second.token)).toBeNull();
    expect(await accounts.authenticate("made-up")).toBeNull();
  });
});

describe("FailureThrottle", () => {
  it("blocks a key after the limit until the window passes, and forgets it on success", () => {
    let now = 0;
    const throttle = new FailureThrottle(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) throttle.fail(["ip:1", "email:a"]);
    expect(throttle.retryAfter(["ip:2", "email:a"])).toBe(60);
    now = 30_000;
    expect(throttle.retryAfter(["ip:1"])).toBe(30);
    throttle.succeed(["email:a"]);
    expect(throttle.retryAfter(["email:a"])).toBe(0);
    expect(throttle.retryAfter(["ip:1"])).toBe(30);
    now = 60_001;
    expect(throttle.retryAfter(["ip:1"])).toBe(0);
  });
});
