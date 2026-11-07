-- 1 日の上限のための数（docs/ADMIN.md 2 節）。日と名前ごとの回数だけ。IP や本文は入れない
CREATE TABLE daily_counts (
  day TEXT NOT NULL,              -- YYYY-MM-DD（日本時間）
  name TEXT NOT NULL,             -- stat_events / followup_ai
  n INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);
