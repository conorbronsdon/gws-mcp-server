import { describe, it, expect } from "vitest";
import { getToolsForServices, SERVICE_TOOLS, ALL_SERVICES, buildAnnotations, type ToolDef } from "../services.js";

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

// ── Tool annotations (issue #5) ──────────────────────────────────────────

describe("buildAnnotations mapping", () => {
  const mk = (flags: Partial<ToolDef>): ToolDef => ({
    name: "x",
    description: "x",
    command: ["x"],
    params: [],
    ...flags,
  });

  it("readOnly:true -> { readOnlyHint: true } and no destructiveHint", () => {
    const a = buildAnnotations(mk({ readOnly: true }));
    expect(a).toEqual({ readOnlyHint: true });
    expect(a.destructiveHint).toBeUndefined();
  });

  it("destructive:true -> { readOnlyHint: false, destructiveHint: true }", () => {
    const a = buildAnnotations(mk({ destructive: true }));
    expect(a).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it("no flags (additive write) -> { readOnlyHint: false } and no destructiveHint", () => {
    const a = buildAnnotations(mk({}));
    expect(a).toEqual({ readOnlyHint: false });
    expect(a.destructiveHint).toBeUndefined();
  });

  it("readOnly wins if both flags are set (defensive)", () => {
    const a = buildAnnotations(mk({ readOnly: true, destructive: true }));
    expect(a).toEqual({ readOnlyHint: true });
  });
});

describe("tool annotation classifications", () => {
  const allTools = getToolsForServices(ALL_SERVICES);
  const byName = new Map(allTools.map((t) => [t.name, t]));

  it("every *_list and *_get tool is read-only", () => {
    const reads = allTools.filter(
      (t) => t.name.endsWith("_list") || t.name.endsWith("_get"),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const tool of reads) {
      const a = buildAnnotations(tool);
      expect(a.readOnlyHint, `${tool.name} should be readOnlyHint:true`).toBe(true);
      expect(a.destructiveHint, `${tool.name} should not be destructive`).toBeUndefined();
    }
  });

  it("every *_delete tool is destructive", () => {
    const deletes = allTools.filter((t) => t.name.endsWith("_delete"));
    expect(deletes.length).toBeGreaterThan(0);
    for (const tool of deletes) {
      const a = buildAnnotations(tool);
      expect(a.readOnlyHint, `${tool.name} should be readOnlyHint:false`).toBe(false);
      expect(a.destructiveHint, `${tool.name} should be destructiveHint:true`).toBe(true);
    }
  });

  it("named destructive tools carry destructiveHint:true", () => {
    const expectDestructive = [
      "drive_files_delete",
      "calendar_events_delete",
      "tasks_tasklists_delete",
      "tasks_tasks_delete",
      "tasks_tasks_clear",
    ];
    for (const name of expectDestructive) {
      const tool = byName.get(name)!;
      expect(tool, `${name} should exist`).toBeDefined();
      expect(buildAnnotations(tool).destructiveHint, name).toBe(true);
    }
  });

  it("named read tools carry readOnlyHint:true", () => {
    const expectReadOnly = [
      "drive_files_list", "drive_files_get", "drive_files_export",
      "sheets_get", "sheets_values_get",
      "calendar_events_list", "calendar_events_get",
      "docs_get",
      "gmail_messages_list", "gmail_messages_get", "gmail_threads_list", "gmail_threads_get",
      "tasks_tasklists_list", "tasks_tasklists_get", "tasks_tasks_list", "tasks_tasks_get",
    ];
    for (const name of expectReadOnly) {
      const tool = byName.get(name)!;
      expect(tool, `${name} should exist`).toBeDefined();
      expect(buildAnnotations(tool).readOnlyHint, name).toBe(true);
    }
  });

  it("additive writes are readOnlyHint:false with no destructiveHint", () => {
    const expectAdditive = [
      "drive_files_create", "drive_files_copy", "drive_files_update", "drive_permissions_create",
      "sheets_values_update", "sheets_values_append",
      "calendar_events_insert", "calendar_events_update",
      "docs_create", "docs_batchUpdate",
      "tasks_tasklists_insert", "tasks_tasklists_update", "tasks_tasklists_patch",
      "tasks_tasks_insert", "tasks_tasks_update", "tasks_tasks_patch", "tasks_tasks_move",
    ];
    for (const name of expectAdditive) {
      const tool = byName.get(name)!;
      const a = buildAnnotations(tool);
      expect(a.readOnlyHint, name).toBe(false);
      expect(a.destructiveHint, name).toBeUndefined();
    }
  });

  it("gmail_threads_modify is a non-destructive write (TRASH is reversible)", () => {
    // Judgment call: this tool can apply the TRASH label, but label changes
    // are reversible, so it stays readOnlyHint:false without destructiveHint.
    const tool = byName.get("gmail_threads_modify")!;
    const a = buildAnnotations(tool);
    expect(a.readOnlyHint).toBe(false);
    expect(a.destructiveHint).toBeUndefined();
  });

  it("completeness: every registry tool carries exactly one classification", () => {
    // No tool can have both flags; every tool yields an explicit readOnlyHint
    // so future additions cannot slip through unclassified.
    for (const tool of allTools) {
      expect(
        !(tool.readOnly && tool.destructive),
        `${tool.name} cannot be both readOnly and destructive`,
      ).toBe(true);
      const a = buildAnnotations(tool);
      expect(typeof a.readOnlyHint, `${tool.name} must declare readOnlyHint`).toBe("boolean");
    }
  });

  it("classification counts match the intended split (16 read / 5 destructive / 18 additive)", () => {
    const read = allTools.filter((t) => buildAnnotations(t).readOnlyHint === true).length;
    const destructive = allTools.filter((t) => buildAnnotations(t).destructiveHint === true).length;
    const additive = allTools.filter(
      (t) => buildAnnotations(t).readOnlyHint === false && !buildAnnotations(t).destructiveHint,
    ).length;
    expect(read).toBe(16);
    expect(destructive).toBe(5);
    expect(additive).toBe(18);
    expect(read + destructive + additive).toBe(allTools.length);
  });
});
