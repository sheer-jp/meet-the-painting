-- 作品の登録の下書き（docs/REGISTER.md 4 節）。会話の文は入れない。入れるのは項目の値と、作家が確定した文だけ
-- 写真は R2（WORK_UPLOADS）の photo_key に置く。本番へは作家の確認のあとで流す（docs/REGISTER.md「実装の記録」）
CREATE TABLE work_drafts (
  id TEXT PRIMARY KEY,                -- 下書きの id（ランダム）
  work_id TEXT,                       -- 作品の id（URL になる）。題名が決まるまで null
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'building', 'published', 'failed')),
  data TEXT NOT NULL DEFAULT '{}',    -- { work（work.json の形の確定した値）, proposed（作家の確認待ち）, skipped, colors }
  photo_key TEXT,                     -- R2 の鍵（縮めて EXIF を消した写真）
  photo_type TEXT,                    -- image/jpeg | image/png
  photo_w INTEGER,
  photo_h INTEGER,
  photo_bytes INTEGER,
  stripe_product_id TEXT,             -- 支払いリンク（R4 で使う）
  stripe_price_id TEXT,
  stripe_link_id TEXT,
  publish_session_id TEXT,            -- 公開の記録（R2・R3）
  publish_commit TEXT,
  publish_deploy_url TEXT,
  publish_page_url TEXT,
  publish_log TEXT,                   -- 失敗したときの最後の 40 行
  created_at INTEGER NOT NULL,        -- ミリ秒
  updated_at INTEGER NOT NULL,
  queued_at INTEGER,
  published_at INTEGER
);
CREATE INDEX idx_work_drafts_status ON work_drafts(status, queued_at);
CREATE INDEX idx_work_drafts_updated ON work_drafts(updated_at DESC);
CREATE UNIQUE INDEX idx_work_drafts_work_id ON work_drafts(work_id) WHERE work_id IS NOT NULL;
