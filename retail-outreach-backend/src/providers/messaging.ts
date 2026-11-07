import { isGsm7 } from "../ai/compliance.js";
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
/** priceUsd: actual provider price when known at send time (positive USD), null if not yet known, undefined if N/A. */
export type SendResult = { providerMessageId: string; provider?: string; segments?: number; priceUsd?: number | null };

export interface MessageProvider {
  readonly name: string;
  send(msg: OutboundMessage): Promise<SendResult>;
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
    return { providerMessageId: `log-${Date.now()}-${this.sent.length}`, provider: "log", segments: msg.channel === "sms" ? smsSegments(msg.message) : undefined, priceUsd: 0 };
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

export type TwilioOptions = {
  accountSid: string; authToken: string; fromNumber?: string; messagingServiceSid?: string;
  /** Builds the per-org StatusCallback URL (Twilio POSTs status changes there; we then fetch the final price). */
  statusCallbackUrl?: (orgId: string | undefined) => string | undefined;
};
export type TwilioMessage = { sid: string; numSegments?: string | number | null; price?: string | number | null; priceUnit?: string | null; status?: string | null };
/** Minimal slice of the Twilio SDK client we use (lets tests inject a fake). */
export type TwilioClientLike = {
  messages: { create(p: { to: string; body: string; from?: string; messagingServiceSid?: string; statusCallback?: string }): Promise<TwilioMessage> };
  /** Fetch one message (price is filled in by Twilio after the carrier reports). Default: the SDK's messages(sid).fetch(). */
  fetchMessage?(sid: string): Promise<TwilioMessage>;
};

/** Twilio reports price as a negative decimal string in priceUnit (USD for US accounts); null until finalized. */
export function twilioPriceUsd(m: Pick<TwilioMessage, "price" | "priceUnit">): number | null {
  if (m.price === null || m.price === undefined || m.price === "") return null;
  if (m.priceUnit && m.priceUnit.toUpperCase() !== "USD") return null;
  const n = Number(m.price);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/** SMS_PROVIDER=twilio: real SMS through the official `twilio` SDK (paid; trial accounts only reach verified numbers). */
export class TwilioSmsProvider implements MessageProvider {
  readonly name = "twilio";
  private client: TwilioClientLike;
  constructor(private opts: TwilioOptions, client?: TwilioClientLike) {
    if (client) this.client = client;
    else {
      const sdk = twilio(opts.accountSid, opts.authToken);
      this.client = { messages: sdk.messages as unknown as TwilioClientLike["messages"], fetchMessage: sid => sdk.messages(sid).fetch() as unknown as Promise<TwilioMessage> };
    }
  }
  async fetchMessage(sid: string): Promise<TwilioMessage> {
    if (!this.client.fetchMessage) throw new Error("Twilio client cannot fetch messages");
    return this.client.fetchMessage(sid);
  }
  async send(msg: OutboundMessage) {
    if (msg.channel !== "sms") throw new Error("TwilioSmsProvider only sends SMS");
    const sender = this.opts.messagingServiceSid ? { messagingServiceSid: this.opts.messagingServiceSid } : { from: this.opts.fromNumber! };
    const statusCallback = this.opts.statusCallbackUrl?.(msg.orgId);
    const m = await this.client.messages.create({ to: msg.recipient, body: msg.message, ...sender, ...(statusCallback ? { statusCallback } : {}) });
    const segments = Number(m.numSegments) || smsSegments(msg.message);
    return { providerMessageId: m.sid, provider: "twilio", segments, priceUsd: twilioPriceUsd(m) };
  }
}

/** Routes by channel so SMS and email use different vendors. */
export class ChannelRouter implements MessageProvider {
  readonly name: string;
  constructor(private providers: Record<Channel, MessageProvider>) { this.name = `email:${providers.email.name},sms:${providers.sms.name}`; }
  send(msg: OutboundMessage) { return this.providers[msg.channel].send(msg); }
  get sms() { return this.providers.sms; }
}

export type MessagingConfig = {
  EMAIL_PROVIDER: "log" | "smtp"; SMS_PROVIDER: "log" | "twilio";
  SMTP_HOST?: string; SMTP_PORT: number; SMTP_SECURE: boolean; SMTP_USER?: string; SMTP_PASS?: string; SMTP_FROM?: string;
  TWILIO_ACCOUNT_SID?: string; TWILIO_AUTH_TOKEN?: string; TWILIO_FROM_NUMBER?: string; TWILIO_MESSAGING_SERVICE_SID?: string;
  PUBLIC_API_URL?: string; TWILIO_STATUS_CALLBACKS?: boolean;
};

/** Twilio StatusCallback webhook (per org): POST <PUBLIC_API_URL>/webhooks/twilio/status/<orgId>. */
export const TWILIO_STATUS_PREFIX = "/webhooks/twilio/status/";

/** GSM-7 SMS: 160 chars in one segment, else 153 per segment; UCS-2 (emoji etc.): 70, else 67. */
export function smsSegments(text: string): number {
  const gsm = isGsm7(text);
  const len = gsm ? text.length : [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return len <= single ? 1 : Math.ceil(len / multi);
}

/** Builds the channel router from config (validated in config.ts, so required values are present here). */
export function createMessageProvider(c: MessagingConfig, deps: { log?: (l: string) => void } = {}): MessageProvider {
  const logProvider = new ConsoleMessageProvider(deps.log);
  const email = c.EMAIL_PROVIDER === "smtp"
    ? new SmtpEmailProvider({ host: c.SMTP_HOST!, port: c.SMTP_PORT, secure: c.SMTP_SECURE, user: c.SMTP_USER, pass: c.SMTP_PASS, from: c.SMTP_FROM! })
    : logProvider;
  const sms = c.SMS_PROVIDER === "twilio"
    ? new TwilioSmsProvider({ accountSid: c.TWILIO_ACCOUNT_SID!, authToken: c.TWILIO_AUTH_TOKEN!, fromNumber: c.TWILIO_FROM_NUMBER, messagingServiceSid: c.TWILIO_MESSAGING_SERVICE_SID,
        statusCallbackUrl: c.TWILIO_STATUS_CALLBACKS && c.PUBLIC_API_URL && !/\/\/(localhost|127\.|\[::1\])/.test(c.PUBLIC_API_URL) ? orgId => orgId ? `${c.PUBLIC_API_URL}${TWILIO_STATUS_PREFIX}${orgId}` : undefined : undefined })
    : logProvider;
  return new ChannelRouter({ email, sms });
}
