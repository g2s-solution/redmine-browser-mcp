import { z, type ZodRawShape } from "zod";
import type { RedmineClient } from "../redmine.js";
import { shapeIssue, shapeIssueRow, shapeNamed, shapeProject, shapeUser } from "./shape.js";

export interface ToolDef {
  name: string;
  description: string;
  shape: ZodRawShape;
  write: boolean;
  run: (c: RedmineClient, args: any) => Promise<unknown>;
}

const limit = z.number().int().min(1).max(100).default(25).describe("Max rows (1-100)");
const offset = z.number().int().min(0).default(0);
const issueId = z.number().int().positive();
const projectId = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe("Project identifier or numeric id");

const page = (r: any, key: string, map: (x: any) => unknown) => ({
  total: r?.total_count ?? (r?.[key] ?? []).length,
  offset: r?.offset ?? 0,
  items: (r?.[key] ?? []).map(map),
});

const listOf = (
  name: string,
  description: string,
  path: (a: any) => string,
  key: string,
  shape: ZodRawShape = {},
): ToolDef => ({
  name,
  description,
  shape,
  write: false,
  run: async (c, a) => page(await c.get(path(a), { limit: 100 }), key, shapeNamed),
});

const updateFields = {
  tracker_id: z.number().int().optional(),
  status_id: z.number().int().optional(),
  assigned_to_id: z.number().int().optional(),
  priority_id: z.number().int().optional(),
  done_ratio: z.number().int().min(0).max(100).optional(),
  fixed_version_id: z.number().int().optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  subject: z.string().min(1).optional(),
  notes: z.string().optional().describe("Comment added with this update"),
  private_notes: z.boolean().optional(),
};

const need = <T>(x: T | undefined | null, what: string): T => {
  if (x === undefined || x === null) throw new Error(`Redmine returned no ${what}`);
  return x;
};

