import { describe, it, expect } from "vitest";
import {
  GwsError,
  AuthenticationError,
  RateLimitError,
  ValidationError,
  NotFoundError,
  ServerError,
  extractGwsErrorDetail,
  mapGwsErrorToTyped,
} from "../errors.js";

describe("typed error hierarchy", () => {
  it("every subclass extends GwsError, which extends Error", () => {
    expect(new AuthenticationError("bad creds", 401)).toBeInstanceOf(GwsError);
    expect(new RateLimitError("slow down", 429)).toBeInstanceOf(GwsError);
    expect(new ValidationError("bad param", 400)).toBeInstanceOf(GwsError);
    expect(new NotFoundError("no such file", 404)).toBeInstanceOf(GwsError);
    expect(new ServerError("oops", 500)).toBeInstanceOf(GwsError);
    expect(new GwsError("generic")).toBeInstanceOf(Error);
  });

  it("each subclass sets a distinct .name", () => {
    expect(new AuthenticationError("x", 401).name).toBe("AuthenticationError");
    expect(new RateLimitError("x", 429).name).toBe("RateLimitError");
    expect(new ValidationError("x", 400).name).toBe("ValidationError");
    expect(new NotFoundError("x", 404).name).toBe("NotFoundError");
    expect(new ServerError("x", 500).name).toBe("ServerError");
    expect(new GwsError("x").name).toBe("GwsError");
  });

  it("carries the status code on .status", () => {
    expect(new AuthenticationError("x", 403).status).toBe(403);
    expect(new RateLimitError("x", 429).status).toBe(429);
  });

  it("NotFoundError appends the Drive shared-drive hint only when driveHint is true", () => {
    const withHint = new NotFoundError("File not found: abc123", 404, true);
    expect(withHint.message).toContain("Hint: If this file is in a shared drive");

    const withoutHint = new NotFoundError("Spreadsheet not found: abc123", 404, false);
    expect(withoutHint.message).not.toContain("Hint:");
  });
});

describe("extractGwsErrorDetail", () => {
  it("extracts code + message from a raw JSON error body (Google API's own shape)", () => {
    const raw = '{"error":{"code":404,"message":"File not found: abc123.","errors":[{"reason":"notFound"}]}}';
    const result = extractGwsErrorDetail(raw);
    expect(result.status).toBe(404);
    expect(result.detail).toBe("File not found: abc123.");
  });

  it("extracts code + message from JSON embedded alongside other CLI text", () => {
    const raw = 'gws: command failed\n{"error":{"code":403,"message":"Insufficient permissions"}}\n';
    const result = extractGwsErrorDetail(raw);
    expect(result.status).toBe(403);
    expect(result.detail).toBe("Insufficient permissions");
  });

  it("extracts a plain-text HTTP-status-like token", () => {
    const raw = "googleapi: Error 429: Quota exceeded for quota metric, rateLimitExceeded";
    const result = extractGwsErrorDetail(raw);
    expect(result.status).toBe(429);
    expect(result.detail).toBe(raw);
  });

  it("extracts a plain-text status token in a different phrasing", () => {
    const raw = "404 not found: spreadsheet does not exist";
    const result = extractGwsErrorDetail(raw);
    expect(result.status).toBe(404);
  });

  it("falls back with no status when neither pattern matches (legacy fallback)", () => {
    const raw = "connect ECONNREFUSED 127.0.0.1:443";
    const result = extractGwsErrorDetail(raw);
    expect(result.status).toBeUndefined();
    expect(result.detail).toBe(raw);
  });

  it("falls back when braces are present but not valid/expected-shape JSON", () => {
    const raw = "Unexpected token in template {{name}} not resolved";
    const result = extractGwsErrorDetail(raw);
    expect(result.status).toBeUndefined();
    expect(result.detail).toBe(raw);
  });
});

describe("mapGwsErrorToTyped", () => {
  it("maps 401 and 403 to AuthenticationError", () => {
    expect(mapGwsErrorToTyped("Error 401: invalid credentials", ["gmail"])).toBeInstanceOf(AuthenticationError);
    expect(mapGwsErrorToTyped("Error 403: forbidden", ["drive"])).toBeInstanceOf(AuthenticationError);
  });

  it("includes gws CLI auth guidance in the AuthenticationError message", () => {
    const err = mapGwsErrorToTyped("Error 401: invalid credentials", ["gmail"]);
    expect(err.message).toContain("Authentication error (401)");
    expect(err.message).toContain("gws auth login");
  });

  it("maps 429 to RateLimitError", () => {
    const err = mapGwsErrorToTyped("googleapi: Error 429: rateLimitExceeded", ["gmail"]);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toContain("Rate limit error (429)");
  });

  it("maps 400 to ValidationError", () => {
    const err = mapGwsErrorToTyped("Error 400: missing required field 'q'", ["sheets"]);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Validation error (400)");
  });

  it("maps 404 to NotFoundError", () => {
    const err = mapGwsErrorToTyped('{"error":{"code":404,"message":"Task not found"}}', ["tasks"]);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain("Not found (404)");
  });

  it("maps 5xx to ServerError", () => {
    expect(mapGwsErrorToTyped("Error 500: internal error", ["calendar"])).toBeInstanceOf(ServerError);
    expect(mapGwsErrorToTyped("Error 503: service unavailable", ["calendar"])).toBeInstanceOf(ServerError);
    const err = mapGwsErrorToTyped("Error 500: internal error", ["calendar"]);
    expect(err.message).toContain("Server error (500)");
  });

  it("appends the Drive shared-drive hint on a 404 for a drive command", () => {
    const err = mapGwsErrorToTyped("googleapi: Error 404: File not found: abc123", ["drive", "files", "get"]);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toContain("Hint: If this file is in a shared drive");
  });

  it("does not append the Drive hint on a 404 for a non-drive command", () => {
    const err = mapGwsErrorToTyped("googleapi: Error 404: Spreadsheet not found", ["sheets", "spreadsheets", "get"]);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).not.toContain("Hint:");
  });

  it("legacy fallback: passes the original message through unchanged when no status is found", () => {
    const raw = "connect ECONNREFUSED 127.0.0.1:443";
    const err = mapGwsErrorToTyped(raw, ["drive", "files", "list"]);
    expect(err).toBeInstanceOf(GwsError);
    expect(err.status).toBeUndefined();
    expect(err.message).toBe(raw);
  });
});
