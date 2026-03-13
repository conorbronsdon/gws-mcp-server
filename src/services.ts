/**
 * Service definitions for gws MCP server.
 *
 * Each service maps to a gws CLI service and defines the subset of
 * resource.method combinations exposed as MCP tools. This curated approach
 * avoids the context bloat problem (200-400 tools) that caused the original
 * gws MCP implementation to be removed.
 */

export interface ToolDef {
  /** MCP tool name, e.g. "drive_files_list" */
  name: string;
  /** Human-readable description */
  description: string;
  /** gws CLI args, e.g. ["drive", "files", "list"] */
  command: string[];
  /** Parameters passed via --params (query/path params) */
  params: ParamDef[];
  /** Parameters passed via --json (request body) */
  bodyParams?: ParamDef[];
  /** Whether this tool accepts a file upload via --upload */
  supportsUpload?: boolean;
  /** Default params injected into every call (can be overridden by caller) */
  defaultParams?: Record<string, unknown>;
}

export interface ParamDef {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required: boolean;
}

// ── Drive ──────────────────────────────────────────────────────────────

// Shared drive defaults — injected automatically so callers never forget
const DRIVE_SHARED_DEFAULTS = { supportsAllDrives: true, includeItemsFromAllDrives: true };
const DRIVE_SHARED_DEFAULTS_NO_INCLUDE = { supportsAllDrives: true };

const driveTools: ToolDef[] = [
  {
    name: "drive_files_list",
    description: "List files in Google Drive. Supports search queries via the 'q' parameter. Shared drive files are included automatically.",
    command: ["drive", "files", "list"],
    params: [
      { name: "q", description: "Search query (e.g. \"name contains 'report'\" or \"mimeType='application/vnd.google-apps.folder'\")", type: "string", required: false },
      { name: "pageSize", description: "Max results per page (1-1000, default 100)", type: "number", required: false },
      { name: "fields", description: "Fields to include (e.g. \"files(id,name,mimeType)\")", type: "string", required: false },
      { name: "orderBy", description: "Sort order (e.g. \"modifiedTime desc\")", type: "string", required: false },
    ],
    defaultParams: DRIVE_SHARED_DEFAULTS,
  },
  {
    name: "drive_files_get",
    description: "Get a file's metadata by ID. Shared drive files are supported automatically.",
    command: ["drive", "files", "get"],
    params: [
      { name: "fileId", description: "The file ID", type: "string", required: true },
      { name: "fields", description: "Fields to include", type: "string", required: false },
    ],
    defaultParams: DRIVE_SHARED_DEFAULTS_NO_INCLUDE,
  },
  {
    name: "drive_files_create",
    description: "Create a new file in Google Drive. Use with bodyParams for metadata and optionally upload a local file.",
    command: ["drive", "files", "create"],
    params: [
      { name: "fields", description: "Fields to return (e.g. \"id,webViewLink\")", type: "string", required: false },
    ],
    bodyParams: [
      { name: "name", description: "File name", type: "string", required: true },
      { name: "mimeType", description: "MIME type (e.g. \"application/vnd.google-apps.document\")", type: "string", required: false },
      { name: "parents", description: "Parent folder IDs (JSON array as string, e.g. '[\"folderId\"]')", type: "string", required: false },
    ],
    supportsUpload: true,
    defaultParams: DRIVE_SHARED_DEFAULTS_NO_INCLUDE,
  },
  {
    name: "drive_files_copy",
    description: "Copy a file. Useful for converting formats (e.g. markdown to Google Doc).",
    command: ["drive", "files", "copy"],
    params: [
      { name: "fileId", description: "Source file ID to copy", type: "string", required: true },
      { name: "fields", description: "Fields to return", type: "string", required: false },
    ],
    bodyParams: [
      { name: "name", description: "Name for the copy", type: "string", required: true },
      { name: "mimeType", description: "Target MIME type for conversion", type: "string", required: false },
      { name: "parents", description: "Parent folder IDs (JSON array as string)", type: "string", required: false },
    ],
    defaultParams: DRIVE_SHARED_DEFAULTS_NO_INCLUDE,
  },
  {
    name: "drive_files_update",
    description: "Update a file's metadata or content.",
    command: ["drive", "files", "update"],
    params: [
      { name: "fileId", description: "The file ID to update", type: "string", required: true },
      { name: "fields", description: "Fields to return", type: "string", required: false },
    ],
    bodyParams: [
      { name: "name", description: "New file name", type: "string", required: false },
      { name: "mimeType", description: "New MIME type", type: "string", required: false },
    ],
    supportsUpload: true,
    defaultParams: DRIVE_SHARED_DEFAULTS_NO_INCLUDE,
  },
  {
    name: "drive_files_delete",
    description: "Permanently delete a file.",
    command: ["drive", "files", "delete"],
    params: [
      { name: "fileId", description: "The file ID to delete", type: "string", required: true },
    ],
    defaultParams: DRIVE_SHARED_DEFAULTS_NO_INCLUDE,
  },
  {
    name: "drive_files_export",
    description: "Export a Google Workspace file (Doc, Sheet, Slide) to a specific format. Returns JSON with export metadata. Use drive_files_download for automatic export with content returned inline.",
    command: ["drive", "files", "export"],
    params: [
      { name: "fileId", description: "The Google Workspace file ID to export", type: "string", required: true },
      { name: "mimeType", description: "Export format: text/plain, text/csv, application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document (docx), application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (xlsx)", type: "string", required: true },
    ],
  },
  {
    name: "drive_permissions_create",
    description: "Share a file by creating a permission.",
    command: ["drive", "permissions", "create"],
    params: [
      { name: "fileId", description: "The file ID to share", type: "string", required: true },
    ],
    bodyParams: [
      { name: "role", description: "Permission role: owner, organizer, fileOrganizer, writer, commenter, reader", type: "string", required: true },
      { name: "type", description: "Grantee type: user, group, domain, anyone", type: "string", required: true },
      { name: "emailAddress", description: "Email of user/group (required for user/group type)", type: "string", required: false },
    ],
  },
];

