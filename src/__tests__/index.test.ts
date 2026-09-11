import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { buildZodSchema, makeTmpFileName, buildTransferOwnershipRequest, buildProposeOwnershipTransferRequest } from "../index.js";
import { SERVICE_TOOLS, type ToolDef } from "../services.js";

describe("buildZodSchema", () => {
  it("rejects unsupported ownership transfers while accepting non-owner permission roles", () => {
    const tool = SERVICE_TOOLS.drive.find((t) => t.name === "drive_permissions_update")!;
    const schema = z.object(buildZodSchema(tool));
    const args = { fileId: "file123", permissionId: "perm456" };
    for (const role of ["owner", "writter", "", undefined]) {
      expect(schema.safeParse({ ...args, role }).success, String(role)).toBe(false);
    }
    for (const role of ["organizer", "fileOrganizer", "writer", "commenter", "reader"]) {
      expect(schema.parse({ ...args, role })).toEqual({ ...args, role });
    }
  });

  it("maps string params to z.string()", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [
        { name: "q", description: "query", type: "string", required: true },
      ],
    };
    const schema = buildZodSchema(tool);
    expect(schema.q).toBeDefined();
    // Required string: should accept a string
    const result = schema.q.safeParse("hello");
    expect(result.success).toBe(true);
    // Should reject non-string
    const bad = schema.q.safeParse(123);
    expect(bad.success).toBe(false);
  });

  it("maps enum-constrained string params to z.enum — out-of-set values never reach the wire", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [
        { name: "sendUpdates", description: "who gets email", type: "string", required: false, enum: ["all", "externalOnly", "none"] },
      ],
    };
    const schema = buildZodSchema(tool);
    for (const ok of ["all", "externalOnly", "none"]) {
      expect(schema.sendUpdates.safeParse(ok).success).toBe(true);
    }
    // Must-fail leg: values outside the set are rejected at the boundary.
    expect(schema.sendUpdates.safeParse("EVERYONE_LOL").success).toBe(false);
    expect(schema.sendUpdates.safeParse("al").success).toBe(false);
    // Optional still holds: omitting the param entirely stays valid.
    expect(schema.sendUpdates.safeParse(undefined).success).toBe(true);
  });

  it("maps number params to z.number()", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [
        { name: "count", description: "count", type: "number", required: true },
      ],
    };
    const schema = buildZodSchema(tool);
    const result = schema.count.safeParse(42);
    expect(result.success).toBe(true);
    const bad = schema.count.safeParse("not a number");
    expect(bad.success).toBe(false);
  });

  it("maps boolean params to z.boolean()", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [
        { name: "flag", description: "flag", type: "boolean", required: true },
      ],
    };
    const schema = buildZodSchema(tool);
    const result = schema.flag.safeParse(true);
    expect(result.success).toBe(true);
    const bad = schema.flag.safeParse("true");
    expect(bad.success).toBe(false);
  });

  it("makes required params required and optional params optional", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [
        { name: "required_field", description: "required", type: "string", required: true },
        { name: "optional_field", description: "optional", type: "string", required: false },
      ],
    };
    const schema = buildZodSchema(tool);

    // Required field should reject undefined
    const reqResult = schema.required_field.safeParse(undefined);
    expect(reqResult.success).toBe(false);

    // Optional field should accept undefined
    const optResult = schema.optional_field.safeParse(undefined);
    expect(optResult.success).toBe(true);
  });

  it("includes bodyParams in the schema", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [
        { name: "id", description: "ID", type: "string", required: true },
      ],
      bodyParams: [
        { name: "title", description: "title", type: "string", required: true },
      ],
    };
    const schema = buildZodSchema(tool);
    expect(schema.id).toBeDefined();
    expect(schema.title).toBeDefined();
  });

  it("adds uploadPath only when supportsUpload is true", () => {
    const toolWithUpload: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [],
      supportsUpload: true,
    };
    const toolWithoutUpload: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [],
    };

    const schemaWith = buildZodSchema(toolWithUpload);
    const schemaWithout = buildZodSchema(toolWithoutUpload);

    expect(schemaWith.uploadPath).toBeDefined();
    // uploadPath should be optional
    const result = schemaWith.uploadPath.safeParse(undefined);
    expect(result.success).toBe(true);

    expect(schemaWithout.uploadPath).toBeUndefined();
  });

  it("does not add uploadPath when supportsUpload is false/undefined", () => {
    const tool: ToolDef = {
      name: "test",
      description: "test",
      command: ["test"],
      params: [],
      supportsUpload: false,
    };
    const schema = buildZodSchema(tool);
    expect(schema.uploadPath).toBeUndefined();
  });
});

