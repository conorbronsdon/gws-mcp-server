/**
 * Typed error hierarchy for gws CLI errors.
 *
 * Ported from podcastindex-mcp's typed-error pattern (v0.3.0), but adapted to
 * a different boundary: podcastindex-mcp wraps an axios HTTP client, so it
 * maps `error.response.status` straight to a typed error. gws-mcp-server has
 * no HTTP client of its own — it spawns the `gws` CLI as a subprocess (see
 * `executeGws()` in ./executor.ts) and only ever sees plain text: the
 * process's stderr/stdout, or an `Error.message` string from a rejected
 * spawn promise. There is no `.status` field to read.
 *
 * `mapGwsErrorToTyped()` recovers a status-like code from that raw text (see
 * `extractGwsErrorDetail()`) and maps it to one of these classes, so callers
 * can branch on error type with `instanceof` instead of grepping message
 * strings. `executeGws()` catches the raw error, builds a typed error here,
 * and uses its fully-formatted `.message` as `ExecResult.error` — each
 * subclass builds its own human-readable message so formatting logic lives
 * in one place.
 */

export class GwsError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GwsError";
    this.status = status;
    Object.setPrototypeOf(this, GwsError.prototype);
  }
}

/** 401/403 — bad, missing, or expired gws CLI credentials. */
export class AuthenticationError extends GwsError {
  constructor(detail: string, status: number) {
    super(
      `Authentication error (${status}): ${detail}. Check that the gws CLI is authenticated ("gws auth login") and that the credentials have access to the requested Google Workspace resource.`,
      status
    );
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/** 429 — too many requests against a Google Workspace API. */
export class RateLimitError extends GwsError {
  constructor(detail: string, status: number) {
    super(
      `Rate limit error (${status}): ${detail}. Slow down requests to the Google Workspace API and try again shortly.`,
      status
    );
    this.name = "RateLimitError";
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/** 400 — malformed or invalid request parameters. */
export class ValidationError extends GwsError {
  constructor(detail: string, status: number) {
    super(
      `Validation error (${status}): ${detail}. Check the arguments passed to this tool.`,
      status
    );
    this.name = "ValidationError";
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * 404 — the requested resource does not exist, or isn't visible to the
 * authenticated account. `driveHint` preserves the original executor.ts
 * behavior: Drive 404s get an actionable hint about shared-drive access.
 */
export class NotFoundError extends GwsError {
  constructor(detail: string, status: number, driveHint = false) {
    let message = `Not found (${status}): ${detail}.`;
    if (driveHint) {
      message +=
        "\n\nHint: If this file is in a shared drive, ensure supportsAllDrives is set (this should be automatic). Check that the file ID is correct and the authenticated account has access.";
    }
    super(message, status);
    this.name = "NotFoundError";
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/** 5xx — failure on Google's side. */
export class ServerError extends GwsError {
  constructor(detail: string, status: number) {
    super(
      `Server error (${status}): ${detail}. The Google Workspace API may be experiencing issues — try again later.`,
      status
    );
    this.name = "ServerError";
    Object.setPrototypeOf(this, ServerError.prototype);
  }
}

/** Result of pulling a status-like code + detail message out of raw CLI error text. */
export interface GwsErrorInfo {
  status?: number;
  detail: string;
}

/**
 * Pulls a status code + detail message out of the gws CLI's raw error text.
 *
 * There is no HTTP response object at this boundary (see module doc above)
 * — just a string. Google Workspace API errors surface in that string in
 * one of two shapes, and this applies podcastindex-mcp's "JSON vs
 * plain-text body" lesson to a CLI boundary instead of an HTTP one:
 *
 *  1. A raw JSON error body the CLI printed as-is. Google's own API error
 *     shape is `{"error":{"code":404,"message":"...","errors":[...]}}` —
 *     some CLI tools print this verbatim on failure.
 *  2. Plain text containing an HTTP-status-like token, e.g. "Error 403: ...",
 *     "404 not found", "googleapi: Error 429: quota exceeded".
 *
 * If neither pattern is found, `status` is left undefined — this is the
 * legacy fallback: the original message is returned unchanged so callers
 * don't force a typed error (with invented wording) onto CLI text that
 * carries no recognizable status code.
 */
export function extractGwsErrorDetail(rawMessage: string): GwsErrorInfo {
  // 1. JSON body embedded in the message (Google API's {error:{code,message}} shape).
  const jsonMatch = rawMessage.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const code = parsed?.error?.code;
      const msg = parsed?.error?.message;
      if (typeof code === "number" && typeof msg === "string" && msg.length > 0) {
        return { status: code, detail: msg };
      }
    } catch {
      // Not valid JSON (or not the expected shape) — fall through to plain-text matching.
    }
  }

  // 2. Plain text containing an HTTP-status-like 3-digit token.
  const textMatch = rawMessage.match(/\b(400|401|403|404|429|5\d{2})\b/);
  if (textMatch) {
    return { status: Number(textMatch[1]), detail: rawMessage };
  }

  // 3. Legacy fallback — no recognizable status code anywhere in the message.
  return { detail: rawMessage };
}

/**
 * Maps the gws CLI's raw error text to the appropriate typed error.
 *
 * `command` is the tool's `ToolDef.command` (e.g. `["drive", "files", "get"]`)
 * — used only to decide whether a 404 should carry the Drive shared-drive
 * hint that `executeGws()` used to append inline (see ./executor.ts history).
 *
 * Falls back to the base `GwsError` (message passed through unchanged) when
 * no status-like code can be recovered from the text — never invents a
 * status for CLI text that doesn't carry one.
 */
export function mapGwsErrorToTyped(rawMessage: string, command: string[]): GwsError {
  const { status, detail } = extractGwsErrorDetail(rawMessage);

  if (status === undefined) {
    return new GwsError(rawMessage);
  }

  if (status === 401 || status === 403) return new AuthenticationError(detail, status);
  if (status === 429) return new RateLimitError(detail, status);
  if (status === 400) return new ValidationError(detail, status);
  if (status === 404) return new NotFoundError(detail, status, command[0] === "drive");
  if (status >= 500) return new ServerError(detail, status);

  return new GwsError(`API error (${status}): ${detail}`, status);
}
