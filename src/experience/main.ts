// 「入る」後に読まれる体験バンドル。space.json を読み、流体が使えれば物語モード / 空間モード、使えなければ静止画モード
import * as THREE from 'three';
import { Fluid, placementFor, type Quality } from '../fluid/Fluid';
import { Soundscape } from '../audio/Soundscape';
import { buildHud } from './hud';
import { StoryMode } from '../story/StoryMode';
import { ensureLang, type Lang } from '../i18n';
import type { Space } from './types';

export interface RunOptions {
  workId: string; lang: Lang; vr: boolean; fromQr: boolean; debug: boolean;
  sound?: Soundscape; xrSession?: XRSession | null; onExit?: () => void;
}

const loadTexture = (url: string) => new Promise<THREE.Texture>((res, rej) => new THREE.TextureLoader().load(url, res, undefined, rej));

// 'rooms'：終わりの画面の「部屋で見る」で閉じた。呼び出し側が部屋の欄へ連れていく
export async function run(o: RunOptions): Promise<'exit' | 'rooms'> {
  // ?space=flat：空間モードを WebXR 無しの平面カメラで動かす検査モード（docs/VR_DEPTH.md 5 節、V-4）。流体は VR と同じ等距離円筒
  const flatSpace = new URLSearchParams(location.search).get('space') === 'flat';
  if (flatSpace) o = { ...o, vr: true, xrSession: null };
  // 作品ページは /w/<id>/ にあるので既定は ../../。別の場所に置くとき（アーティファクトなど）は meta で差し替える
  const assetBase = document.querySelector<HTMLMetaElement>('meta[name="asset-base"]')?.content ?? '../../';
  const base = `${assetBase}works/${o.workId}/`;
  const [space] = await Promise.all([fetch(base + 'generated/space.json').then((r) => { if (!r.ok) throw new Error('space.json ' + r.status); return r.json() as Promise<Space>; }), ensureLang(o.lang)]);   // 日英以外の文言も読み終えてから HUD を作る
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = document.getElementById('stage')!;
  const prevFocus = document.activeElement as HTMLElement | null;
  stage.hidden = false;
  // 入り：白い面がふわっと重なる（docs/DESIGN.md「11-08 磨き込み（プロユース）」の出現 280ms ease-out。前の画面から 1 コマで切り替えない）
  stage.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'cubic-bezier(.2,.7,.3,1)' });
  document.body.style.overflow = 'hidden';
  // 物語の画面の裏（作品ページの main、受付の .cg など stage の外）を inert に。Tab が裏へ抜けないように（AUDIT-1 P1-1。受付の setBehind と同じ考え方）
  const behind = setBehind(stage);
  // Tab を物語の画面の中で回す（最後の次は最初へ。ページの外へ抜けない）
  const trap = (e: KeyboardEvent) => { if (e.key === 'Tab') trapTab(stage, e); };
  document.addEventListener('keydown', trap);
  // 後片付け。途中で例外が出ても（hud や流体を作る前でも）裏の inert と Tab の捕捉を必ず戻す（REVIEW-2 P2）
  let hud: ReturnType<typeof buildHud> | null = null;
  let sound: Soundscape | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let fluid: Fluid | null = null;
  let canvas: HTMLCanvasElement | null = null;
  const exit = () => {
    try { hud?.dispose(); sound?.dispose(); fluid?.dispose(); renderer?.dispose(); canvas?.remove(); } catch (e) { console.warn('後片付けに失敗', e); }
    stage.hidden = true; document.body.style.overflow = '';
    fadeVeil();
    behind.forEach((el) => { el.inert = false; });
    document.removeEventListener('keydown', trap);
    o.onExit?.();
    // フォーカスを「絵の世界をのぞく」へ返す（受付から入ったときは、押したボタンへ）
    const back = document.getElementById('enter') ?? prevFocus;
    if (back && back.isConnected) back.focus({ preventScroll: true });
  };
  try {
    sound = o.sound ?? new Soundscape();
    await sound.unlock();
    hud = buildHud(stage, o.lang, { fromQr: o.fromQr, debug: o.debug, hasRooms: (space.rooms?.length ?? 0) > 0, contact: space.contact });
    hud.close.focus({ preventScroll: true });

    canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    let relief: THREE.Texture | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(innerWidth, innerHeight, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // ?space=flat&spin=1（録画用）：平面カメラを左右に ±40° ゆっくり振る（正弦、周期 16 秒）
      if (flatSpace && new URLSearchParams(location.search).get('spin') === '1') {
        const draw = renderer.render.bind(renderer);
        renderer.render = (scene, cam) => { if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) cam.rotation.y = (40 * Math.PI / 180) * Math.sin((performance.now() / 16000) * 2 * Math.PI); draw(scene, cam); };
      }
      if (Fluid.supported(renderer)) {
        // 物語モードは絵だけの領域（解像度を絵に全部使う）、VR は等距離円筒。色場の初期値は写真のフル解像度
        const [painting, flow] = await Promise.all([loadTexture(base + 'generated/' + (space.painting_full || space.painting)), loadTexture(base + 'generated/' + space.flow.texture)]);
        painting.minFilter = THREE.LinearFilter; painting.generateMipmaps = false;
        flow.minFilter = THREE.LinearFilter; flow.generateMipmaps = false;
        // 絵の具の厚みの初期値（無い・読めない作品は平ら）
        relief = space.relief ? await loadTexture(base + 'generated/' + space.relief.texture).catch(() => null) : null;
        if (relief) { relief.minFilter = THREE.LinearFilter; relief.generateMipmaps = false; }
        // ?debug=1&q=medium などで品質を固定できる（スクリーンショットの確認用）
        const forced = o.debug ? new URLSearchParams(location.search).get('q') : null;
        const quality: Quality = forced === 'high' || forced === 'medium' || forced === 'low' ? forced : o.vr ? 'high' : (/Mobi|Android/i.test(navigator.userAgent) ? 'medium' : space.fluid.quality || 'high');
        fluid = new Fluid(renderer, { ...space.fluid, quality });
        fluid.init(painting, flow, { ...space.fluid, quality, speed: reduced ? space.fluid.speed * 0.3 : space.fluid.speed, tempo: reduced ? (space.fluid.tempo ?? 0.6) * 0.5 : space.fluid.tempo }, placementFor(space.aspect), space.back_color, lighten(space.back_color), o.vr ? 'equirect' : 'painting', space.aspect, relief);
        // コンテキスト喪失（iOS のバックグラウンド復帰など）→ 静止画モードに落とす
        canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('WebGL context lost'); }, { once: true });
      }
    } catch (e) {
      console.warn('流体を初期化できない。静止画モードへ', e);
      fluid = null;
    }

    const ctx = { renderer, fluid, relief, space, sound, hud, lang: o.lang, reduced, fromQr: o.fromQr, base, debug: o.debug, canvas };
    let fellBack = false;
    if (o.vr && renderer && fluid) {
      const { SpaceMode } = await import('../space/SpaceMode');
      const r = await new SpaceMode({ ...ctx, renderer, fluid }, o.xrSession ?? null, flatSpace).start();
      fellBack = r === 'fallback';
    }
    if (!o.vr || fellBack || !renderer || !fluid) {
      fluid?.reset();
      if (await new StoryMode(ctx).start() === 'rooms') return 'rooms';
    }
    return 'exit';
  } finally {
    exit();
  }
}

