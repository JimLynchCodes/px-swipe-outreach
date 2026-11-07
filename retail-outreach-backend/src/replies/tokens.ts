import { randomBytes } from "node:crypto";

/** Per-message reply-to token for outbound email (reply+<token>@INBOUND_EMAIL_DOMAIN). */
export const newReplyToken = () => randomBytes(18).toString("base64url");
