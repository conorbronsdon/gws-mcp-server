import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildZodSchema } from "../index.js";
import type { ToolDef } from "../services.js";

describe("buildZodSchema", () => {
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
