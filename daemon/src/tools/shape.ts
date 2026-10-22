const name = (x: any) => (x ? x.name : null);

export const shapeUser = (u: any) => ({ id: u.id, login: u.login, name: u.name ?? `${u.firstname ?? ""} ${u.lastname ?? ""}`.trim(), mail: u.mail });

export const shapeProject = (p: any) => ({ id: p.id, identifier: p.identifier, name: p.name, status: p.status, description: p.description });

export const shapeIssueRow = (i: any) => ({
  id: i.id,
  project: name(i.project),
  tracker: name(i.tracker),
  status: name(i.status),
  priority: name(i.priority),
  subject: i.subject,
  assignee: name(i.assigned_to),
  author: name(i.author),
  done_ratio: i.done_ratio,
  due_date: i.due_date ?? null,
  updated_on: i.updated_on,
});

const MAX_JOURNAL_TEXT = 2000;
const clip = (s: string | undefined) => (s && s.length > MAX_JOURNAL_TEXT ? s.slice(0, MAX_JOURNAL_TEXT) + "…[truncated]" : s);

export const shapeIssue = (i: any) => ({
  ...shapeIssueRow(i),
  description: clip(i.description),
  start_date: i.start_date ?? null,
  fixed_version: name(i.fixed_version),
  parent: i.parent?.id ?? null,
  custom_fields: (i.custom_fields ?? []).map((f: any) => ({ name: f.name, value: f.value })),
  children: (i.children ?? []).map((c: any) => ({ id: c.id, subject: c.subject, tracker: name(c.tracker) })),
  relations: (i.relations ?? []).map((r: any) => ({ type: r.relation_type, issue_id: r.issue_id, issue_to_id: r.issue_to_id })),
  attachments: (i.attachments ?? []).map((a: any) => ({ id: a.id, filename: a.filename, size: a.filesize })),
  journals: (i.journals ?? []).map((j: any) => ({
    id: j.id,
    user: name(j.user),
    created_on: j.created_on,
    private: !!j.private_notes,
    notes: clip(j.notes),
    changes: (j.details ?? []).map((d: any) => ({ property: d.property, name: d.name, old: d.old_value, new: d.new_value })),
  })),
});

export const shapeNamed = (x: any) => ({ id: x.id, name: x.name, ...(x.is_closed !== undefined ? { is_closed: x.is_closed } : {}), ...(x.is_default !== undefined ? { is_default: x.is_default } : {}) });
