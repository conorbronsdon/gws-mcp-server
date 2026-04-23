import { describe, it, expect } from "vitest";
import { base64url, encodeHeader, buildRfc2822 } from "../mime.js";

// ── base64url ───────────────────────────────────────────────────────────

describe("base64url", () => {
  it("encodes plain ASCII", () => {
    // "Hello" → SGVsbG8 (no padding)
    expect(base64url("Hello")).toBe("SGVsbG8");
  });

  it("replaces + and / with - and _", () => {
    // Bytes that produce '+' and '/' in standard base64:
    // 0xfb, 0xff, 0xbf → +/+/ in standard base64 → -_-_ in base64url
    const input = Buffer.from([0xfb, 0xff, 0xbf]).toString("utf-8");
    const out = base64url(input);
    expect(out).not.toMatch(/[+/=]/);
  });

  it("strips padding", () => {
    // "f" base64 → "Zg==" → "Zg" in base64url
    expect(base64url("f")).toBe("Zg");
    expect(base64url("fo")).toBe("Zm8");
  });

  it("round-trips through base64url decode", () => {
    const original = "Hi Amy,\r\nThanks for the pitch.";
    const encoded = base64url(original);
    // Reverse the URL-safe substitutions and re-pad before decoding
    const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
    expect(Buffer.from(padded, "base64").toString("utf-8")).toBe(original);
  });
});

// ── encodeHeader ────────────────────────────────────────────────────────

describe("encodeHeader", () => {
  it("returns ASCII unchanged", () => {
    expect(encodeHeader("Re: Podcast Guest")).toBe("Re: Podcast Guest");
  });

  it("RFC 2047 B-encodes non-ASCII", () => {
    const out = encodeHeader("Café meeting");
    expect(out.startsWith("=?UTF-8?B?")).toBe(true);
    expect(out.endsWith("?=")).toBe(true);
    // Decode the inner base64 and verify
    const inner = out.slice("=?UTF-8?B?".length, -2);
    expect(Buffer.from(inner, "base64").toString("utf-8")).toBe("Café meeting");
  });

  it("treats em-dash as non-ASCII (encodes it)", () => {
    const out = encodeHeader("Validation — not generation");
    expect(out.startsWith("=?UTF-8?B?")).toBe(true);
  });

  it("handles empty string", () => {
    expect(encodeHeader("")).toBe("");
  });
});

// ── buildRfc2822 ────────────────────────────────────────────────────────

describe("buildRfc2822", () => {
  it("requires 'to'", () => {
    expect(() => buildRfc2822({ to: "" })).toThrow("'to' is required");
  });

  it("uses CRLF line separators and a blank line before the body", () => {
    const msg = buildRfc2822({
      to: "amy@example.com",
      subject: "Hi",
      body: "Hello.",
    });
    // Headers are CRLF-separated and end with a blank CRLF before the body
    expect(msg).toMatch(/\r\n\r\nHello\.$/);
    // No bare LFs outside of the body
    const headerSection = msg.split("\r\n\r\n")[0];
    expect(headerSection.includes("\n")).toBe(true); // contains \n as part of \r\n
    // No \n that isn't preceded by \r
    expect(/[^\r]\n/.test(headerSection)).toBe(false);
  });

  it("emits To, Subject, MIME-Version, Content-Type for plain text", () => {
    const msg = buildRfc2822({
      to: "amy@example.com",
      subject: "Re: Podcast Guest",
      body: "Hi Amy,",
    });
    expect(msg).toContain("To: amy@example.com");
    expect(msg).toContain("Subject: Re: Podcast Guest");
    expect(msg).toContain("MIME-Version: 1.0");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).toContain("Content-Transfer-Encoding: 8bit");
  });

  it("includes Cc and Bcc when provided", () => {
    const msg = buildRfc2822({
      to: "a@x.com",
      cc: "b@x.com",
      bcc: "c@x.com",
      body: "hi",
    });
    expect(msg).toContain("Cc: b@x.com");
    expect(msg).toContain("Bcc: c@x.com");
  });

  it("omits Cc/Bcc when not provided", () => {
    const msg = buildRfc2822({ to: "a@x.com", body: "hi" });
    expect(msg).not.toContain("Cc:");
    expect(msg).not.toContain("Bcc:");
  });

  it("includes In-Reply-To and References for threading", () => {
    const msg = buildRfc2822({
      to: "amy@example.com",
      subject: "Re: x",
      body: "hi",
      inReplyTo: "<abc@mail.gmail.com>",
      references: "<abc@mail.gmail.com> <def@mail.gmail.com>",
    });
    expect(msg).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(msg).toContain("References: <abc@mail.gmail.com> <def@mail.gmail.com>");
  });

  it("emits text/html when only htmlBody is provided", () => {
    const msg = buildRfc2822({
      to: "a@x.com",
      htmlBody: "<p>Hi</p>",
    });
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(msg).not.toContain("multipart/alternative");
    expect(msg.endsWith("<p>Hi</p>")).toBe(true);
  });

  it("emits multipart/alternative when both body and htmlBody are provided", () => {
    const msg = buildRfc2822({
      to: "a@x.com",
      subject: "s",
      body: "Hello.",
      htmlBody: "<p>Hello.</p>",
      boundary: "BOUNDARY_TEST",
    });
    expect(msg).toContain('Content-Type: multipart/alternative; boundary="BOUNDARY_TEST"');
    expect(msg).toContain("--BOUNDARY_TEST\r\n");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(msg).toContain("Hello.");
    expect(msg).toContain("<p>Hello.</p>");
    expect(msg.trimEnd().endsWith("--BOUNDARY_TEST--")).toBe(true);
  });

  it("handles empty body (no body and no htmlBody) by producing headers + blank body", () => {
    const msg = buildRfc2822({ to: "a@x.com", subject: "ping" });
    expect(msg).toContain("To: a@x.com");
    expect(msg).toContain("Subject: ping");
    expect(msg).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(msg.endsWith("\r\n\r\n")).toBe(true);
  });

  it("RFC 2047-encodes a Subject containing non-ASCII", () => {
    const msg = buildRfc2822({
      to: "a@x.com",
      subject: "Café",
      body: "hi",
    });
    expect(msg).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it("includes From only when explicitly provided", () => {
    const without = buildRfc2822({ to: "a@x.com", body: "hi" });
    expect(without.split("\r\n\r\n")[0].includes("From:")).toBe(false);

    const withFrom = buildRfc2822({ to: "a@x.com", body: "hi", from: "me@x.com" });
    expect(withFrom).toContain("From: me@x.com");
  });

  it("preserves header ordering: From, To, Cc, Bcc, Subject, In-Reply-To, References, MIME-Version, Content-Type", () => {
    const msg = buildRfc2822({
      to: "a@x.com",
      cc: "b@x.com",
      bcc: "c@x.com",
      subject: "s",
      body: "hi",
      from: "me@x.com",
      inReplyTo: "<abc@x>",
      references: "<abc@x>",
    });
    const headerSection = msg.split("\r\n\r\n")[0];
    const lines = headerSection.split("\r\n");
    const headerNames = lines.map((l) => l.split(":")[0]);
    expect(headerNames).toEqual([
      "From",
      "To",
      "Cc",
      "Bcc",
      "Subject",
      "In-Reply-To",
      "References",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
  });
});
