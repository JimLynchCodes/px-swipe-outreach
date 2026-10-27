import type { MemberRole } from "../types.js";

export type InviteEmail = {
  email: string; orgName: string; role: MemberRole; inviterEmail: string | null; acceptUrl: string; expiresAt: Date;
};

export type InviteSendResult = {
  /** "invite" = Supabase invite (new user), "magic_link" = existing user got a sign-in link, "logged" = dev. */
  method: "invite" | "magic_link" | "logged";
};

export interface InviteMailer {
  readonly name: "console" | "supabase";
  send(msg: InviteEmail): Promise<InviteSendResult>;
}

export class InviteMailerError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "InviteMailerError"; }
}

/** Dev only: logs the accept link instead of emailing it. Config refuses this mailer in production. */
export class ConsoleInviteMailer implements InviteMailer {
  readonly name = "console" as const;
  constructor(private log: (line: string, meta: Record<string, unknown>) => void) {}
  async send(msg: InviteEmail): Promise<InviteSendResult> {
    this.log("[invite] email not sent (INVITE_MAILER=console). Share this link:", { acceptUrl: msg.acceptUrl, orgName: msg.orgName, role: msg.role });
    return { method: "logged" };
  }
}

/**
 * Sends invites through Supabase Auth, so they use the project's SMTP settings and email templates.
 * - New address: Admin "invite user" (creates the auth user, emails a sign-up link).
 * - Existing user: a magic link (`/otp`, create_user=false).
 * Both redirect to the accept URL (which must match the project's Redirect URLs allow list).
 * Uses the service role key, which stays on the backend.
 */
export class SupabaseInviteMailer implements InviteMailer {
  readonly name = "supabase" as const;
  constructor(private opts: { supabaseUrl: string; serviceRoleKey: string; fetch?: typeof fetch; timeoutMs?: number }) {}

  private async call(path: string, redirectTo: string, body: unknown) {
    const f = this.opts.fetch ?? fetch;
    const url = `${this.opts.supabaseUrl}/auth/v1${path}?redirect_to=${encodeURIComponent(redirectTo)}`;
    const res = await f(url, {
      method: "POST",
      headers: {
        apikey: this.opts.serviceRoleKey,
        Authorization: `Bearer ${this.opts.serviceRoleKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000)
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    return { status: res.status, data };
  }

  async send(msg: InviteEmail): Promise<InviteSendResult> {
    const data = { invited_to_org: msg.orgName, invited_role: msg.role, invited_by: msg.inviterEmail };
    const invite = await this.call("/invite", msg.acceptUrl, { email: msg.email, data });
    if (invite.status >= 200 && invite.status < 300) return { method: "invite" };
    const code = String(invite.data?.error_code ?? invite.data?.code ?? "");
    const already = invite.status === 422 || code === "email_exists" || /already been registered/i.test(String(invite.data?.msg ?? ""));
    if (!already) throw new InviteMailerError(`Supabase invite failed (${invite.status}${code ? ` ${code}` : ""})`, invite.status);

    const otp = await this.call("/otp", msg.acceptUrl, { email: msg.email, create_user: false, data });
    if (otp.status >= 200 && otp.status < 300) return { method: "magic_link" };
    throw new InviteMailerError(`Supabase magic link failed (${otp.status})`, otp.status);
  }
}
