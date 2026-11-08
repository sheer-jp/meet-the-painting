// ローカルの wrangler pages dev と tests/admin-e2e.mjs のための .dev.vars を、その場で作ったテスト用の値で出す（リポジトリに資格情報を置かない）
// 使い方：node tests/make-dev-vars.mjs > .dev.vars
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../functions/_lib/admin-auth.js';

const password = randomBytes(18).toString('base64url');
console.log(`ADMIN_USERNAME=e2e-owner
ADMIN_PASSWORD_HASH=${await hashPassword(password)}
ADMIN_SESSION_SECRET=${randomBytes(48).toString('base64url')}
ADMIN_E2E_PASSWORD=${password}
PUBLISH_TOKEN=${randomBytes(36).toString('base64url')}`);
