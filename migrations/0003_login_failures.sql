-- 管理ページのログインの失敗の回数（docs/ADMIN.md 5 節）。key は IP の /64 を日替わりの秘密でハッシュしたもの。15 分で消す。生の IP は入れない
CREATE TABLE login_failures (
  key TEXT PRIMARY KEY,
  first_at INTEGER NOT NULL,      -- ミリ秒
  n INTEGER NOT NULL
);
