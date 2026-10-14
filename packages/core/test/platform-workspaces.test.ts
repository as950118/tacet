import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openSqlDriver, type SqlDriver } from "../src/index-store/driver.js";
import { PlatformAccounts, type User } from "../src/platform/accounts.js";
import { migratePlatform, type WorkspaceRole } from "../src/platform/migrations.js";
import { INVITE_TTL_MS, PlatformWorkspaces, slugify, WorkspaceError } from "../src/platform/workspaces.js";

const PASSWORD = "correct horse battery";

/** PostgreSQL runs too when a server is given, e.g. TACET_TEST_POSTGRES_URL=postgres://tacet:tacet@localhost:55432/tacet */
const postgresUrl = process.env.TACET_TEST_POSTGRES_URL;
const schema = `tacet_workspaces_test_${process.pid}_${Date.now()}`;
let run = 0;
const backends: Array<{ name: string; location: (dir: string) => string }> = [
  { name: "SQLite", location: (dir) => join(dir, `index-${++run}.db`) },
  ...(postgresUrl
    ? [{ name: "PostgreSQL", location: () => `${postgresUrl}${postgresUrl.includes("?") ? "&" : "?"}schema=${schema}_${++run}` }]
    : []),
];

afterAll(async () => {
  if (!postgresUrl) return;
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  for (let i = 1; i <= run; i++) await client.query(`DROP SCHEMA IF EXISTS ${schema}_${i} CASCADE`);
  await client.end();
});

describe("slugify", () => {
  it("makes a valid slug of any text", () => {
    expect(slugify("Dev's Team!")).toBe("dev-s-team");
    expect(slugify("ab")).toBe("ab-ws");
    expect(slugify("+++")).toBe("workspace");
    expect(slugify("x".repeat(60))).toHaveLength(40);
  });
});