describe("makeTmpFileName", () => {
  // The gws CLI rejects --output paths that resolve outside the current
  // working directory (issue #3: os.tmpdir() fails on macOS because
  // /var -> /private/var canonicalization lands outside CWD).
  it("returns a CWD-relative name, never an absolute path", () => {
    const name = makeTmpFileName("gws-dl");
    expect(isAbsolute(name)).toBe(false);
    expect(name.startsWith("/")).toBe(false);
    expect(name.startsWith("\\")).toBe(false);
  });

  it("contains no path separators (stays in CWD)", () => {
    const name = makeTmpFileName("gws-dl");
    expect(name).not.toMatch(/[/\\]/);
  });

  it("uses the dotfile prefix and a random hex suffix", () => {
    const name = makeTmpFileName("gws-dl");
    expect(name).toMatch(/^\.gws-dl-[0-9a-f]{16}$/);
  });

  it("generates unique names per call", () => {
    expect(makeTmpFileName("gws-dl")).not.toBe(makeTmpFileName("gws-dl"));
  });

  it("relative name round-trips through fs create/exists/unlink (cleanup path)", () => {
    const name = makeTmpFileName("gws-dl-test");
    writeFileSync(name, "x");
    expect(existsSync(name)).toBe(true);
    unlinkSync(name);
    expect(existsSync(name)).toBe(false);
  });
});

// ── Ownership transfer request builders (#60 review fix) ───────────────
// The first version of drive_permissions_transferOwnership declared
// pendingOwner as an ordinary ToolDef boolean bodyParam. It required
// `true`, but nothing enforced that: buildZodSchema mapped it to
// unconstrained z.boolean(), and buildArgs forwarded whatever the caller
// sent. A caller passing pendingOwner:false got silently granted plain
// writer access instead of an ownership proposal, despite the tool's name.
// The fix isn't a stricter validator — it's that these two functions have
// no `pendingOwner`/`role`/`type`/`transferOwnership` parameter at all, so
// there is no code path for a caller-supplied value to reach them. These
// tests confirm the actual returned request shape, not just that the
// functions exist.

describe("buildTransferOwnershipRequest (same-organization Workspace transfer)", () => {
  it("always sends role=owner, type=user, transferOwnership=true, regardless of extra caller-shaped input", () => {
    const { params, body } = buildTransferOwnershipRequest("file123", "newowner@example.com");
    expect(params).toEqual({ fileId: "file123", supportsAllDrives: true, transferOwnership: true });
    expect(body).toEqual({ role: "owner", type: "user", emailAddress: "newowner@example.com" });
  });

  it("has no parameter through which a caller could set role, type, or transferOwnership", () => {
    // Structural, not a runtime check: buildTransferOwnershipRequest's own
    // signature is (fileId, emailAddress, opts) — opts only accepts
    // moveToNewOwnersRoot/fields. Calling it with an extra field a caller
    // might try to sneak in has no effect, because the body is built as a
    // fresh object literal, never a spread of caller input.
    const sneaky = { moveToNewOwnersRoot: true, role: "writer", type: "domain" } as {
      moveToNewOwnersRoot?: boolean;
    };
    const { body } = buildTransferOwnershipRequest("file123", "newowner@example.com", sneaky);
    expect(body).toEqual({ role: "owner", type: "user", emailAddress: "newowner@example.com" });
  });

  it("passes moveToNewOwnersRoot and fields through alongside the fixed params", () => {
    const { params } = buildTransferOwnershipRequest("file123", "newowner@example.com", {
      moveToNewOwnersRoot: true,
      fields: "id,role,type,emailAddress",
    });
    expect(params).toEqual({
      fileId: "file123",
      supportsAllDrives: true,
      transferOwnership: true,
      moveToNewOwnersRoot: true,
      fields: "id,role,type,emailAddress",
    });
  });
});

describe("buildProposeOwnershipTransferRequest (consumer / cross-organization)", () => {
  it("always sends role=writer, type=user, pendingOwner=true — never pendingOwner:false", () => {
    // The exact regression this pins: there is no `pendingOwner` parameter
    // on this function for a caller to set to false in the first place.
    const { params, body } = buildProposeOwnershipTransferRequest("file123", "newowner@example.com");
    expect(params).toEqual({ fileId: "file123", supportsAllDrives: true });
    expect(body).toEqual({ role: "writer", type: "user", pendingOwner: true, emailAddress: "newowner@example.com" });
    expect(body.pendingOwner).not.toBe(false);
  });

  it("passes moveToNewOwnersRoot and fields through alongside the fixed params", () => {
    const { params } = buildProposeOwnershipTransferRequest("file123", "newowner@example.com", {
      moveToNewOwnersRoot: true,
      fields: "id,role,type,pendingOwner",
    });
    expect(params).toEqual({
      fileId: "file123",
      supportsAllDrives: true,
      moveToNewOwnersRoot: true,
      fields: "id,role,type,pendingOwner",
    });
  });
});
