import type { Channel } from "../types.js";

export async function sendMessage(input: {
  channel: Channel; recipient: string; message: string; subject?: string | null;
}) {
  // Demo adapter only. Replace with a real provider SDK/API.
  // Keep provider credentials on the server and implement retries/webhooks.
  console.log(`[DEMO ${input.channel.toUpperCase()}] to=${input.recipient}`);
  if (input.channel === "email") console.log(`subject=${input.subject ?? "(no subject)"}`);
  console.log(input.message);
  return { providerMessageId: `console-${Date.now()}` };
}