// stage から body までの各階層で、stage の側でない兄弟を inert にする。もともと inert だったものは触らない（戻すときも）
function setBehind(stage: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let el: HTMLElement | null = stage; el && el !== document.body; el = el.parentElement) {
    for (const sib of el.parentElement ? [...el.parentElement.children] : []) {
      if (sib === el || !(sib instanceof HTMLElement) || sib.inert || /^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) continue;
      sib.inert = true; out.push(sib);
    }
  }
  return out;
}

// stage の中の、いま操作できる要素の間で Tab を回す
function trapTab(stage: HTMLElement, e: KeyboardEvent) {
  const f = [...stage.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !(el as HTMLButtonElement).disabled && !el.closest('[inert], [hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
  if (!f.length) return;
  const i = f.indexOf(document.activeElement as HTMLElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
}

function lighten(hex: string) {
  const c = new THREE.Color(hex); c.lerp(new THREE.Color('#ffffff'), 0.18); return '#' + c.getHexString();
}

// 出：stage は同期で隠し（呼び出し側と感想カードが #stage[hidden] を見る）、その上に同じ白の幕を 1 枚置いて 180ms ease-in で消す
function fadeVeil() {
  if (!document.body.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;   // reduced-motion は退場を動かさない（すぐ消す）
  const veil = document.createElement('div');
  veil.className = 'stage-veil'; veil.setAttribute('aria-hidden', 'true');
  veil.style.cssText = 'position:fixed;inset:0;z-index:50;background:#fff;pointer-events:none';
  document.body.appendChild(veil);
  veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished.then(() => veil.remove(), () => veil.remove());
  setTimeout(() => veil.remove(), 260);   // 描画が止まっていて（裏のタブなど）アニメーションが進まなくても、必ず片付ける
}
