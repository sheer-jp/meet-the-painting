import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { readdirSync, existsSync, statSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// works/<id>/ の絵と generated/ を dist/works/<id>/ にコピーする（dev ではそのまま root から配信される）
function copyWorks(): Plugin {
  return {
    name: 'copy-works',
    apply: 'build',
    closeBundle() {
      const src = resolve('works');
      const dst = resolve('dist/works');
      if (!existsSync(src)) return;
      for (const id of readdirSync(src)) {
        const dir = join(src, id);
        if (!statSync(dir).isDirectory()) continue;
        const copyDir = (from: string, to: string) => {
          if (!existsSync(from)) return;
          mkdirSync(to, { recursive: true });
          for (const f of readdirSync(from)) {
            const p = join(from, f);
            if (statSync(p).isDirectory()) copyDir(p, join(to, f));
            // stories.json と translations.json は生成の入力。作家が確認していない物語の下書きが入るので公開しない（DECISIONS 73）
            else if (!/\.(wav|json\.bak)$/.test(f) && f !== 'stories.json' && f !== 'translations.json') copyFileSync(p, join(to, f));
          }
        };
        copyDir(join(dir, 'generated'), join(dst, id, 'generated'));
        for (const f of ['voice.mp3', 'work.json']) {
          if (existsSync(join(dir, f))) {
            mkdirSync(join(dst, id), { recursive: true });
            copyFileSync(join(dir, f), join(dst, id, f));
          }
        }
      }
    },
  };
}

// UI 文言は日本語と英語だけをページ用 JS に入れ、ほかの言語は dist/i18n/<lang>.json に分ける（11-07 作家「うちは日本語と英語が一番」）。
// 正本は src/i18n/ui.json のまま。dev とテストでは全言語が入る（apply: 'build'）。言語の名前（lang_names）は選択欄に要るので全部残す
function splitUi(): Plugin {
  const CORE = new Set(['ja', 'en']);
  const uiPath = resolve('src/i18n/ui.json');
  return {
    name: 'split-ui',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== uiPath) return null;
      const all = JSON.parse(code) as Record<string, Record<string, string>>;
      const core: Record<string, Record<string, string>> = {};
      for (const [k, v] of Object.entries(all)) core[k] = k === 'lang_names' ? v : Object.fromEntries(Object.entries(v).filter(([l]) => CORE.has(l)));
      return { code: JSON.stringify(core), map: null };
    },
    generateBundle() {
      const all = JSON.parse(readFileSync(uiPath, 'utf8')) as Record<string, Record<string, string>>;
      const byLang: Record<string, Record<string, string>> = {};
      for (const [k, v] of Object.entries(all)) {
        if (k === 'lang_names') continue;
        for (const [l, s] of Object.entries(v)) if (!CORE.has(l)) (byLang[l] ||= {})[k] = s;
      }
      for (const [l, dict] of Object.entries(byLang)) this.emitFile({ type: 'asset', fileName: `i18n/${l}.json`, source: JSON.stringify(dict) });
    },
  };
}

// 受付 index.html、ギャラリー gallery/index.html、w/<id>/index.html を MPA の入力にする
function workPages(): Record<string, string> {
  const inputs: Record<string, string> = { main: resolve('index.html') };
  // ギャラリー /gallery/（docs/ENTRANCE.md 4 節）。generate が作る。w/*/index.html と同じ扱い
  const gallery = resolve('gallery/index.html');
  if (existsSync(gallery)) inputs.gallery = gallery;
  const wdir = resolve('w');
  if (existsSync(wdir)) {
    for (const id of readdirSync(wdir)) {
      const p = join(wdir, id, 'index.html');
      if (existsSync(p)) inputs[`w-${id}`] = p;
    }
  }
  return inputs;
}

export default defineConfig(({ command, isPreview }) => ({
  // ホスティングのパスに依存しないよう相対にする（独自ドメインでも project site でも動く）
  base: './',
  plugins: [...(command === 'serve' && !isPreview ? [basicSsl()] : []), splitUi(), copyWorks()],
  build: {
    target: 'es2022',
    rollupOptions: { input: workPages() },
    chunkSizeWarningLimit: 900,
  },
  server: { host: true, port: 5173 },
}));