const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const tools: ToolDef[] = [
  {
    name: "get_current_user",
    description: "Return the Redmine user the browser session is logged in as.",
    shape: {},
    write: false,
    run: async (c) => shapeUser(need((await c.get("/users/current.json"))?.user, "user")),
  },
  {
    name: "list_projects",
    description: "List projects visible to the current user.",
    write: false,
    shape: { limit, offset },
    run: async (c, a) => page(await c.get("/projects.json", a), "projects", shapeProject),
  },
  {
    name: "list_issues",
    write: false,
    description:
      "List issues. status: 'open' (default), 'closed', '*' or a status id. assigned_to_id may be 'me'. updated_since is YYYY-MM-DD. subject_contains does a substring match on the title.",
    shape: {
      project_id: projectId.optional(),
      assigned_to_id: z.union([z.number().int(), z.literal("me")]).optional(),
      status: z.string().default("open"),
      tracker_id: z.number().int().optional(),
      updated_since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      subject_contains: z.string().optional(),
      sort: z.string().default("updated_on:desc"),
      limit,
      offset,
    },
    run: async (c, a) =>
      page(
        await c.get("/issues.json", {
          project_id: a.project_id,
          assigned_to_id: a.assigned_to_id,
          status_id: a.status,
          tracker_id: a.tracker_id,
          updated_on: a.updated_since ? `>=${a.updated_since}` : undefined,
          subject: a.subject_contains ? `~${a.subject_contains}` : undefined,
          sort: a.sort,
          limit: a.limit,
          offset: a.offset,
        }),
        "issues",
        shapeIssueRow,
      ),
  },
  {
    name: "get_issue",
    write: false,
    description: "Get one issue with description, comments (journals), children, relations and attachment metadata.",
    shape: { id: issueId },
    run: async (c, a) =>
      shapeIssue(
        need(
          (await c.get(`/issues/${a.id}.json`, { include: "journals,children,relations,attachments" }))?.issue,
          "issue",
        ),
      ),
  },
  {
    name: "search_issues",
    write: false,
    description: "Full-text search over issues.",
    shape: { query: z.string().min(1), limit, offset },
    run: async (c, a) => {
      const r = await c.get("/search.json", { q: a.query, issues: 1, limit: a.limit, offset: a.offset });
      return page(r, "results", (x: any) => ({
        id: x.id,
        title: x.title,
        type: x.type,
        description: x.description,
        datetime: x.datetime,
      }));
    },
  },
  listOf("list_statuses", "List issue statuses with ids.", () => "/issue_statuses.json", "issue_statuses"),
  listOf("list_trackers", "List trackers with ids.", () => "/trackers.json", "trackers"),
  listOf(
    "list_priorities",
    "List issue priorities with ids.",
    () => "/enumerations/issue_priorities.json",
    "issue_priorities",
  ),
  listOf(
    "list_time_entry_activities",
    "List time entry activities with ids.",
    () => "/enumerations/time_entry_activities.json",
    "time_entry_activities",
  ),
  listOf(
    "list_versions",
    "List versions (milestones) of a project.",
    (a) => `/projects/${a.project_id}/versions.json`,
    "versions",
    { project_id: projectId },
  ),
  {
    name: "list_project_members",
    write: false,
    description: "List members of a project with their roles.",
    shape: { project_id: projectId },
    run: async (c, a) =>
      page(await c.get(`/projects/${a.project_id}/memberships.json`, { limit: 100 }), "memberships", (m: any) => ({
        user: m.user ? { id: m.user.id, name: m.user.name } : null,
        group: m.group ? { id: m.group.id, name: m.group.name } : null,
        roles: (m.roles ?? []).map((r: any) => r.name),
      })),
  },
  {
    name: "list_project_trackers",
    write: false,
    description:
      "List the trackers enabled for a project. create_issue silently falls back to the project's default tracker when the requested one is not enabled, so check here first.",
    shape: { project_id: projectId },
    run: async (c, a) => ({
      items: ((await c.get(`/projects/${a.project_id}.json`, { include: "trackers" }))?.project?.trackers ?? []).map(
        shapeNamed,
      ),
    }),
  },
  {
    name: "update_issue",
    write: true,
    description:
      "Update fields of an issue and/or add a comment. Only provided fields change. Check Redmine's reply: an invalid tracker or status is rejected with a validation error.",
    shape: { id: issueId, ...updateFields },
    run: async (c, a) => {
      const { id, ...fields } = a;
      const issue = strip(fields);
      if (Object.keys(issue).length === 0) throw new Error("no fields to update");
      await c.call("PUT", `/issues/${id}.json`, { body: { issue } });
      return { ok: true, id, updated: Object.keys(issue) };
    },
  },
  {
    name: "add_note",
    write: true,
    description: "Add a comment to an issue (set private=true for a private note).",
    shape: { id: issueId, notes: z.string().min(1), private: z.boolean().default(false) },
    run: async (c, a) => {
      await c.call("PUT", `/issues/${a.id}.json`, { body: { issue: { notes: a.notes, private_notes: a.private } } });
      return { ok: true, id: a.id };
    },
  },
  {
    name: "create_issue",
    write: true,
    description: "Create an issue.",
    shape: {
      project_id: projectId,
      subject: z.string().min(1),
      description: z.string().optional(),
      tracker_id: z.number().int().optional(),
      status_id: z.number().int().optional(),
      priority_id: z.number().int().optional(),
      assigned_to_id: z.number().int().optional(),
      fixed_version_id: z.number().int().optional(),
      parent_issue_id: z.number().int().optional(),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    },
    run: async (c, a) => {
      const r = await c.call<any>("POST", "/issues.json", { body: { issue: strip(a) } });
      const warning =
        a.tracker_id && r?.issue?.tracker?.id !== a.tracker_id
          ? `tracker_id ${a.tracker_id} is not enabled for this project; Redmine used "${r?.issue?.tracker?.name}" instead`
          : undefined;
      return { ok: true, issue: r?.issue ? shapeIssueRow(r.issue) : undefined, ...(warning ? { warning } : {}) };
    },
  },
  {
    name: "log_time",
    write: true,
    description: "Log spent time on an issue.",
    shape: {
      issue_id: issueId,
      hours: z.number().positive().max(24),
      activity_id: z.number().int().optional(),
      spent_on: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      comments: z.string().max(255).optional(),
    },
    run: async (c, a) => {
      const r = await c.call<any>("POST", "/time_entries.json", { body: { time_entry: strip(a) } });
      return { ok: true, id: r?.time_entry?.id };
    },
  },
];
