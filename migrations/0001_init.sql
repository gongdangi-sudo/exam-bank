CREATE TABLE IF NOT EXISTS problems(
id TEXT PRIMARY KEY,subject TEXT,exam TEXT,year TEXT,no TEXT,unit TEXT,subunit TEXT,type TEXT,
question TEXT,choices TEXT,answer TEXT,explanation TEXT,original_explanation TEXT,edited_explanation TEXT,
status TEXT,data TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ps ON problems(subject);
CREATE INDEX IF NOT EXISTS idx_pse ON problems(subject,exam);
CREATE INDEX IF NOT EXISTS idx_psy ON problems(subject,year);
CREATE INDEX IF NOT EXISTS idx_pu ON problems(unit);
CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL);
