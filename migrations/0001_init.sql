-- 感想と出来事（docs/ADMIN.md 2 節）。IP・メールアドレス・User-Agent・位置の列は作らない
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,            -- ブラウザが作るランダムな id（再送で二重にしない）
  created_at INTEGER NOT NULL,    -- ミリ秒
  work_id TEXT NOT NULL,
  reaction TEXT,                  -- love / curious / unsure / null
  body TEXT,                      -- 訪れた人が「作家に届ける」を押した文
  lang TEXT NOT NULL,
  place TEXT NOT NULL,            -- story_end / after / exit / rooms / dwell / link
  sid TEXT                        -- タブごとの匿名 id。流れとつなぐだけ
);
CREATE INDEX idx_feedback_created ON feedback(created_at DESC);
CREATE INDEX idx_feedback_work ON feedback(work_id, created_at DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,            -- ミリ秒
  sid TEXT NOT NULL,              -- タブごとの匿名 id
  ev TEXT NOT NULL,
  work_id TEXT,
  detail TEXT,                    -- ストックの文か決まった語だけ（サーバーが照合する。自由入力は入らない）
  lang TEXT
);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_sid ON events(sid, at);
