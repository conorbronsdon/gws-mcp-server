import { describe, it, expect } from "vitest";
import { getToolsForServices, SERVICE_TOOLS, ALL_SERVICES } from "../services.js";

describe("getToolsForServices", () => {
  it("returns tools for requested services", () => {
    const tools = getToolsForServices(["drive"]);
    expect(tools.length).toBeGreaterThan(0);
    // All returned tools should be from the drive service
    for (const tool of tools) {
      expect(tool.command[0]).toBe("drive");
    }
  });

  it("returns tools for multiple services", () => {
    const tools = getToolsForServices(["drive", "sheets"]);
    const commands = new Set(tools.map((t) => t.command[0]));
    expect(commands.has("drive")).toBe(true);
    expect(commands.has("sheets")).toBe(true);
  });

  it("returns empty array for unknown services (and logs warning)", () => {
    const tools = getToolsForServices(["nonexistent"]);
    expect(tools).toEqual([]);
  });

  it("skips unknown services but includes valid ones", () => {
    const tools = getToolsForServices(["drive", "nonexistent"]);
    expect(tools.length).toBe(SERVICE_TOOLS["drive"].length);
  });

  it("returns all tools when given all services", () => {
    const tools = getToolsForServices(ALL_SERVICES);
    const totalExpected = Object.values(SERVICE_TOOLS).reduce((sum, arr) => sum + arr.length, 0);
    expect(tools.length).toBe(totalExpected);
  });
});

describe("tool definitions integrity", () => {
  const allTools = getToolsForServices(ALL_SERVICES);

  it("all tool names are unique", () => {
    const names = allTools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("all tools have required fields", () => {
    for (const tool of allTools) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe("string");
      expect(Array.isArray(tool.command)).toBe(true);
      expect(tool.command.length).toBeGreaterThan(0);
      expect(Array.isArray(tool.params)).toBe(true);
    }
  });

  it("has correct tool counts per service", () => {
    expect(SERVICE_TOOLS["drive"].length).toBe(8);
    expect(SERVICE_TOOLS["sheets"].length).toBe(4);
    expect(SERVICE_TOOLS["calendar"].length).toBe(5);
    expect(SERVICE_TOOLS["docs"].length).toBe(3);
    expect(SERVICE_TOOLS["gmail"].length).toBe(4);
  });

  it("total tool count is 24", () => {
    expect(allTools.length).toBe(24);
  });

  it("all params have required fields", () => {
    for (const tool of allTools) {
      const allParams = [...tool.params, ...(tool.bodyParams || [])];
      for (const p of allParams) {
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
        expect(["string", "number", "boolean"]).toContain(p.type);
        expect(typeof p.required).toBe("boolean");
      }
    }
  });
});
