CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  space_url TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  update_token TEXT NOT NULL,
  UNIQUE(space_url, project_id)
);
CREATE TABLE history (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  summary TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(client_id, period_from, period_to)
);
