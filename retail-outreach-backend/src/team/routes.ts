import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AuthError, type AuthUser, type OrgContext } from "../auth.js";
import type { OutreachStore } from "../store/types.js";
import type { Actor, Invitation } from "../types.js";
import type { InviteMailer } from "./mailer.js";
import { assertCanManage } from "./policy.js";
import { hashInviteToken, INVITE_TOKEN_RE, newInviteToken } from "./tokens.js";

const role = z.enum(["owner", "admin", "staff"]);
const email = z.string().trim().toLowerCase().max(320).email();
const uuidParam = (key: string) => z.object({ [key]: z.string().uuid() });
const token = z.string().regex(INVITE_TOKEN_RE, "invalid invitation token");

type Deps = {
  config: AppConfig; store: OutreachStore; mailer: InviteMailer;
  actorOf: (req: any) => Actor;
  sendError: (reply: FastifyReply, status: number, code: string, error: string) => FastifyReply;
};

export const INVITE_PREVIEW_PATH = "/api/invitations/preview";
export const INVITE_ACCEPT_PATH = "/api/invitations/accept";

export async function teamRoutes(app: FastifyInstance, deps: Deps) {
  const { config, store, mailer, actorOf } = deps;
  const ttlMs = config.INVITE_TTL_HOURS * 3_600_000;
  const acceptUrl = (t: string) => `${config.APP_URL}/invite/accept?token=${encodeURIComponent(t)}`;
  const inviteLimit = { rateLimit: { max: config.INVITE_RATE_LIMIT_PER_HOUR, timeWindow: "1 hour" } };
  const orgOf = (req: { auth: { org: OrgContext | null } | null }) => req.auth!.org!;

  /** Sends the email; a mail failure never loses the invitation (the admin can resend). */
  async function deliver(req: any, inv: Invitation, rawToken: string) {
    const url = acceptUrl(rawToken);
    const user: AuthUser = req.auth.user;
    try {
      const res = await mailer.send({
        email: inv.email, role: inv.role, orgName: orgOf(req).orgName ?? "your team", inviterEmail: user.email,
        acceptUrl: url, expiresAt: new Date(inv.expiresAt)
      });
      req.log.info({ invitationId: inv.id, method: res.method }, "invitation email sent");
      // The raw link is only returned when nothing was emailed (dev console mailer), so it can be copied.
      return { emailSent: res.method !== "logged", ...(res.method === "logged" && config.NODE_ENV !== "production" ? { acceptUrl: url } : {}) };
    } catch (e) {
      req.log.error({ err: e, invitationId: inv.id }, "invitation email failed");
      return { emailSent: false };
    }
  }

  app.get("/api/team/members", async request => {
    const members = await store.listMembers(actorOf(request));
    return { members, me: { userId: request.auth!.user.id, role: orgOf(request).role } };
  });

  app.get("/api/team/invitations", async request => {
    assertCanManage(orgOf(request).role);
    return { invitations: await store.listInvitations(actorOf(request)) };
  });

  app.post("/api/team/invitations", { config: inviteLimit }, async (request, reply) => {
    assertCanManage(orgOf(request).role);
    const body = z.object({ email, role: role.default("staff") }).strict().parse(request.body ?? {});
    const raw = newInviteToken();
    const inv = await store.createInvitation(actorOf(request), {
      email: body.email, role: body.role, tokenHash: hashInviteToken(raw), expiresAt: new Date(Date.now() + ttlMs)
    });
    return reply.code(201).send({ invitation: inv, ...(await deliver(request, inv, raw)) });
  });

  app.post("/api/team/invitations/:id/resend", { config: inviteLimit }, async request => {
    assertCanManage(orgOf(request).role);
    const { id } = uuidParam("id").parse(request.params);
    const raw = newInviteToken();
    const inv = await store.refreshInvitation(actorOf(request), id as string, {
      tokenHash: hashInviteToken(raw), expiresAt: new Date(Date.now() + ttlMs), cooldownSeconds: config.INVITE_RESEND_COOLDOWN_SECONDS
    });
    return { invitation: inv, ...(await deliver(request, inv, raw)) };
  });

  app.delete("/api/team/invitations/:id", async request => {
    assertCanManage(orgOf(request).role);
    const { id } = uuidParam("id").parse(request.params);
    await store.revokeInvitation(actorOf(request), id as string);
    return { ok: true };
  });

  app.patch("/api/team/members/:userId", async request => {
    const { userId } = uuidParam("userId").parse(request.params);
    const body = z.object({ role }).strict().parse(request.body ?? {});
    await store.changeMemberRole(actorOf(request), userId as string, body.role);
    return { ok: true };
  });

  app.delete("/api/team/members/:userId", async request => {
    const { userId } = uuidParam("userId").parse(request.params);
    await store.removeMember(actorOf(request), userId as string);
    return { ok: true };
  });

  // ── Invitee side ──
  /** Public (token holders): who invited you to what. Strictly rate limited per IP against token guessing. */
  app.get(INVITE_PREVIEW_PATH, { config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: (r: any) => r.ip } } }, async (request, reply) => {
    const q = z.object({ token }).parse(request.query);
    const preview = await store.previewInvitation(hashInviteToken(q.token));
    if (!preview) return deps.sendError(reply, 404, "invitation_invalid", "This invitation link is invalid.");
    return { invitation: preview };
  });

  /** Signed in, no org required. The token's email must match the session's email. */
  app.post(INVITE_ACCEPT_PATH, { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async request => {
    const body = z.object({ token }).strict().parse(request.body ?? {});
    const user = request.auth?.user;
    if (!user) throw new AuthError(401, "unauthenticated", "Authentication required");
    const res = await store.acceptInvitation(user, hashInviteToken(body.token));
    return { ok: true, ...res, memberships: await store.listMemberships(user.id) };
  });
}
