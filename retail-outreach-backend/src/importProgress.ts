/** NDJSON progress stream for CSV import writes (Accept: application/x-ndjson). */
import type { FastifyReply, FastifyRequest } from "fastify";

export type ImportProgressEvent =
  | { type: "progress"; phase: "writing"; done: number; total: number }
  | { type: "done"; [k: string]: unknown }
  | { type: "error"; code: string; error: string };

export function wantsProgressStream(request: FastifyRequest): boolean {
  const accept = String(request.headers.accept ?? "");
  return accept.includes("application/x-ndjson") || (request.query as { progress?: string })?.progress === "1";
}

/** Hijack the reply and write NDJSON lines. Caller must not also send a normal JSON body. */
export function beginProgressStream(reply: FastifyReply): {
  write: (ev: ImportProgressEvent) => void;
  end: () => void;
} {
  const raw = reply.raw;
  if (!raw.headersSent) {
    raw.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
  }
  reply.hijack();
  return {
    write: (ev) => { raw.write(JSON.stringify(ev) + "\n"); },
    end: () => { raw.end(); },
  };
}