// ── Sheets ──────────────────────────────────────────────────────────────

const sheetsTools: ToolDef[] = [
  {
    name: "sheets_get",
    description: "Get spreadsheet metadata.",
    command: ["sheets", "spreadsheets", "get"],
    params: [
      { name: "spreadsheetId", description: "The spreadsheet ID", type: "string", required: true },
      { name: "includeGridData", description: "Include grid data", type: "boolean", required: false },
    ],
  },
  {
    name: "sheets_values_get",
    description: "Read values from a spreadsheet range.",
    command: ["sheets", "spreadsheets", "values", "get"],
    params: [
      { name: "spreadsheetId", description: "The spreadsheet ID", type: "string", required: true },
      { name: "range", description: "A1 notation range (e.g. \"Sheet1!A1:D10\")", type: "string", required: true },
      { name: "majorDimension", description: "ROWS or COLUMNS", type: "string", required: false },
      { name: "valueRenderOption", description: "FORMATTED_VALUE, UNFORMATTED_VALUE, or FORMULA", type: "string", required: false },
    ],
  },
  {
    name: "sheets_values_update",
    description: "Write values to a spreadsheet range.",
    command: ["sheets", "spreadsheets", "values", "update"],
    params: [
      { name: "spreadsheetId", description: "The spreadsheet ID", type: "string", required: true },
      { name: "range", description: "A1 notation range to write", type: "string", required: true },
      { name: "valueInputOption", description: "RAW or USER_ENTERED", type: "string", required: true },
    ],
    bodyParams: [
      { name: "values", description: "2D array of values as JSON string (e.g. '[[\"A\",\"B\"],[\"C\",\"D\"]]')", type: "string", required: true },
    ],
  },
  {
    name: "sheets_values_append",
    description: "Append values after the last row of a spreadsheet range.",
    command: ["sheets", "spreadsheets", "values", "append"],
    params: [
      { name: "spreadsheetId", description: "The spreadsheet ID", type: "string", required: true },
      { name: "range", description: "A1 notation range to append to", type: "string", required: true },
      { name: "valueInputOption", description: "RAW or USER_ENTERED", type: "string", required: true },
    ],
    bodyParams: [
      { name: "values", description: "2D array of values as JSON string", type: "string", required: true },
    ],
  },
];

// ── Calendar ───────────────────────────────────────────────────────────

const calendarTools: ToolDef[] = [
  {
    name: "calendar_events_list",
    description: "List events from a calendar.",
    command: ["calendar", "events", "list"],
    params: [
      { name: "calendarId", description: "Calendar ID (use 'primary' for main calendar)", type: "string", required: true },
      { name: "timeMin", description: "Lower bound (RFC3339, e.g. \"2026-03-07T00:00:00Z\")", type: "string", required: false },
      { name: "timeMax", description: "Upper bound (RFC3339)", type: "string", required: false },
      { name: "maxResults", description: "Max events to return", type: "number", required: false },
      { name: "singleEvents", description: "Expand recurring events (usually true)", type: "boolean", required: false },
      { name: "orderBy", description: "Sort order: startTime or updated", type: "string", required: false },
      { name: "q", description: "Free-text search", type: "string", required: false },
    ],
  },
  {
    name: "calendar_events_get",
    description: "Get a single calendar event by ID.",
    command: ["calendar", "events", "get"],
    params: [
      { name: "calendarId", description: "Calendar ID", type: "string", required: true },
      { name: "eventId", description: "Event ID", type: "string", required: true },
    ],
  },
  {
    name: "calendar_events_insert",
    description: "Create a new calendar event.",
    command: ["calendar", "events", "insert"],
    params: [
      { name: "calendarId", description: "Calendar ID", type: "string", required: true },
    ],
    bodyParams: [
      { name: "summary", description: "Event title", type: "string", required: true },
      { name: "start", description: "Start time JSON (e.g. '{\"dateTime\":\"2026-03-10T10:00:00-07:00\"}')", type: "string", required: true },
      { name: "end", description: "End time JSON", type: "string", required: true },
      { name: "description", description: "Event description", type: "string", required: false },
      { name: "location", description: "Event location", type: "string", required: false },
    ],
  },
  {
    name: "calendar_events_update",
    description: "Update an existing calendar event.",
    command: ["calendar", "events", "update"],
    params: [
      { name: "calendarId", description: "Calendar ID", type: "string", required: true },
      { name: "eventId", description: "Event ID to update", type: "string", required: true },
    ],
    bodyParams: [
      { name: "summary", description: "Event title", type: "string", required: false },
      { name: "start", description: "Start time JSON", type: "string", required: false },
      { name: "end", description: "End time JSON", type: "string", required: false },
      { name: "description", description: "Event description", type: "string", required: false },
    ],
  },
  {
    name: "calendar_events_delete",
    description: "Delete a calendar event.",
    command: ["calendar", "events", "delete"],
    params: [
      { name: "calendarId", description: "Calendar ID", type: "string", required: true },
      { name: "eventId", description: "Event ID to delete", type: "string", required: true },
    ],
  },
];

