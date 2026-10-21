-- 旧設定と旧履歴を残し、対象月を明示した新しい工数管理を追加する。
CREATE TABLE client_months (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  monthly_hours REAL NOT NULL CHECK(monthly_hours >= 0),
  carry_over_hours REAL NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY(client_id, month)
);
CREATE TABLE additional_hours (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  month TEXT NOT NULL,
  hours REAL NOT NULL CHECK(hours > 0),
  memo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY(client_id, month) REFERENCES client_months(client_id, month) ON DELETE CASCADE
);
CREATE INDEX additional_hours_month ON additional_hours(client_id, month);
CREATE TABLE monthly_results (
  client_id TEXT NOT NULL,
  month TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  fetched_by TEXT NOT NULL,
  PRIMARY KEY(client_id, month),
  FOREIGN KEY(client_id, month) REFERENCES client_months(client_id, month) ON DELETE CASCADE
);
