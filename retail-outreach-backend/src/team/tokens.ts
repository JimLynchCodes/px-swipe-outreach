import { createHash, randomBytes } from "node:crypto";

/** 256-bit URL-safe secret. Only its SHA-256 is stored, so a database leak can't be used to accept invites. */
export const newInviteToken = () => randomBytes(32).toString("base64url");
export const hashInviteToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
