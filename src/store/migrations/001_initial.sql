CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  settings TEXT NOT NULL,
  UNIQUE (workspace_id, key)
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  name TEXT NOT NULL,
  owner TEXT REFERENCES principals(id),
  disabled INTEGER NOT NULL,
  CHECK ((kind = 'human' AND owner IS NULL) OR (kind = 'agent' AND owner IS NOT NULL))
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  project_ids TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  status_message TEXT NOT NULL,
  accountable TEXT NOT NULL REFERENCES principals(id),
  assignee TEXT REFERENCES principals(id),
  lease TEXT,
  parent_id TEXT REFERENCES tasks(id),
  priority INTEGER NOT NULL,
  authorization TEXT,
  progress TEXT NOT NULL,
  metadata TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX tasks_project_status ON tasks(workspace_id, project_id, status, id);

CREATE TABLE dependencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES tasks(id),
  UNIQUE (task_id, depends_on_id)
);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT,
  UNIQUE (task_id, kind, ref)
);
CREATE INDEX links_ref ON links(workspace_id, ref, task_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL REFERENCES principals(id),
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  reply_to TEXT REFERENCES comments(id),
  created_at TEXT NOT NULL
);
CREATE INDEX comments_task ON comments(workspace_id, task_id, id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL REFERENCES principals(id),
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, name, version)
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE task_labels (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  message TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  requested_by TEXT NOT NULL REFERENCES principals(id),
  state TEXT NOT NULL,
  decided_by TEXT REFERENCES principals(id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX approvals_task_state ON approvals(workspace_id, task_id, state, id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES principals(id),
  owner TEXT REFERENCES principals(id),
  data TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE idempotency_records (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, key)
);
CREATE INDEX idempotency_created ON idempotency_records(workspace_id, created_at);