// ── Docs ────────────────────────────────────────────────────────────────

const docsTools: ToolDef[] = [
  {
    name: "docs_get",
    description: "Get a Google Doc's content and metadata.",
    command: ["docs", "documents", "get"],
    params: [
      { name: "documentId", description: "The document ID", type: "string", required: true },
    ],
  },
  {
    name: "docs_create",
    description: "Create a new empty Google Doc.",
    command: ["docs", "documents", "create"],
    params: [],
    bodyParams: [
      { name: "title", description: "Document title", type: "string", required: true },
    ],
  },
  {
    name: "docs_batchUpdate",
    description: "Apply updates to a Google Doc (insert text, formatting, etc).",
    command: ["docs", "documents", "batchUpdate"],
    params: [
      { name: "documentId", description: "The document ID", type: "string", required: true },
    ],
    bodyParams: [
      { name: "requests", description: "Array of update requests as JSON string", type: "string", required: true },
    ],
  },
];

// ── Gmail ───────────────────────────────────────────────────────────────

const gmailTools: ToolDef[] = [
  {
    name: "gmail_messages_list",
    description: "List Gmail messages matching a query.",
    command: ["gmail", "users", "messages", "list"],
    params: [
      { name: "userId", description: "User ID (use 'me')", type: "string", required: true },
      { name: "q", description: "Gmail search query (e.g. \"from:user@example.com subject:hello\")", type: "string", required: false },
      { name: "maxResults", description: "Max messages to return", type: "number", required: false },
      { name: "labelIds", description: "Label IDs to filter by", type: "string", required: false },
    ],
  },
  {
    name: "gmail_messages_get",
    description: "Get a single Gmail message by ID.",
    command: ["gmail", "users", "messages", "get"],
    params: [
      { name: "userId", description: "User ID (use 'me')", type: "string", required: true },
      { name: "id", description: "Message ID", type: "string", required: true },
      { name: "format", description: "Response format: full, metadata, minimal, raw", type: "string", required: false },
    ],
  },
  {
    name: "gmail_threads_list",
    description: "List Gmail threads matching a query.",
    command: ["gmail", "users", "threads", "list"],
    params: [
      { name: "userId", description: "User ID (use 'me')", type: "string", required: true },
      { name: "q", description: "Gmail search query", type: "string", required: false },
      { name: "maxResults", description: "Max threads to return", type: "number", required: false },
    ],
  },
  {
    name: "gmail_threads_get",
    description: "Get a full Gmail thread by ID (all messages in the conversation).",
    command: ["gmail", "users", "threads", "get"],
    params: [
      { name: "userId", description: "User ID (use 'me')", type: "string", required: true },
      { name: "id", description: "Thread ID", type: "string", required: true },
      { name: "format", description: "Response format: full, metadata, minimal", type: "string", required: false },
    ],
  },
];

// ── Service registry ───────────────────────────────────────────────────

export const SERVICE_TOOLS: Record<string, ToolDef[]> = {
  drive: driveTools,
  sheets: sheetsTools,
  calendar: calendarTools,
  docs: docsTools,
  gmail: gmailTools,
};

export const ALL_SERVICES = Object.keys(SERVICE_TOOLS);

export function getToolsForServices(services: string[]): ToolDef[] {
  const tools: ToolDef[] = [];
  for (const svc of services) {
    const defs = SERVICE_TOOLS[svc];
    if (defs) {
      tools.push(...defs);
    } else {
      console.error(`Unknown service: ${svc}. Available: ${ALL_SERVICES.join(", ")}`);
    }
  }
  return tools;
}
