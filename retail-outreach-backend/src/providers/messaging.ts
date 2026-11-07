import nodemailer, { type Transporter } from "nodemailer";
import twilio from "twilio";
import type { Channel } from "../types.js";

export type OutboundMessage = {
  channel: Channel; recipient: string; message: string; subject?: string | null;
  /** Extra email headers, e.g. List-Unsubscribe, Reply-To. */
  headers?: Record<string, string>;
  /** Org the message belongs to (for logging/routing). */
  orgId?: string;
};

/** Implement this for any vendor. Keep credentials server-side. */
export interface MessageProvider {
  readonly name: string;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
}

const mask = (r: string) => r.replace(/^(.{3}).*(.{2})$/, "$1***$2");

/** EMAIL_PROVIDER=log / SMS_PROVIDER=log: logs instead of sending. Dev/test only (refused in production). */
export class ConsoleMessageProvider implements MessageProvider {
  readonly name: string = "console";
  readonly sent: OutboundMessage[] = [];
  constructor(private log: (line: string) => void = console.log) {}
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    this.log(`[LOG ${msg.channel.toUpperCase()}] to=${mask(msg.recipient)}${msg.subject ? ` subject="${msg.subject}"` : ""} body="${msg.message}"`);
    return { providerMessageId: `log-${Date.now()}-${this.sent.length}` };
  }
}

export type SmtpOptions = { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string };

/**
 * Real email over any SMTP server via Nodemailer (free, MIT-0): Gmail with an app password, your host's SMTP, or
 * Mailpit locally. Passes List-Unsubscribe / List-Unsubscribe-Post and Reply-To through as real headers.
 */
export class SmtpEmailProvider implements MessageProvider {
  readonly name = "smtp";
  private transport: Transporter;
  constructor(private opts: SmtpOptions, transport?: Transporter) {
    this.transport = transport ?? nodemailer.createTransport({
      host: opts.host, port: opts.port, secure: opts.secure,
      // Fail fast (the send request waits on this in inline mode) instead of Nodemailer's 2-minute default.
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      ...(opts.user ? { auth: { user: opts.user, pass: opts.pass ?? "" } } : {})
    });
  }
  async send(msg: OutboundMessage) {
    if (msg.channel !== "email") throw new Error("SmtpEmailProvider only sends email");
    const { "Reply-To": replyTo, ...headers } = msg.headers ?? {};
    const info = await this.transport.sendMail({
      from: this.opts.from, to: msg.recipient, subject: msg.subject ?? "", text: msg.message,
      ...(replyTo ? { replyTo } : {}), headers
    });
    return { providerMessageId: String(info.messageId ?? `smtp-${Date.now()}`) };
  }
}

export type TwilioOptions = { accountSid: string; authToken: string; fromNumber?: string; messagingServiceSid?: string };
/** Minimal slice of the Twilio SDK client we use (lets tests inject a fake). */
export type TwilioClientLike = { messages: { create(p: { to: string; body: string; from?: string; messagingServiceSid?: string }): Promise<{ sid: string }> } };

/** SMS_PROVIDER=twilio: real SMS through the official `twilio` SDK (paid; trial accounts only reach verified numbers). */
export class TwilioSmsProvider implements MessageProvider {
  readonly name = "twilio";
  private client: TwilioClientLike;
  constructor(private opts: TwilioOptions, client?: TwilioClientLike) {
    this.client = client ?? (twilio(opts.accountSid, opts.authToken) as unknown as TwilioClientLike);
  }
  async send(msg: OutboundMessage) {
    if (msg.channel !== "sms") throw new Error("TwilioSmsProvider only sends SMS");
    const sender = this.opts.messagingServiceSid ? { messagingServiceSid: this.opts.messagingServiceSid } : { from: this.opts.fromNumber! };
    const m = await this.client.messages.create({ to: msg.recipient, body: msg.message, ...sender });
    return { providerMessageId: m.sid };
  }
}

/** Routes by channel so SMS and email use different vendors. */
export class ChannelRouter implements MessageProvider {
  readonly name: string;
  constructor(private providers: Record<Channel, MessageProvider>) { this.name = `email:${providers.email.name},sms:${providers.sms.name}`; }
  send(msg: OutboundMessage) { return this.providers[msg.channel].send(msg); }
}

export type MessagingConfig = {
  EMAIL_PROVIDER: "log" | "smtp"; SMS_PROVIDER: "log" | "twilio";
  SMTP_HOST?: string; SMTP_PORT: number; SMTP_SECURE: boolean; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string;
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM_NUMBER?: string; TWILIO_MESSAGING_SERVICE_SID?: string;
};

/** Builds the channel router from config (validated in config.ts, so required values are present here). */
export function createMessageProvider(c: MessagingConfig, deps: { log?: (l: string) => void } = {}): MessageProvider {
  const logProvider = new ConsoleMessageProvider(deps.log);
  const email = c.EMAIL_PROVIDER === "smtp"
    ? new SmtpEmailProvider({ host: c.SMTP_HOST!, port: c.SMTP_PORT, secure: c.SMTP_SECURE, user: c.SMTP_USER, pass: c.SMTP_PASS, from: c.SMTP_FROM! })
    : logProvider;
  const sms = c.SMS_PROVIDER === "twilio"
    ? new TwilioSmsProvider({ accountSid: c.TWILIO_ACCOUNT_SID!, authToken: c.TWILIO_AUTH_TOKEN!, fromNumber: c.TWILIO_FROM_NUMBER, messagingServiceSid: c.TWILIO_MESSAGING_SERVICE_SID })
    : logProvider;
  return new ChannelRouter({ email, sms });
}
