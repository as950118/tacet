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
    expect(await workspaces.get(owner.id, "acme-web")).toMatchObject({ slug: "acme" });
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

  it("voids an invite once its inviter is removed, demoted or gone (REVIEW-0002 R1)", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUp("admin@example.com");
    const alt = await signUp("alt@example.com");
    await team(owner, { admin });
    const pending = async () => (await workspaces.invites(owner.id, "team")).map((i) => `${i.email}:${i.role}`).sort();

    // The review's scenario: an admin keeps a token, is removed, and tries to come back with it.
    const kept = await workspaces.createInvite(admin.id, "team", { email: alt.email, role: "member" });
    await workspaces.removeMember(owner.id, "team", admin.id);
    expect(await pending()).toEqual([]);
    expect(await code(workspaces.acceptInvite(admin.id, kept.token))).toBe("invite-not-found");
    expect(await code(workspaces.get(admin.id, "team"))).toBe("not-found");

    // Demoted to member, who cannot invite at all: all their invites go, other people's stay.
    await workspaces.acceptInvite(admin.id, (await workspaces.createInvite(owner.id, "team", { email: admin.email, role: "admin" })).token);
    await workspaces.createInvite(admin.id, "team", { email: "m@example.com", role: "member" });
    await workspaces.createInvite(admin.id, "team", { email: "v@example.com", role: "viewer" });
    await workspaces.createInvite(owner.id, "team", { email: "o@example.com", role: "member" });
    await workspaces.setRole(owner.id, "team", admin.id, "member");
    expect(await pending()).toEqual(["o@example.com:member"]);

    // Leaving takes one's invites along; an owner demoted to admin keeps only what an admin may grant.
    await workspaces.setRole(owner.id, "team", admin.id, "owner");
    await workspaces.createInvite(admin.id, "team", { email: "a@example.com", role: "admin" });
    await workspaces.createInvite(admin.id, "team", { email: "v@example.com", role: "viewer" });
    await workspaces.transferOwnership(admin.id, "team", owner.id);
    expect(await pending()).toEqual(["o@example.com:member", "v@example.com:viewer"]);
    await workspaces.leave(admin.id, "team");
    expect(await pending()).toEqual(["o@example.com:member"]);
  });

  it("checks the inviter's current role when an invite is accepted, whatever cleaned up before", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUp("admin@example.com");
    const joiner = await signUp("joiner@example.com");
    const ws = await team(owner, { admin });
    const byAdmin = await workspaces.createInvite(admin.id, "team", { email: "x@example.com", role: "member" });
    // Behind the API's back, as an older version (or a bug) could leave it: the invite outlives the admin's authority.
    await db.run("UPDATE workspace_members SET role = 'member' WHERE workspace_id = ? AND user_id = ?", [ws.id, admin.id]);
    expect(await code(workspaces.acceptInvite(joiner.id, byAdmin.token))).toBe("invite-not-found");
    await db.run("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?", [ws.id, admin.id]);
    expect(await workspaces.acceptInvite(joiner.id, byAdmin.token)).toMatchObject({ slug: "team", role: "member" });

    // An inviter whose account is gone (invited_by set to NULL) vouches for nothing.
    const orphan = await workspaces.createInvite(admin.id, "team", { email: "y@example.com", role: "viewer" });
    await db.run("DELETE FROM users WHERE id = ?", [admin.id]);
    const late = await signUp("late@example.com");
    expect(await code(workspaces.acceptInvite(late.id, orphan.token))).toBe("invite-not-found");
  });

  it("lets an admin revoke or replace only invites for roles they could grant (REVIEW-0002 R2)", async () => {
    const owner = await signUp("owner@example.com");
    const admin = await signUp("admin@example.com");
    await team(owner, { admin });
    const cto = await workspaces.createInvite(owner.id, "team", { email: "cto@example.com", role: "owner" });
    const dev = await workspaces.createInvite(owner.id, "team", { email: "dev@example.com", role: "member" });
    expect(await code(workspaces.revokeInvite(admin.id, "team", cto.id))).toBe("forbidden");
    expect(await code(workspaces.createInvite(admin.id, "team", { email: "cto@example.com", role: "viewer" }))).toBe("forbidden");
    expect((await workspaces.invites(owner.id, "team")).map((i) => i.id).sort()).toEqual([cto.id, dev.id].sort());
    expect(await code(workspaces.createInvite(admin.id, "team", { email: "dev@example.com", role: "viewer" }))).toBe("ok");
    expect(await code(workspaces.revokeInvite(owner.id, "team", cto.id))).toBe("ok");
  });

  it("serializes accepting with revoking the invite (REVIEW-0002 R3)", async () => {
    const owner = await signUp("owner@example.com");
    const joiner = await signUp("joiner@example.com");
    await team(owner);
    const invite = await workspaces.createInvite(owner.id, "team", { email: joiner.email, role: "member" });
    const [accepted, revoked] = await Promise.all([
      code(workspaces.acceptInvite(joiner.id, invite.token)),
      code(workspaces.revokeInvite(owner.id, "team", invite.id)),
    ]);
    // Either the accept ran first (and the invite is no longer pending) or the revoke did (and nobody joined).
    expect([accepted, revoked].sort()).toEqual(accepted === "ok" ? ["not-found", "ok"] : ["invite-not-found", "ok"]);
    expect((await workspaces.members(owner.id, "team")).length).toBe(accepted === "ok" ? 2 : 1);
  });

  it("picks other slugs for concurrent sign-ups and creates, and reports a chosen one as taken (REVIEW-0002 R4)", async () => {
    const users = await Promise.all(["a", "b", "c", "d"].map((domain) => signUp(`dev@${domain}.example`)));
    const personal = await Promise.all(users.map(async (u) => (await workspaces.listMine(u.id))[0].slug));
    expect(new Set(personal).size).toBe(4);

    const owner = users[0];
    const made = await Promise.all([1, 2, 3].map(() => workspaces.create(owner.id, { name: "Same Name" })));
    expect(new Set(made.map((w) => w.slug)).size).toBe(3);
    const chosen = await Promise.all([1, 2, 3].map(() => code(workspaces.create(owner.id, { name: "X", slug: "chosen" }))));
    expect(chosen.sort()).toEqual(["ok", "slug-taken", "slug-taken"]);
  });

  it("refuses to transfer ownership to oneself; to another owner it only steps the caller down (REVIEW-0002 N2)", async () => {
    const owner = await signUp("owner@example.com");
    const second = await signUp("second@example.com");
    await team(owner, { owner: second });
    expect(await code(workspaces.transferOwnership(owner.id, "team", owner.id))).toBe("invalid-transfer");
    const members = await workspaces.transferOwnership(owner.id, "team", second.id);
    expect(Object.fromEntries(members.map((m) => [m.email, m.role]))).toEqual({ [owner.email]: "admin", [second.email]: "owner" });
  });

  it("lets a user with no workspace create one, and counts them (REVIEW-0002 OQ-2)", async () => {
    const dev = await signUp("dev@example.com");
    expect(await workspaces.countMine(dev.id)).toBe(1);
    await workspaces.delete(dev.id, "dev");
    expect(await workspaces.countMine(dev.id)).toBe(0);
    expect(await workspaces.listMine(dev.id)).toEqual([]);
    expect(await workspaces.create(dev.id, { name: "Fresh" })).toMatchObject({ slug: "fresh", role: "owner" });

    // A user from before workspaces existed: a bare row, no personal workspace.
    const old = randomUUID();
    await db.run("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, 'old@example.com', 'x', ?)", [old, now.toISOString()]);
    expect(await workspaces.countMine(old)).toBe(0);
    expect(await workspaces.create(old, { name: "Old Team" })).toMatchObject({ slug: "old-team", role: "owner" });
    expect(await workspaces.countMine(old)).toBe(1);
  });

  it("purges expired invites nobody accepted, keeping accepted ones (REVIEW-0002 OQ-4)", async () => {
    const owner = await signUp("owner@example.com");
    const joiner = await signUp("joiner@example.com");
    await team(owner);
    await workspaces.acceptInvite(joiner.id, (await workspaces.createInvite(owner.id, "team", { email: joiner.email, role: "member" })).token);
    await workspaces.createInvite(owner.id, "team", { email: "old@example.com", role: "viewer" });
    now = new Date(now.getTime() + INVITE_TTL_MS / 2);
    const fresh = await workspaces.createInvite(owner.id, "team", { email: "new@example.com", role: "viewer" });
    expect(await workspaces.purgeExpiredInvites()).toBe(0);
    now = new Date(now.getTime() + INVITE_TTL_MS / 2);
    expect(await workspaces.purgeExpiredInvites()).toBe(1);
    expect((await workspaces.invites(owner.id, "team")).map((i) => i.id)).toEqual([fresh.id]);
    expect(await db.all("SELECT id FROM workspace_invites WHERE accepted_at IS NOT NULL")).toHaveLength(1);
  });

  it("keeps old slugs as aliases of their workspace (REVIEW-0002 OQ-5)", async () => {
    const owner = await signUp("owner@example.com");
    const other = await signUp("other@example.com");
    const stranger = await signUp("stranger@example.com");
    await team(owner, { member: other });
    await workspaces.update(owner.id, "team", { slug: "team-b" });
    await workspaces.update(owner.id, "team-b", { slug: "team-c" });

    // A chain: both earlier slugs name the workspace, for members only.
    for (const slug of ["team", "team-b", "team-c"]) {
      expect(await workspaces.get(owner.id, slug)).toMatchObject({ slug: "team-c" });
      expect(await code(workspaces.get(stranger.id, slug))).toBe("not-found");
    }
    expect((await workspaces.members(other.id, "team")).length).toBe(2);

    // Reserved for this workspace: not as a new slug, not as another's rename, not for a generated one.
    const strangers = await workspaces.create(stranger.id, { name: "Mine", slug: "mine" });
    expect(await code(workspaces.create(stranger.id, { name: "Team", slug: "team" }))).toBe("slug-taken");
    expect(await code(workspaces.update(stranger.id, "mine", { slug: "team-b" }))).toBe("slug-taken");
    expect((await workspaces.create(stranger.id, { name: "Team" })).slug).toMatch(/^team-[0-9a-f]{4}$/);
    expect(strangers.slug).toBe("mine");

    // Taking back an alias drops it; the slug it leaves becomes one.
    expect(await workspaces.update(owner.id, "team-c", { slug: "team" })).toMatchObject({ slug: "team" });
    const aliases = async () =>
      (await db.all<{ slug: string }>("SELECT slug FROM workspace_slug_aliases ORDER BY slug")).map((r) => r.slug);
    expect(await aliases()).toEqual(["team-b", "team-c"]);
    expect(await workspaces.get(owner.id, "team-c")).toMatchObject({ slug: "team" });

    // Deleting the workspace frees its aliases.
    await workspaces.delete(owner.id, "team-b");
    expect(await aliases()).toEqual([]);
    expect(await code(workspaces.create(stranger.id, { name: "Now Mine", slug: "team-c" }))).toBe("ok");
  });
});
