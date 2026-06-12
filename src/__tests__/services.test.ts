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
    expect(SERVICE_TOOLS["gmail"].length).toBe(5);
    expect(SERVICE_TOOLS["tasks"].length).toBe(14);
  });

  it("total tool count is 39", () => {
    expect(allTools.length).toBe(39);
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

describe("tasks service shape", () => {
  const tasksTools = SERVICE_TOOLS["tasks"];

  it("all tools route to the 'tasks' gws service", () => {
    for (const tool of tasksTools) {
      expect(tool.command[0]).toBe("tasks");
    }
  });

  it("exposes both tasklists and tasks resources", () => {
    const resources = new Set(tasksTools.map((t) => t.command[1]));
    expect(resources.has("tasklists")).toBe(true);
    expect(resources.has("tasks")).toBe(true);
  });

  it("requires 'tasklist' on every tasklists method except list and insert", () => {
    const tasklists = tasksTools.filter((t) => t.command[1] === "tasklists");
    for (const tool of tasklists) {
      const method = tool.command[2];
      if (method === "list" || method === "insert") continue;
      const tasklistParam = tool.params.find((p) => p.name === "tasklist");
      expect(tasklistParam?.required, `${tool.name} should require 'tasklist'`).toBe(true);
    }
  });

  it("requires 'tasklist' on every tasks method", () => {
    const taskOps = tasksTools.filter((t) => t.command[1] === "tasks");
    for (const tool of taskOps) {
      const tasklistParam = tool.params.find((p) => p.name === "tasklist");
      expect(tasklistParam?.required, `${tool.name} should require 'tasklist'`).toBe(true);
    }
  });

  it("requires 'task' on per-task operations (get, update, patch, move, delete)", () => {
    const PER_TASK_METHODS = new Set(["get", "update", "patch", "move", "delete"]);
    const perTask = tasksTools.filter(
      (t) => t.command[1] === "tasks" && PER_TASK_METHODS.has(t.command[2]),
    );
    for (const tool of perTask) {
      const taskParam = tool.params.find((p) => p.name === "task");
      expect(taskParam?.required, `${tool.name} should require 'task'`).toBe(true);
    }
  });

  it("declares bodyParams on insert/update/patch and only those", () => {
    const NEEDS_BODY = new Set(["insert", "update", "patch"]);
    for (const tool of tasksTools) {
      const method = tool.command[2];
      const hasBody = Array.isArray(tool.bodyParams) && tool.bodyParams.length > 0;
      if (NEEDS_BODY.has(method)) {
        expect(hasBody, `${tool.name} should declare bodyParams`).toBe(true);
      } else {
        expect(hasBody, `${tool.name} should not declare bodyParams`).toBe(false);
      }
    }
  });
});
