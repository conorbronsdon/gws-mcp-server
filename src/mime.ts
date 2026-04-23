/**
 * RFC 2822 message construction for the Gmail API.
 *
 * Used by gmail_drafts_create. Construction is deliberately minimal — no
 * attachments, single text/plain or text/html body, optional multipart/alternative
 * when both are provided. Output is plain RFC 2822 text; callers are expected
 * to base64url-encode it before handing to Gmail's `raw` field.
 */

import { randomBytes } from "node:crypto";

export interface MimeOptions {
  /** Recipient(s). Comma-separated for multiple, e.g. "a@x.com, b@y.com" */
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Plain-text body */
  body?: string;
  /** HTML body. If both body and htmlBody are set, output is multipart/alternative. */
  htmlBody?: string;
  /** Message-ID of the message being replied to (improves threading). */
  inReplyTo?: string;
  /** Space-separated Message-IDs of ancestor messages. */
  references?: string;
  /** Optional explicit From; usually omitted so Gmail fills in the authenticated user. */
  from?: string;
  /** Override the multipart boundary for deterministic test output. */
  boundary?: string;
}

/**
 * Reject CR or LF in a header value to prevent header injection.
 * Email header injection lets an attacker inject extra headers (Bcc, etc.)
 * or even body content by smuggling \r\n into a value that's concatenated
 * directly into the header section. Subject is protected indirectly via
 * encodeHeader (which base64-encodes anything outside printable ASCII), but
 * address fields and Message-ID headers go in raw, so they need this guard.
 */
function assertNoCrlf(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`buildRfc2822: '${name}' must not contain CR or LF characters`);
  }
}

/**
 * Validate a multipart boundary against the RFC 2046 token charset.
 * `boundary` is exported through MimeOptions for deterministic test output,
 * which means a malicious caller could otherwise smuggle CR/LF or quote
 * characters into the Content-Type header. RFC 2046 defines bcharsnospace
 * as: DIGIT / ALPHA / "'" / "(" / ")" / "+" / "_" / "," / "-" / "." / "/"
 *     / ":" / "=" / "?"
 * (space is also allowed mid-string but disallowed as the trailing char;
 * we forbid it entirely for simplicity). Length is capped at 70 per spec.
 */
function assertSafeBoundary(value: string): void {
  if (value.length === 0 || value.length > 70) {
    throw new Error("buildRfc2822: 'boundary' must be 1-70 characters");
  }
  if (!/^[A-Za-z0-9'()+,./:=?_-]+$/.test(value)) {
    throw new Error("buildRfc2822: 'boundary' must contain only RFC 2046 token characters");
  }
}

/** Encode a UTF-8 string to base64url (RFC 4648 §5). */
export function base64url(input: string): string {
  return Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Encode a header value containing non-ASCII characters per RFC 2047 (B-encoding).
 * Pure-ASCII values pass through unchanged so common headers stay readable.
 */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

/** Build an RFC 2822 message string. */
export function buildRfc2822(opts: MimeOptions): string {
  if (!opts.to) throw new Error("buildRfc2822: 'to' is required");

  // Guard every value that lands in a header against CRLF injection.
  assertNoCrlf("to", opts.to);
  if (opts.cc) assertNoCrlf("cc", opts.cc);
  if (opts.bcc) assertNoCrlf("bcc", opts.bcc);
  if (opts.from) assertNoCrlf("from", opts.from);
  if (opts.inReplyTo) assertNoCrlf("inReplyTo", opts.inReplyTo);
  if (opts.references) assertNoCrlf("references", opts.references);
  // Subject is also guarded — encodeHeader would base64-encode CRLF, which
  // makes injection impossible but silently mangles the subject. Better to
  // surface the error.
  if (opts.subject !== undefined) assertNoCrlf("subject", opts.subject);
  // Boundary lands in the Content-Type header, so it needs the same protection
  // as a header value — plus structural validation so it can't break out of
  // the quoted parameter syntax.
  if (opts.boundary !== undefined) assertSafeBoundary(opts.boundary);

  const headers: string[] = [];
  if (opts.from) headers.push(`From: ${opts.from}`);
  headers.push(`To: ${opts.to}`);
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);
  if (opts.subject !== undefined) headers.push(`Subject: ${encodeHeader(opts.subject)}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  headers.push("MIME-Version: 1.0");

  const hasText = opts.body !== undefined && opts.body !== "";
  const hasHtml = opts.htmlBody !== undefined && opts.htmlBody !== "";

  if (!hasText && !hasHtml) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    return headers.join("\r\n") + "\r\n\r\n";
  }

  if (hasText && hasHtml) {
    const boundary = opts.boundary || `==COT_GWS_MCP_${randomBytes(8).toString("hex")}==`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      `${opts.body}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      `${opts.htmlBody}\r\n` +
      `--${boundary}--\r\n`;
    return headers.join("\r\n") + "\r\n\r\n" + body;
  }

  const contentType = hasHtml ? "text/html" : "text/plain";
  const content = hasHtml ? opts.htmlBody! : opts.body!;
  headers.push(`Content-Type: ${contentType}; charset="UTF-8"`);
  headers.push("Content-Transfer-Encoding: 8bit");
  return headers.join("\r\n") + "\r\n\r\n" + content;
}
