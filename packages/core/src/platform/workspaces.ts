import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlDriver } from "../index-store/driver.js";
import { isUniqueViolation, normalizeEmail, type User } from "./accounts.js";
import { WORKSPACE_ROLES, type WorkspaceRole } from "./migrations.js";

/** A workspace as one of its members sees it. */
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  /** The caller's role in it. */
  role: WorkspaceRole;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface WorkspaceInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** A new invite: the token (the link) is shown once; only its hash is stored. */
export interface CreatedInvite extends WorkspaceInvite {
  token: string;
}

/** A workspace request the caller should answer with 4xx; `code` says which. */
export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | "invalid-name"
      | "invalid-slug"
      | "invalid-role"
      | "invalid-transfer"
      | "slug-taken"
      | "not-found"
      | "forbidden"
      | "last-owner"
      | "already-member"
      | "invite-not-found"
      | "invite-expired"
      | "invite-used",
    message: string,
  ) {
    super(message);
  }
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How many times a generated slug is picked again after a concurrent writer took it (REVIEW-0002 R4). */
const SLUG_ATTEMPTS = 3;

/** Lowercase letters, digits and inner hyphens, 3 to 40 characters. */
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Higher manages lower: a role can grant, change and remove only roles below its own, except owners, who can do all. */
const RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  role: WorkspaceRole;
}

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: WorkspaceRole;
  created_at: string;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  invited_by: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

/**
 * Workspaces, their members and invites (ADR-0002), over the tables made by `migratePlatform`. Every call names the
 * acting user: a workspace they are not a member of is `not-found`, never `forbidden`, so its existence does not leak.
 * Membership changes run in a transaction locked per workspace, so two owners demoting each other cannot both win.
 * A workspace is named by its slug or by any of its earlier slugs (aliases, REVIEW-0002 OQ-5).
 */
