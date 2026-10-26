import type { Channel } from "../types.js";

export type OutboundMessage = { channel: Channel; recipient: string; message: string; subject?: string | null };

/** Implement this for Twilio, SendGrid, Postmark, etc. Keep credentials server-side. */
export interface MessageProvider {
  readonly name: string;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
}

/** Logs instead of sending. The default in development. */
export class ConsoleMessageProvider implements MessageProvider {
  readonly name = "console";
  readonly sent: OutboundMessage[] = [];
  constructor(private log: (line: string) => void = console.log) {}
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    const masked = msg.recipient.replace(/^(.{3}).*(.{2})$/, "$1***$2");
    this.log(`[${this.name.toUpperCase()} ${msg.channel.toUpperCase()}] to=${masked}${msg.subject ? ` subject="${msg.subject}"` : ""} body="${msg.message}"`);
    return { providerMessageId: `console-${Date.now()}-${this.sent.length}` };
  }
}

/** Routes by channel so SMS and email can use different vendors. */
export class ChannelRouter implements MessageProvider {
  readonly name = "router";
  constructor(private providers: Record<Channel, MessageProvider>) {}
  send(msg: OutboundMessage) { return this.providers[msg.channel].send(msg); }
}

export function createMessageProvider(_opts: { sms: "console"; email: "console" }, log?: (l: string) => void): MessageProvider {
  // Add real providers here, e.g. `sms: opts.sms === "twilio" ? new TwilioProvider(...) : console`.
  const consoleProvider = new ConsoleMessageProvider(log);
  return new ChannelRouter({ sms: consoleProvider, email: consoleProvider });
}