describe.each(backends)("PlatformWorkspaces on $name", ({ location }) => {
  let dir: string;
  let db: SqlDriver;
  let now: Date;
  let workspaces: PlatformWorkspaces;
  let accounts: PlatformAccounts;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tacet-workspaces-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    db = await openSqlDriver(location(dir));
    await migratePlatform(db);
    now = new Date("2026-10-14T00:00:00Z");
    workspaces = new PlatformWorkspaces(db, () => now);
    accounts = new PlatformAccounts(db, () => now, { onSignUp: (user, tx) => workspaces.createPersonal(user, tx) });
    return () => db.close();
  });

  const signUp = async (email: string, displayName?: string): Promise<User> =>
    (await accounts.signUp({ email, password: PASSWORD, displayName })).user;
  const code = (p: Promise<unknown>) => p.then(() => "ok", (err: WorkspaceError) => err.code ?? String(err));

  /** A team workspace owned by `owner`, with one member per role given. */
  const team = async (owner: User, members: Partial<Record<WorkspaceRole, User>> = {}) => {
    const ws = await workspaces.create(owner.id, { name: "Team", slug: "team" });
    for (const [role, user] of Object.entries(members) as Array<[WorkspaceRole, User]>) {
      const { token } = await workspaces.createInvite(owner.id, "team", { email: user.email, role });
      await workspaces.acceptInvite(user.id, token);
    }
    return ws;
  };

  it("gives every new user a personal workspace they own, with a unique slug", async () => {
    const dev = await signUp("dev@example.com", "Dev");
    expect(await workspaces.listMine(dev.id)).toEqual([expect.objectContaining({ slug: "dev", name: "Dev", role: "owner" })]);
    const other = await signUp("dev@other.example");
    const [personal] = await workspaces.listMine(other.id);
    expect(personal).toMatchObject({ name: "dev", role: "owner" });
    expect(personal.slug).toMatch(/^dev-[0-9a-f]{4}$/);
  });

  it("creates neither the account nor the workspace when either fails", async () => {
    const failing = new PlatformAccounts(db, () => now, {
      onSignUp: async () => {
        throw new Error("boom");
      },
    });
    await expect(failing.signUp({ email: "a@example.com", password: PASSWORD })).rejects.toThrow("boom");
    expect(await db.all("SELECT * FROM users")).toEqual([]);
    expect(await db.all("SELECT * FROM workspaces")).toEqual([]);
  });

  it("creates, renames and deletes workspaces with valid, unique slugs", async () => {
    const owner = await signUp("owner@example.com");
    expect(await workspaces.create(owner.id, { name: "  Acme Web  " })).toMatchObject({ slug: "acme-web", name: "Acme Web", role: "owner" });
    expect(await code(workspaces.create(owner.id, { name: "Again", slug: "acme-web" }))).toBe("slug-taken");
    for (const slug of ["ab", "Acme", "-acme", "acme-", "a_b", "x".repeat(41)]) {
      expect(await code(workspaces.create(owner.id, { name: "Bad", slug }))).toBe("invalid-slug");
    }
    expect(await code(workspaces.create(owner.id, { name: "  " }))).toBe("invalid-name");

    expect(await workspaces.update(owner.id, "acme-web", { name: "Acme", slug: "acme" })).toMatchObject({ slug: "acme", name: "Acme" });
    expect(await code(workspaces.get(owner.id, "acme-web"))).toBe("not-found");
    expect(await code(workspaces.update(owner.id, "acme", { slug: "owner" }))).toBe("slug-taken");
    await workspaces.delete(owner.id, "acme");
    expect((await workspaces.listMine(owner.id)).map((w) => w.slug)).toEqual(["owner"]);
  });

  it("hides a workspace from non-members as not-found", async () => {
    const owner = await signUp("owner@example.com");
    const stranger = await signUp("stranger@example.com");
    await team(owner);
    for (const attempt of [
      () => workspaces.get(stranger.id, "team"),
      () => workspaces.members(stranger.id, "team"),
      () => workspaces.update(stranger.id, "team", { name: "Mine" }),
      () => workspaces.delete(stranger.id, "team"),
      () => workspaces.createInvite(stranger.id, "team", { email: "x@example.com", role: "viewer" }),
      () => workspaces.leave(stranger.id, "team"),
    ]) {
      expect(await code(attempt())).toBe("not-found");
    }
    expect(await code(workspaces.get(owner.id, "no-such-team"))).toBe("not-found");
  });

  it("enforces the role matrix", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUp("admin@example.com");
    const member = await signUp("member@example.com");
    const viewer = await signUp("viewer@example.com");
    await team(owner, { admin, member, viewer });
    const invite = (actor: User, role: WorkspaceRole) => code(workspaces.createInvite(actor.id, "team", { email: `new-${role}@example.com`, role }));

    // Everyone reads.
    for (const user of [owner, admin, member, viewer]) expect((await workspaces.members(user.id, "team")).length).toBe(4);
    // Only admins and owners manage, and admins only below themselves.
    expect(await invite(viewer, "viewer")).toBe("forbidden");
    expect(await invite(member, "viewer")).toBe("forbidden");
    expect(await invite(admin, "member")).toBe("ok");
    expect(await invite(admin, "admin")).toBe("forbidden");
    expect(await invite(owner, "owner")).toBe("ok");
    expect(await code(workspaces.invites(member.id, "team"))).toBe("forbidden");
    expect(await code(workspaces.update(member.id, "team", { name: "X" }))).toBe("forbidden");
    expect(await code(workspaces.update(admin.id, "team", { name: "Renamed" }))).toBe("ok");

    expect(await code(workspaces.setRole(member.id, "team", viewer.id, "member"))).toBe("forbidden");
    expect(await code(workspaces.setRole(admin.id, "team", viewer.id, "member"))).toBe("ok");
    expect(await code(workspaces.setRole(admin.id, "team", viewer.id, "admin"))).toBe("forbidden");
    expect(await code(workspaces.setRole(admin.id, "team", owner.id, "member"))).toBe("forbidden");
    expect(await code(workspaces.setRole(admin.id, "team", viewer.id, "boss" as WorkspaceRole))).toBe("invalid-role");
    expect(await code(workspaces.removeMember(member.id, "team", viewer.id))).toBe("forbidden");
    expect(await code(workspaces.removeMember(admin.id, "team", viewer.id))).toBe("ok");

    expect(await code(workspaces.delete(admin.id, "team"))).toBe("forbidden");
    expect(await code(workspaces.transferOwnership(admin.id, "team", member.id))).toBe("forbidden");
    expect(await code(workspaces.setRole(owner.id, "team", admin.id, "owner"))).toBe("ok");
    expect(await code(workspaces.removeMember(owner.id, "team", admin.id))).toBe("ok");
    expect(await code(workspaces.removeMember(owner.id, "team", randomUUID()))).toBe("not-found");
    expect(await code(workspaces.delete(owner.id, "team"))).toBe("ok");
  });

  it("never removes, demotes or lets go of the last owner", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUp("admin@example.com");
    await team(owner, { admin });
    expect(await code(workspaces.setRole(owner.id, "team", owner.id, "admin"))).toBe("last-owner");
    expect(await code(workspaces.leave(owner.id, "team"))).toBe("last-owner");
    expect(await code(workspaces.removeMember(owner.id, "team", owner.id))).toBe("last-owner");

    // Transfer: the admin becomes owner and the old owner admin, so now the old owner can leave.
    const members = await workspaces.transferOwnership(owner.id, "team", admin.id);
    expect(Object.fromEntries(members.map((m) => [m.email, m.role]))).toEqual({ "owner@example.com": "admin", "admin@example.com": "owner" });
    expect(await code(workspaces.setRole(admin.id, "team", admin.id, "member"))).toBe("last-owner");
    expect(await code(workspaces.leave(owner.id, "team"))).toBe("ok");
    expect(await code(workspaces.get(owner.id, "team"))).toBe("not-found");

    // Two owners demoting each other at once: the second to run is no longer an owner, so one of them stays owner.
    const second = await signUp("second@example.com");
    const { token } = await workspaces.createInvite(admin.id, "team", { email: second.email, role: "owner" });
    await workspaces.acceptInvite(second.id, token);
    const results = await Promise.all([
      code(workspaces.setRole(admin.id, "team", second.id, "member")),
      code(workspaces.setRole(second.id, "team", admin.id, "member")),
    ]);
    expect(results.sort()).toEqual(["forbidden", "ok"]);
    expect((await workspaces.members(admin.id, "team")).filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("accepts an invite once, before it expires, by its token whatever the email", async () => {
    const owner = await signUp("owner@example.com");
    const joiner = await signUp("someone-else@example.com");
    await team(owner);
    const invite = await workspaces.createInvite(owner.id, "team", { email: " Invited@Example.com ", role: "member" });
    expect(invite).toMatchObject({ email: "invited@example.com", role: "member", token: expect.any(String) });
    expect(Date.parse(invite.expiresAt) - now.getTime()).toBe(INVITE_TTL_MS);
    expect(JSON.stringify(await db.all("SELECT * FROM workspace_invites"))).not.toContain(invite.token);
    expect((await workspaces.invites(owner.id, "team")).map((i) => i.id)).toEqual([invite.id]);

    expect(await workspaces.acceptInvite(joiner.id, invite.token)).toMatchObject({ slug: "team", role: "member" });
    const [row] = await db.all<{ accepted_by: string }>("SELECT accepted_by FROM workspace_invites WHERE id = ?", [invite.id]);
    expect(row.accepted_by).toBe(joiner.id);
    expect(await code(workspaces.acceptInvite(joiner.id, invite.token))).toBe("invite-used");
    expect(await workspaces.invites(owner.id, "team")).toEqual([]);

    const late = await workspaces.createInvite(owner.id, "team", { email: "late@example.com", role: "viewer" });
    now = new Date(now.getTime() + INVITE_TTL_MS);
    expect(await code(workspaces.acceptInvite(joiner.id, late.token))).toBe("invite-expired");
    expect(await code(workspaces.acceptInvite(joiner.id, "made-up"))).toBe("invite-not-found");
  });

  it("revokes invites, replaces a pending one on re-invite, and refuses current members", async () => {
    const owner = await signUp("owner@example.com");
    const joiner = await signUp("joiner@example.com");
    await team(owner);
    const first = await workspaces.createInvite(owner.id, "team", { email: "joiner@example.com", role: "viewer" });
    const second = await workspaces.createInvite(owner.id, "team", { email: "joiner@example.com", role: "member" });
    expect(await code(workspaces.acceptInvite(joiner.id, first.token))).toBe("invite-not-found");

    await workspaces.revokeInvite(owner.id, "team", second.id);
    expect(await code(workspaces.acceptInvite(joiner.id, second.token))).toBe("invite-not-found");
    expect(await code(workspaces.revokeInvite(owner.id, "team", second.id))).toBe("not-found");

    const third = await workspaces.createInvite(owner.id, "team", { email: "joiner@example.com", role: "member" });
    await workspaces.acceptInvite(joiner.id, third.token);
    expect(await code(workspaces.createInvite(owner.id, "team", { email: "joiner@example.com", role: "admin" }))).toBe("already-member");
  });

  it("never downgrades a member who accepts an invite, and upgrades one invited higher", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUp("admin@example.com");
    await team(owner, { admin });
    const lower = await workspaces.createInvite(owner.id, "team", { email: "other@example.com", role: "viewer" });
    expect(await workspaces.acceptInvite(admin.id, lower.token)).toMatchObject({ role: "admin" });
    expect(await workspaces.acceptInvite(owner.id, (await workspaces.createInvite(owner.id, "team", { email: "x@example.com", role: "viewer" })).token)).toMatchObject({ role: "owner" });
    const higher = await workspaces.createInvite(owner.id, "team", { email: "y@example.com", role: "owner" });
    expect(await workspaces.acceptInvite(admin.id, higher.token)).toMatchObject({ role: "owner" });
  });
});