export class PlatformWorkspaces {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(actorId: string, input: { name: string; slug?: string }): Promise<Workspace> {
    const name = checkName(input.name);
    const slug = input.slug === undefined ? undefined : checkSlug(input.slug);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          if (slug && (await slugTaken(tx, slug))) throw slugTakenError(slug);
          return insertWorkspace(tx, actorId, slug ?? (await freeSlug(tx, slugify(name))), name, this.now());
        });
      } catch (err) {
        // A concurrent create took the slug between the check and the insert: a chosen slug is a conflict, a
        // generated one is picked again (and `freeSlug` now sees it taken).
        if (err instanceof WorkspaceError || !isUniqueViolation(err)) throw err;
        if (slug || attempt >= SLUG_ATTEMPTS) throw slugTakenError(slug ?? slugify(name));
      }
    }
  }

  /**
   * The workspace every new user starts with, owned by them; `PlatformAccounts` calls this inside its sign-up
   * transaction (`tx`), so an account never exists without one. Its slug comes from the email's local part.
   */
  async createPersonal(user: User, tx: SqlDriver = this.db): Promise<Workspace> {
    const local = user.email.split("@")[0];
    const name = (user.displayName ?? local).slice(0, 100);
    return insertWorkspace(tx, user.id, await freeSlug(tx, slugify(local)), name, this.now());
  }

  /** The workspaces the user is a member of, oldest first. */
  async listMine(userId: string): Promise<Workspace[]> {
    const rows = await this.db.all<WorkspaceRow>(
      `SELECT w.id, w.slug, w.name, w.created_at, m.role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at, w.slug`,
      [userId],
    );
    return rows.map(toWorkspace);
  }

  /** How many workspaces the user is a member of; zero once they deleted or left them all. */
  async countMine(userId: string): Promise<number> {
    const rows = await this.db.all<{ n: number | string }>("SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?", [userId]);
    return Number(rows[0]?.n ?? 0);
  }

  /** A workspace by its slug or an alias; the result has the current slug, so a caller can tell the two apart. */
  async get(actorId: string, slug: string): Promise<Workspace> {
    return toWorkspace(await membership(this.db, actorId, slug));
  }

  /**
   * Renames a workspace or changes its slug (admin). The old slug becomes an alias, still naming this workspace and
   * unavailable to others; taking back one of its own aliases is allowed and drops that alias.
   */
  async update(actorId: string, slug: string, input: { name?: string; slug?: string }): Promise<Workspace> {
    const name = input.name === undefined ? undefined : checkName(input.name);
    const newSlug = input.slug === undefined ? undefined : checkSlug(input.slug);
    try {
      return await this.locked(actorId, slug, async (tx, ws) => {
        need(ws.role, "admin", "change the workspace");
        if (newSlug && newSlug !== ws.slug) {
          if (await slugTaken(tx, newSlug, ws.id)) throw slugTakenError(newSlug);
          await tx.run("DELETE FROM workspace_slug_aliases WHERE slug = ? AND workspace_id = ?", [newSlug, ws.id]);
          await tx.run("INSERT INTO workspace_slug_aliases (slug, workspace_id, created_at) VALUES (?, ?, ?)", [
            ws.slug,
            ws.id,
            this.now().toISOString(),
          ]);
        }
        const next = { ...ws, name: name ?? ws.name, slug: newSlug ?? ws.slug };
        await tx.run("UPDATE workspaces SET name = ?, slug = ? WHERE id = ?", [next.name, next.slug, ws.id]);
        return toWorkspace(next);
      });
    } catch (err) {
      // A concurrent create or rename took the slug between the check and the update.
      if (!(err instanceof WorkspaceError) && newSlug && isUniqueViolation(err)) throw slugTakenError(newSlug);
      throw err;
    }
  }

  /** Deletes a workspace with its members, invites, projects and slug aliases (owner). */
  async delete(actorId: string, slug: string): Promise<void> {
    await this.locked(actorId, slug, async (tx, ws) => {
      need(ws.role, "owner", "delete the workspace");
      await tx.run("DELETE FROM workspaces WHERE id = ?", [ws.id]);
    });
  }

  async members(actorId: string, slug: string): Promise<WorkspaceMember[]> {
    const ws = await membership(this.db, actorId, slug);
    const rows = await this.db.all<MemberRow>(
      `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at FROM workspace_members m
       JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at, u.email`,
      [ws.id],
    );
    return rows.map(toMember);
  }

  /**
   * Changes a member's role. Admins manage members and viewers; owners manage everyone, owners included. The last
   * owner cannot be demoted. The member's pending invites for roles the new one cannot grant are deleted.
   */
  async setRole(actorId: string, slug: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember> {
    checkRole(role);
    return this.locked(actorId, slug, async (tx, ws) => {
      need(ws.role, "admin", "change roles");
      const target = await memberOf(tx, ws.id, userId);
      mayManage(ws.role, target.role, "change this member's role");
      mayGrant(ws.role, role);
      if (target.role === "owner" && role !== "owner") await keepAnOwner(tx, ws.id);
      await tx.run("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?", [role, ws.id, userId]);
      await dropUngrantableInvites(tx, ws.id, userId, role);
      return toMember({ ...target, role });
    });
  }

  /**
   * Removes a member (admin, as for roles); removing yourself is leaving. The last owner cannot be removed. Their
   * pending invites go with them.
   */
  async removeMember(actorId: string, slug: string, userId: string): Promise<void> {
    if (userId === actorId) return this.leave(actorId, slug);
    await this.locked(actorId, slug, async (tx, ws) => {
      need(ws.role, "admin", "remove members");
      const target = await memberOf(tx, ws.id, userId);
      mayManage(ws.role, target.role, "remove this member");
      if (target.role === "owner") await keepAnOwner(tx, ws.id);
      await tx.run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", [ws.id, userId]);
      await dropUngrantableInvites(tx, ws.id, userId, null);
    });
  }

  /** Leaves a workspace, whatever the role, unless the caller is its last owner. Their pending invites go too. */
  async leave(actorId: string, slug: string): Promise<void> {
    await this.locked(actorId, slug, async (tx, ws) => {
      if (ws.role === "owner") await keepAnOwner(tx, ws.id);
      await tx.run("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?", [ws.id, actorId]);
      await dropUngrantableInvites(tx, ws.id, actorId, null);
    });
  }

  /**
   * Makes another member an owner and the caller an admin, at once (owner). To another owner, it only makes the caller
   * an admin. The caller's pending owner and admin invites are deleted, as for any demotion.
   */
  async transferOwnership(actorId: string, slug: string, userId: string): Promise<WorkspaceMember[]> {
    if (userId === actorId) throw new WorkspaceError("invalid-transfer", "Transfer ownership to another member, not yourself");
    await this.locked(actorId, slug, async (tx, ws) => {
      need(ws.role, "owner", "transfer ownership");
      await memberOf(tx, ws.id, userId);
      await tx.run("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?", [ws.id, userId]);
      await tx.run("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?", [ws.id, actorId]);
      await dropUngrantableInvites(tx, ws.id, actorId, "admin");
    });
    return this.members(actorId, slug);
  }

  /**
   * Invites someone to a workspace (admin; the role at most what the caller may grant). Whoever presents the returned
   * token while logged in joins, whatever their email (there is no mail yet: the caller hands the link over). A new
   * invite to the same email replaces a pending one, if the caller could grant that one's role too.
   */
  async createInvite(actorId: string, slug: string, input: { email: string; role: WorkspaceRole }): Promise<CreatedInvite> {
    const email = normalizeEmail(input.email);
    checkRole(input.role);
    return this.locked(actorId, slug, async (tx, ws) => {
      need(ws.role, "admin", "invite members");
      mayGrant(ws.role, input.role);
      const existing = await tx.all<{ user_id: string }>(
        "SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?",
        [ws.id, email],
      );
      if (existing.length) throw new WorkspaceError("already-member", `${email} is already a member of this workspace`);
      const pending = await tx.all<{ role: WorkspaceRole }>(
        "SELECT role FROM workspace_invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL",
        [ws.id, email],
      );
      for (const { role } of pending) mayGrant(ws.role, role, `replace a pending ${role} invite`);
      await tx.run("DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL", [ws.id, email]);
      const token = randomBytes(32).toString("base64url");
      const now = this.now();
      const invite: WorkspaceInvite = {
        id: randomUUID(),
        email,
        role: input.role,
        invitedBy: actorId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      };
      await tx.run(
        `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [invite.id, ws.id, email, invite.role, tokenHash(token), actorId, invite.createdAt, invite.expiresAt],
      );
      return { ...invite, token };
    });
  }

  /** Invites not accepted yet, expired ones included (admin). */
  async invites(actorId: string, slug: string): Promise<WorkspaceInvite[]> {
    const ws = await membership(this.db, actorId, slug);
    need(ws.role, "admin", "see invites");
    const rows = await this.db.all<InviteRow>(
      `SELECT id, workspace_id, email, role, invited_by, created_at, expires_at, accepted_at FROM workspace_invites
       WHERE workspace_id = ? AND accepted_at IS NULL ORDER BY created_at, email`,
      [ws.id],
    );
    return rows.map(toInvite);
  }

  /** Deletes a pending invite, so its token no longer works (admin, for a role they could grant). */
  async revokeInvite(actorId: string, slug: string, inviteId: string): Promise<void> {
    await this.locked(actorId, slug, async (tx, ws) => {
      need(ws.role, "admin", "revoke invites");
      const rows = await tx.all<{ role: WorkspaceRole }>(
        "SELECT role FROM workspace_invites WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL",
        [inviteId, ws.id],
      );
      if (!rows.length) throw new WorkspaceError("not-found", "No pending invite with this id");
      mayGrant(ws.role, rows[0].role, `revoke a ${rows[0].role} invite`);
      await tx.run("DELETE FROM workspace_invites WHERE id = ?", [inviteId]);
    });
  }

  /**
   * Joins the workspace of an invite, once, before it expires. The invite's email need not be the user's (ADR-0002:
   * the token is the proof). A member already in it keeps the higher of their role and the invite's. An invite whose
   * inviter is no longer a member, or no longer may grant its role, is void like a revoked one (REVIEW-0002 R1).
   */
  async acceptInvite(userId: string, token: string): Promise<Workspace> {
    const hash = tokenHash(typeof token === "string" ? token : "");
    const notFound = () => new WorkspaceError("invite-not-found", "This invite does not exist or was revoked");
    // The workspace first, then the invite again under its lock, so accepting is serialized with revoking the invite
    // and with changes to the inviter's membership (REVIEW-0002 R3).
    const found = (await this.db.all<{ workspace_id: string }>("SELECT workspace_id FROM workspace_invites WHERE token_hash = ?", [hash]))[0];
    if (!found) throw notFound();
    return this.db.transaction(async (tx) => {
      const invite = (
        await tx.all<InviteRow>(
          `SELECT id, workspace_id, email, role, invited_by, created_at, expires_at, accepted_at FROM workspace_invites
           WHERE token_hash = ? AND workspace_id = ?`,
          [hash, found.workspace_id],
        )
      )[0];
      if (!invite) throw notFound();
      if (invite.accepted_at) throw new WorkspaceError("invite-used", "This invite was already used");
      const now = this.now();
      if (Date.parse(invite.expires_at) <= now.getTime()) throw new WorkspaceError("invite-expired", "This invite has expired");
      const inviter = invite.invited_by && (await roleIn(tx, invite.workspace_id, invite.invited_by));
      if (!inviter || !grants(inviter, invite.role)) throw notFound();
      await tx.run("UPDATE workspace_invites SET accepted_at = ?, accepted_by = ? WHERE id = ?", [now.toISOString(), userId, invite.id]);
      const current = (
        await tx.all<{ role: WorkspaceRole }>("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?", [
          invite.workspace_id,
          userId,
        ])
      )[0];
      if (!current) {
        await tx.run("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [
          invite.workspace_id,
          userId,
          invite.role,
          now.toISOString(),
        ]);
      } else if (RANK[invite.role] > RANK[current.role]) {
        await tx.run("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?", [
          invite.role,
          invite.workspace_id,
          userId,
        ]);
      }
      const ws = await tx.all<WorkspaceRow>(
        `SELECT w.id, w.slug, w.name, w.created_at, m.role FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id WHERE w.id = ? AND m.user_id = ?`,
        [invite.workspace_id, userId],
      );
      return toWorkspace(ws[0]);
    }, `workspace:${found.workspace_id}`);
  }

  /**
   * Deletes the invites past their expiry that nobody accepted; accepted ones stay as the record of who joined how.
   * Accepting checks expiry anyway; this keeps them from piling up. Returns how many were deleted.
   */
  async purgeExpiredInvites(): Promise<number> {
    const now = this.now().toISOString();
    const expired = await this.db.all<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM workspace_invites WHERE accepted_at IS NULL AND expires_at <= ?",
      [now],
    );
    const count = Number(expired[0]?.n ?? 0);
    if (count) await this.db.run("DELETE FROM workspace_invites WHERE accepted_at IS NULL AND expires_at <= ?", [now]);
    return count;
  }

  /** Runs `work` in a transaction locked on the workspace, with the actor's membership read inside it. */
  private async locked<T>(actorId: string, slug: string, work: (tx: SqlDriver, ws: WorkspaceRow) => Promise<T>): Promise<T> {
    const { id } = await membership(this.db, actorId, slug);
    return this.db.transaction(async (tx) => work(tx, await membership(tx, actorId, slug, id)), `workspace:${id}`);
  }
}

/**
 * The actor's membership in a workspace named by id, slug or alias (a current slug wins over an alias), or
 * `not-found` for a missing workspace and a non-member alike, so an alias says nothing to a non-member either.
 */
async function membership(db: SqlDriver, actorId: string, slug: string, id?: string): Promise<WorkspaceRow> {
  const named = id
    ? "w.id = ?"
    : `w.id = COALESCE((SELECT id FROM workspaces WHERE slug = ?),
                      (SELECT workspace_id FROM workspace_slug_aliases WHERE slug = ?))`;
  const rows = await db.all<WorkspaceRow>(
    `SELECT w.id, w.slug, w.name, w.created_at, m.role FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id WHERE ${named} AND m.user_id = ?`,
    id ? [id, actorId] : [slug, slug, actorId],
  );
  if (!rows[0]) throw new WorkspaceError("not-found", `No workspace "${slug}"`);
  return rows[0];
}

async function memberOf(db: SqlDriver, workspaceId: string, userId: string): Promise<MemberRow> {
  const rows = await db.all<MemberRow>(
    `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at FROM workspace_members m
     JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?`,
    [workspaceId, userId],
  );
  if (!rows[0]) throw new WorkspaceError("not-found", "No such member in this workspace");
  return rows[0];
}

async function roleIn(db: SqlDriver, workspaceId: string, userId: string): Promise<WorkspaceRole | undefined> {
  const rows = await db.all<{ role: WorkspaceRole }>("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?", [
    workspaceId,
    userId,
  ]);
  return rows[0]?.role;
}

/**
 * Deletes the pending invites `userId` made in a workspace that their role there (null: no longer a member) cannot
 * grant, so an invite never outlives its inviter's authority (REVIEW-0002 R1). Run in the membership change's
 * transaction; `acceptInvite` checks the inviter again anyway.
 */
async function dropUngrantableInvites(tx: SqlDriver, workspaceId: string, userId: string, role: WorkspaceRole | null): Promise<void> {
  const void_ = WORKSPACE_ROLES.filter((r) => role === null || !grants(role, r));
  if (!void_.length) return;
  await tx.run(
    `DELETE FROM workspace_invites WHERE workspace_id = ? AND invited_by = ? AND accepted_at IS NULL
     AND role IN (${void_.map(() => "?").join(", ")})`,
    [workspaceId, userId, ...void_],
  );
}

async function keepAnOwner(db: SqlDriver, workspaceId: string): Promise<void> {
  const rows = await db.all<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
    [workspaceId],
  );
  if (Number(rows[0]?.n ?? 0) <= 1) {
    throw new WorkspaceError("last-owner", "A workspace needs an owner: make another member owner first, or delete the workspace");
  }
}

async function insertWorkspace(tx: SqlDriver, ownerId: string, slug: string, name: string, now: Date): Promise<Workspace> {
  const ws: Workspace = { id: randomUUID(), slug, name, createdAt: now.toISOString(), role: "owner" };
  await tx.run("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)", [
    ws.id,
    slug,
    name,
    ownerId,
    ws.createdAt,
  ]);
  await tx.run("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [
    ws.id,
    ownerId,
    ws.createdAt,
  ]);
  return ws;
}

/** Whether a slug is some workspace's current slug, or an alias of a workspace other than `ownId`. */
async function slugTaken(db: SqlDriver, slug: string, ownId = ""): Promise<boolean> {
  const rows = await db.all(
    "SELECT 1 FROM workspaces WHERE slug = ? UNION ALL SELECT 1 FROM workspace_slug_aliases WHERE slug = ? AND workspace_id <> ?",
    [slug, slug, ownId],
  );
  return rows.length > 0;
}

/** `base` if free, otherwise `base-xxxx` with a random suffix. */
async function freeSlug(db: SqlDriver, base: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 35)}-${randomBytes(2).toString("hex")}`;
    if (!(await slugTaken(db, slug))) return slug;
  }
  throw new Error(`No free workspace slug like "${base}"`);
}

/** A valid slug made from any text: "Dev's Team!" → "dev-s-team". */
export function slugify(text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return base.length >= 3 ? base : `${base || "workspace"}${base ? "-ws" : ""}`;
}

function checkName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100) throw new WorkspaceError("invalid-name", "The workspace name must be 1 to 100 characters long");
  return name;
}

function checkSlug(value: unknown): string {
  if (typeof value !== "string" || !WORKSPACE_SLUG.test(value)) {
    throw new WorkspaceError(
      "invalid-slug",
      "The slug must be 3 to 40 lowercase letters, digits or hyphens, starting and ending with a letter or digit",
    );
  }
  return value;
}

function checkRole(value: unknown): asserts value is WorkspaceRole {
  if (!WORKSPACE_ROLES.includes(value as WorkspaceRole)) {
    throw new WorkspaceError("invalid-role", `The role must be one of ${WORKSPACE_ROLES.join(", ")}`);
  }
}

function need(role: WorkspaceRole, least: WorkspaceRole, action: string): void {
  if (RANK[role] < RANK[least]) throw new WorkspaceError("forbidden", `Only ${least === "owner" ? "an owner" : `an ${least} or owner`} can ${action}`);
}

function mayManage(actor: WorkspaceRole, target: WorkspaceRole, action: string): void {
  if (actor !== "owner" && RANK[target] >= RANK[actor]) throw new WorkspaceError("forbidden", `Only an owner can ${action}`);
}

/** Whether `actor` may hand out `role`: owners any, admins lower roles, members and viewers none (they cannot invite). */
function grants(actor: WorkspaceRole, role: WorkspaceRole): boolean {
  return actor === "owner" || (RANK[actor] >= RANK.admin && RANK[role] < RANK[actor]);
}

function mayGrant(actor: WorkspaceRole, role: WorkspaceRole, action = `grant the ${role} role`): void {
  if (!grants(actor, role)) throw new WorkspaceError("forbidden", `Only an owner can ${action}`);
}

function slugTakenError(slug: string): WorkspaceError {
  return new WorkspaceError("slug-taken", `The slug "${slug}" is taken`);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at, role: row.role };
}

function toMember(row: MemberRow): WorkspaceMember {
  return { userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role, joinedAt: row.created_at };
}

function toInvite(row: InviteRow): WorkspaceInvite {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
