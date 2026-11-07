// 物語モード（PC・スマホ）：T0 絵 → T1〜T2 近づきながら溶けて渦に吸い込まれる → T3 流れと語り → T4 余韻 → T5 終わり
import * as THREE from 'three';
import { touchStroke, touchVortex, tapStrength, TOUCH_TAP_MAX, type Fluid } from '../fluid/Fluid';
import { SHADING, LIGHT_DIR, lookOf, shadingUniforms, updateShading } from '../fluid/shading';
import type { Soundscape } from '../audio/Soundscape';
import type { Hud } from '../experience/hud';
import type { Space } from '../experience/types';
import { ScreenText } from '../text/FloatingText';
import { pick, t, type Lang } from '../i18n';
import { screenTextTiming } from '../text/timing';
import { mountRoomArt, roomBox, canMove, popWorthy, mountDragPop, type RoomArt, type DragPop } from '../ui/roomArt';
import { setPhrases } from '../text/phrases';
import { Particles } from '../space/Particles';

// 文が終わったあと、流れを味わう時間（秒）。11-07 作家「文の長さは作品で違うので、終わってから 10 秒ほど楽しんで遷移。離脱させない」。docs/EXPERIENCE.md 3 節 T3
const AFTER_TEXT_S = 10;
const INTRO_SKIP_SPEED = 6;   // 「次へ」を押したあと、入りの場面（T0〜T2）を何倍で進めるか

// 物語の終わり方。rooms は終わりの画面の「部屋で見る」（作品ページの #rooms へ）
export type StoryEnd = 'again' | 'exit' | 'rooms';

export interface StoryCtx {
  renderer: THREE.WebGLRenderer | null; fluid: Fluid | null; space: Space; sound: Soundscape; hud: Hud; lang: Lang;
  reduced: boolean; fromQr: boolean; base: string; debug: boolean; canvas: HTMLCanvasElement;
  relief?: THREE.Texture | null;   // 絵の具の厚みの初期値（look.dots の作品のドットの粒に使う）
}

// 表示：質感（SHADING）+ 視界の回転（入りの渦）+ 周辺減光
const DISPLAY_FRAG = /* glsl */ `
varying vec2 vUv; uniform vec4 uView; uniform float uFade;
uniform vec3 uLight;
uniform float uRot;          // 視界の回転（ラジアン、反時計回り）。画面の中心のまわりに、画素の縦横比を保って回す
uniform vec2 uRotCenter;     // 回転の中心（メッシュの UV）
uniform float uMeshAspect;   // メッシュの画素の幅 / 高さ
uniform float uVignette;     // 周辺減光 0〜1
uniform vec2 uResolution;
${SHADING}
void main() {
  vec2 q = vUv - uRotCenter;
  q.x *= uMeshAspect;
  float cr = cos(uRot), sr = sin(uRot);
  q = vec2(cr * q.x + sr * q.y, -sr * q.x + cr * q.y);
  q.x /= uMeshAspect;
  vec2 uv = uView.xy + (uRotCenter + q) * uView.zw;
  vec3 c = paintShade(uv, uLight, vec3(0.0, 0.0, 1.0));
  vec2 s = gl_FragCoord.xy / uResolution - 0.5;
  c *= 1.0 - uVignette * smoothstep(0.2, 0.75, length(s) * 1.2);
  gl_FragColor = vec4(c * uFade, 1.0);
  #include <colorspace_fragment>
}`;
const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
// 「バーッ」「シューッ」用：急に加速して急に止まる
const easeInOutExpo = (t: number) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class StoryMode {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: THREE.Mesh | null = null;
  private mat: THREE.ShaderMaterial | null = null;
  private roomMesh: THREE.Mesh | null = null;
  private roomMat: THREE.MeshBasicMaterial | null = null;
  private roomTex: THREE.Texture | null = null;
  private dots: Particles | null = null;   // look.dots の作品のドットの粒（F-6）
  private posNow = { x: 0, y: 0 };
  private img: HTMLImageElement | null = null;     // 静止画モード
  private text: ScreenText;
  private stage = 'T0';
  private paused = false;
  private pausedAt = 0;          // 一時停止を始めた時刻（paused の間だけ意味がある）
  private pausedTotal = 0;       // これまでの一時停止の合計（ms）。T3 の最短に数えない
  private floorSkip = false;     // 最後の文のあとの「次へ」：余韻の 10 秒を待たずに T4 へ
  private introSkip = false;     // T0〜T2 の「次へ」：入りを早回しして語りへ
  private lastMsg = false;       // いま最後の文か、もう文が終わっている
  private nextVoiceAt = -1;      // 声があるとき、「次へ」で飛ぶ先（次の文の開始秒）
  private running = true;
  private scaleContain = { x: 1, y: 1 };
  private scaleNow = { x: 1, y: 1 };
  private fade = 0;
  private strength = 0;
  private rot = 0;              // 視界の回転（ラジアン）
  private vignette = 0;         // 周辺減光
  private look = lookOf();
  private t0 = performance.now();
  private bufSize = new THREE.Vector2();
  private fpsSamples: number[] = [];
  private resolveEnd: ((v: StoryEnd) => void) | null = null;
  private restoreBase: number;
  // T5 の終わりの画面：素の部屋 + 絵の層（ドラッグで動かせる。docs/EXPERIENCE.md 3 節 T5）。位置は保存しない
  private roomLayer: { root: HTMLDivElement; frame: HTMLDivElement; ra: RoomArt; pop: DragPop | null; k: number } | null = null;
  // 終わりの画面の下の白い帯（P-11）：比較の一文 → ボタン列。部屋の画像（椅子など）の上に文字が直に乗らないように
  private band: HTMLDivElement | null = null;
  private roomGen = 0;   // 「もう一度」で増やす（読み込み中の層を捨てる）
  // 押している指・マウス（docs/EXPERIENCE.md 8.2）。渦は frame で毎フレーム育てる
  // moved：押し始めた点からの最大の距離（px）。累計にすると指のわずかな震えで「止めている」判定が外れる
  private touch: { x: number; y: number; x0: number; y0: number; uv: [number, number] | null; p: number; startTime: number; moved: number } | null = null;

  constructor(private ctx: StoryCtx) {
    this.text = new ScreenText(ctx.hud.textLayer, ctx.space.text_color);
    this.text.lang = ctx.lang;   // 日本語のときだけ文節に分ける（文ごとに show の前でも入れ直す）
    this.restoreBase = ctx.space.fluid.restore;
    this.look = lookOf(ctx.space.fluid.look);
  }

  private layout() {
    const vw = innerWidth, vh = innerHeight, a = this.ctx.space.aspect;
    // 60% 幅、80% 高さに収める
    let w = vw * 0.6, h = w / a;
    if (h > vh * 0.8) { h = vh * 0.8; w = h * a; }
    this.scaleContain = { x: w / vw, y: h / vh };
    this.ctx.renderer?.setSize(vw, vh, false);
  }

  private coverScale(mult = 1.15): { x: number; y: number } {
    const vw = innerWidth, vh = innerHeight;
    const k = Math.max(vw / (this.scaleContain.x * vw), vh / (this.scaleContain.y * vh)) * mult;
    return { x: this.scaleContain.x * k, y: this.scaleContain.y * k };
  }

  private setup() {
    const { fluid, renderer, space, canvas } = this.ctx;
    this.layout();
    if (fluid && renderer) {
      this.mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: DISPLAY_FRAG, depthTest: false,
        uniforms: {
          ...shadingUniforms(fluid, this.look),
          uView: { value: new THREE.Vector4(fluid.placement.x, fluid.placement.y, fluid.placement.w, fluid.placement.h) }, uFade: { value: 0 },
          uLight: { value: LIGHT_DIR.clone() }, uRot: { value: 0 }, uRotCenter: { value: new THREE.Vector2(0.5, 0.5) }, uMeshAspect: { value: 1 },
          uVignette: { value: 0 }, uResolution: { value: new THREE.Vector2(1, 1) },
        },
      });
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
      this.scene.add(this.mesh);
      // look.dots の作品だけ、厚みの山に粒を置いて流れに乗せる（VR の粒の層の平面版。1 ドローコール）
      if (this.look.dots > 0 && this.ctx.relief) {
        this.dots = Particles.flat(this.ctx.relief, space.palette, this.look.dots, hashSeed(space.id));
        if (this.dots) this.scene.add(this.dots.mesh);
      }
      renderer.setClearColor(0xffffff, 1);   // 紙白（白の中に絵が浮く。11-06 作家）
    } else {
      canvas.remove();
      const img = document.createElement('img');
      img.src = this.ctx.base + 'generated/' + space.painting; img.alt = '';
      img.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:60vw;max-height:80vh;object-fit:contain;transition:transform 1.2s cubic-bezier(.2,.7,.3,1),filter 3s,opacity 2s;opacity:0;';
      this.img = img;
      document.getElementById('stage')!.insertBefore(img, this.ctx.hud.root);
      // 静止画：ゆっくり揺らぐ
      if (!this.ctx.reduced) img.animate([{ filter: 'saturate(1) blur(0px)' }, { filter: 'saturate(1.15) blur(1px)' }, { filter: 'saturate(1) blur(0px)' }], { duration: 9000, iterations: Infinity });
    }
    window.addEventListener('resize', this.onResize);
    // P-11：比較の一文とボタン列を、下の白い帯にまとめる（hud.ts が作った要素を帯の中へ移すだけ）
    const band = document.createElement('div'); band.className = 'end-band';
    band.append(this.ctx.hud.caption, this.ctx.hud.ending);
    this.ctx.hud.root.appendChild(band); this.band = band;
    band.inert = true;   // 見えない間（T0〜T4）は Tab で届かないように（AUDIT-1 P1-1）
    // P-15：帯の主は「部屋で見る」（部屋の画像が無い作品は「もう一度」のまま）。スマホで主を上段にするのは CSS の order
    const roomsBtn = this.ctx.hud.ending.querySelector<HTMLElement>('[data-action="rooms"]');
    if (roomsBtn) {
      this.ctx.hud.ending.querySelectorAll<HTMLElement>('.btn').forEach((b) => b.classList.toggle('primary', b === roomsBtn));
    }
    this.ctx.hud.close.addEventListener('click', () => this.end('exit'));
    this.ctx.hud.skip.addEventListener('click', this.onSkip);
    this.ctx.hud.ending.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-action]'); if (!b) return;
      const a = b.dataset.action;
      if (a === 'again') this.end('again');
      else if (a === 'close') this.end('exit');
      else if (a === 'save') void this.save();
      else if (a === 'rooms') this.end('rooms');   // 体験を閉じたあと、呼び出し側が部屋の欄へ連れていく（作品ページ：スクロール、受付：#rooms へ移動）
      else if (a === 'contact') { if (this.ctx.space.contact) window.open(this.ctx.space.contact, '_blank', 'noopener'); }
    });
    // 触れる：なぞるとそこに流れができ、タップすると波紋のように広がる（T2〜T4）。一時停止はボタン
    // 強さ p：マウスや非対応端末は 0.5 で来るので ×2 で 1.0 に。長く押すほど筆が沈み、止めたまま押すと渦が育つ（8.2）
    const stageEl = document.getElementById('stage')!;
    const pressureOf = (e: PointerEvent) => Math.min(1, (e.pressure || 0.5) * 2);
    stageEl.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      const now = performance.now();
      this.touch = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, uv: this.screenToUv(e.clientX, e.clientY), p: pressureOf(e), startTime: now, moved: 0 };
      try { stageEl.setPointerCapture(e.pointerId); } catch {}
    });
    stageEl.addEventListener('pointermove', (e) => {
      const t = this.touch;
      if (!t) return;
      const now = performance.now();
      const dx = e.clientX - t.x, dy = e.clientY - t.y;
      t.moved = Math.max(t.moved, Math.hypot(e.clientX - t.x0, e.clientY - t.y0));
      t.p = pressureOf(e);
      t.x = e.clientX; t.y = e.clientY; t.uv = this.screenToUv(e.clientX, e.clientY);
      if (!this.touchable()) return;
      if (t.uv && (dx || dy)) {
        // 指の速さに比例した力（texel/秒）。方向は指の動き。y は画面とテクスチャで上下が逆
        const k = 9;
        const m = touchStroke(t.p, (now - t.startTime) / 1000);
        this.ctx.fluid?.splat(t.uv, [dx * k * m.force, -dy * k * m.force], 0.0035 * m.radius);
      }
    });
    const up = (e: PointerEvent) => {
      const t = this.touch;
      if (!t) return;
      const hold = (performance.now() - t.startTime) / 1000;
      // タップ：短く、ほとんど動かない。押していた時間で波紋が強くなる（長押しは渦になっているので波紋は出さない）
      if (hold < TOUCH_TAP_MAX && t.moved < 8 && this.touchable()) { const uv = this.screenToUv(e.clientX, e.clientY); if (uv) this.ctx.fluid?.burst(uv, tapStrength(hold)); }
      this.touch = null;
    };
    stageEl.addEventListener('pointerup', up); stageEl.addEventListener('pointercancel', () => { this.touch = null; });
    this.ctx.hud.pause.addEventListener('click', () => { if (this.stage === 'T3') this.setPaused(!this.paused); });
    window.addEventListener('keydown', this.onKey);
  }

  private onResize = () => { this.layout(); this.layoutRoomMesh(); this.layoutRoomLayer(); };

  // 「保存・共有」：共有シートがあればそれ。無ければコピーして、コピーしたことを見せる（できなければ URL を見せる）
  private async save() {
    const url = location.origin + location.pathname;
    try {
      if (navigator.share) { await navigator.share({ title: document.title, url }); return; }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;   // 共有シートを閉じただけ
    }
    try {
      await navigator.clipboard.writeText(url);
      this.say(t('copied', this.ctx.lang));
    } catch {
      this.say(`${t('copy_fail', this.ctx.lang)}\n${url}`, 8000);
    }
  }
  // 帯の上に短く知らせる
  private say(msg: string, ms = 2600) {
    const hud = this.ctx.hud.root;
    hud.querySelector('.hud-note')?.remove();
    const el = document.createElement('div');
    el.className = 'hud-note'; el.setAttribute('role', 'status'); el.textContent = msg;
    el.style.bottom = `${(this.band?.offsetHeight ?? 0) + 8}px`;
    hud.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // 触れる場面か（溶け始めてから、絵に戻るまで）
  private touchable() { return !!this.ctx.fluid && (this.stage === 'T2' || this.stage === 'T3' || this.stage === 'T4') && !this.paused; }

  // 画面の座標 → 流体の色場の UV（絵の矩形の外なら null）
  private screenToUv(x: number, y: number): [number, number] | null {
    const fluid = this.ctx.fluid; if (!fluid) return null;
    const nx = (x / innerWidth) * 2 - 1, ny = 1 - (y / innerHeight) * 2;
    const lx = (nx - this.posNow.x) / this.scaleNow.x, ly = (ny - this.posNow.y) / this.scaleNow.y;
    if (lx < -1 || lx > 1 || ly < -1 || ly > 1) return null;
    return fluid.rectToUv((lx + 1) / 2, (ly + 1) / 2);
  }
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') this.end('exit'); else if (e.key === ' ' && this.stage === 'T3') { e.preventDefault(); this.setPaused(!this.paused); } else if (e.key === 'ArrowRight') this.onSkip(); };
  // 「次へ」：文を飛ばす。文が全部終わって最短の流れを待っている間なら T4 へ（REVIEW-1 P1-5）
  // 「次へ」：一時停止中なら解いてから進める（REVIEW-2 P2。止まったまま T4 へ進むと「一時停止」の表示と文の停止が残る）
  private onSkip = () => {
    if (this.paused) this.setPaused(false);
    // T0〜T2：入りを早回しして語りへ（押してすぐ動く。docs/EXPERIENCE.md 3 節）
    if (this.stage === 'T0' || this.stage === 'T1' || this.stage === 'T2') { this.introSkip = true; return; }
    this.text.skip();
    if (this.nextVoiceAt >= 0) this.ctx.sound.seekVoice(this.nextVoiceAt);
    // 最後の文の途中か、文が終わったあとなら、余韻の 10 秒も待たない
    if (this.lastMsg) this.floorSkip = true;
  };
  // 一時停止を除いた経過（ms）
  private activeSince(t: number) { const now = performance.now(); return now - t - this.pausedTotal - (this.paused ? now - this.pausedAt : 0); }

  private setPaused(p: boolean) {
    if (p === this.paused) return;
    if (p) this.pausedAt = performance.now(); else this.pausedTotal += performance.now() - this.pausedAt;
    this.paused = p; this.text.setPaused(p); this.ctx.hud.paused.style.opacity = p ? '1' : '0';
    this.ctx.hud.pause.textContent = p ? '▶' : '❚❚';
    if (p) this.ctx.sound.pauseVoice(); else this.ctx.sound.resumeVoice();
  }

  private end(v: StoryEnd) { this.resolveEnd?.(v); }

  private last = performance.now();
  private frame = () => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const now = performance.now(); const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.fpsSamples.push(1 / Math.max(1e-3, dt)); if (this.fpsSamples.length > 90) this.fpsSamples.shift();
    const { fluid, renderer } = this.ctx;
    if (fluid && renderer && this.mesh && this.mat) {
      // 止めたまま押し続けると、その点に渦が育つ（4px 未満、0.4 秒を超えてから）。動かせばなぞりに戻る
      const t = this.touch;
      if (t && t.moved < 4 && this.touchable()) {
        const v = touchVortex(t.p, (now - t.startTime) / 1000);
        t.uv = this.screenToUv(t.x, t.y);   // 拡大・移動の途中でも指の下の点に
        if (v && t.uv) fluid.vortex(t.uv, v.strength, v.radius);
      }
      if (!this.paused) { fluid.setStrength(this.strength); fluid.step(dt); }
      this.mesh.scale.set(this.scaleNow.x, this.scaleNow.y, 1);
      this.mesh.position.set(this.posNow.x, this.posNow.y, 0);
      const U = this.mat.uniforms;
      const time = (now - this.t0) / 1000;
      U.uFade.value = this.fade;
      updateShading(U, fluid, this.look, time, Math.min(1, this.strength));
      // 光は 60 秒で ±10° ゆっくり揺れる（画面の奥行きの軸のまわり）
      const a = this.ctx.reduced ? 0 : (10 * Math.PI / 180) * Math.sin((time / 60) * Math.PI * 2);
      (U.uLight.value as THREE.Vector3).copy(LIGHT_DIR).applyAxisAngle(Z_AXIS, a);
      // 視界の回転：画面の中心（メッシュの UV）のまわり
      U.uRot.value = this.rot;
      (U.uRotCenter.value as THREE.Vector2).set((-this.posNow.x / this.scaleNow.x + 1) / 2, (-this.posNow.y / this.scaleNow.y + 1) / 2);
      U.uMeshAspect.value = (this.scaleNow.x * innerWidth) / Math.max(1, this.scaleNow.y * innerHeight);
      U.uVignette.value = this.vignette;
      if (this.dots) {
        // T2〜T4 だけ、流れの強さに合わせて出る（静止した絵と部屋の場面には出さない）
        const gate = this.stage === 'T2' || this.stage === 'T3' || this.stage === 'T4' ? clamp01(this.strength) : 0;
        const k = this.ctx.space.fluid.speed * Math.min(1, this.strength) * 0.22;   // Fluid の色の移流と同じ換算
        this.dots.updateFlat(0.9 * this.fade * gate, this.posNow, this.scaleNow, innerWidth / Math.max(1, innerHeight), fluid, [k / this.ctx.space.aspect, k]);
      }
      renderer.getDrawingBufferSize(this.bufSize); (U.uResolution.value as THREE.Vector2).copy(this.bufSize);
      renderer.setRenderTarget(null);
      renderer.render(this.scene, this.camera);
      if (this.ctx.debug) {
        const fps = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
        this.ctx.hud.debug.textContent = `${this.stage}  ${fps.toFixed(0)} fps  q=${fluid.getQuality()}  ${fluid.size.join('x')}  strength=${this.strength.toFixed(2)}${fluid.arcSeconds >= 0 ? `  arc=${fluid.arcSeconds.toFixed(0)}s` : ''}`;
      }
    }
  };

  private async tween(sec: number, f: (t: number) => void, ease: (t: number) => number = easeInOut): Promise<void> {
    let t = 0, last = performance.now();
    return new Promise((res) => {
      const tick = () => {
        if (!this.running) return res();
        const now = performance.now();
        // 「次へ」が押されたら、入りの場面は同じ動きのまま 6 倍で進める（絵が飛ばない）
        t = Math.min(1, t + ((now - last) / (sec * 1000)) * (this.introSkip ? INTRO_SKIP_SPEED : 1)); last = now;
        f(ease(t));
        if (t < 1) requestAnimationFrame(tick); else res();
      };
      tick();
    });
  }
  // T0 の待ち。「次へ」ですぐ抜ける
  private async introWait(ms: number) {
    const t0 = performance.now();
    while (this.running && !this.introSkip && performance.now() - t0 < ms) await wait(50);
  }

  // 終わりの演出に使う部屋（合成の座標があるもののうち最初）
  private room() { return this.ctx.space.rooms?.find((r) => r.quad_px && r.image_px); }

  // 部屋のイメージ（終わりの演出用）。T3 の間に読んでおく
  private loadRoom(): Promise<void> {
    const room = this.room();
    if (!room || !this.ctx.renderer) return Promise.resolve();
    return new Promise((res) => {
      new THREE.TextureLoader().load(this.ctx.base + 'generated/' + room.image, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        this.roomTex = tex;
        this.roomMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false });
        this.roomMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.roomMat);
        this.roomMesh.renderOrder = -1;
        this.scene.add(this.roomMesh);
        res();
      }, undefined, () => res());
    });
  }

  // 部屋のイメージを画面に収めたときの、画像座標 → 画面の矩形（NDC のスケールと位置）
  private roomLayout() {
    const room = this.room()!;
    const vw = innerWidth, vh = innerHeight;
    const b = this.roomFrame();
    const s = b.k, ox = b.x, oy = b.y;
    const xs = room.quad_px!.map((p) => p[0]), ys = room.quad_px!.map((p) => p[1]);
    const x0 = Math.min(...xs) * s + ox, x1 = Math.max(...xs) * s + ox, y0 = Math.min(...ys) * s + oy, y1 = Math.max(...ys) * s + oy;
    const roomScale = { x: b.w / vw, y: b.h / vh };
    const roomPos = { x: ((b.x + b.w / 2) / vw) * 2 - 1, y: 1 - ((b.y + b.h / 2) / vh) * 2 };
    const paintScale = { x: (x1 - x0) / vw, y: (y1 - y0) / vh };
    const paintPos = { x: ((x0 + x1) / 2 / vw) * 2 - 1, y: 1 - ((y0 + y1) / 2 / vh) * 2 };
    return { roomScale, roomPos, paintScale, paintPos };
  }
  // 部屋の置き場所。keep_px（比較の相手。「このドア」のドアなど）があれば、絵と一緒に必ず画面に入れる（roomArt.ts の roomBox）
  private roomFrame() {
    const room = this.room()!;
    return roomBox(room.image_px![0], room.image_px![1], innerWidth, innerHeight, room.quad_px!, room.keep_px, this.band?.offsetHeight ?? 0);
  }
  private layoutRoomMesh() {
    if (!this.roomMesh || !this.room()?.image_px || this.stage !== 'T5') return;
    const L = this.roomLayout();
    this.roomMesh.scale.set(L.roomScale.x, L.roomScale.y, 1);
    this.roomMesh.position.set(L.roomPos.x, L.roomPos.y, 0);
  }

  // T5：部屋の画像を素の部屋（room.base）にし、絵を別の層として quad_px の位置に置く。lightbox と同じ roomArt.ts
  // base が無い・occlusion の部屋・画像が読めないときは、従来どおり合成画像（WebGL の部屋）のまま
  private async mountRoomLayer() {
    const room = this.room();
    const assetBase = this.ctx.base.replace(/works\/[^/]+\/$/, '');   // ctx.base は <assetBase>works/<id>/
    const base = room?.base ? assetBase + room.base : null;
    const painting = this.ctx.base + 'generated/' + this.ctx.space.painting;
    if (!room || !canMove(room, base, painting)) return;
    const gen = this.roomGen;
    const root = document.createElement('div'); root.className = 'room-art';
    const frame = document.createElement('div'); frame.className = 'room-art-frame'; root.appendChild(frame);
    const img = document.createElement('img'); img.className = 'room-art-img'; img.alt = ''; img.draggable = false; frame.appendChild(img);
    const ra = mountRoomArt({
      frame, painting, label: t('move_painting', this.ctx.lang), fitK: () => this.roomLayer?.k || 1,
      onMove: () => { this.roomLayer?.pop?.hide(); },
    });
    // 素の部屋と絵の写真を読み終えてから入れ替える（読めなければ合成画像のまま。待つのは 4 秒まで）
    const loaded = (el: HTMLImageElement, src: string) => new Promise<boolean>((res) => {
      el.addEventListener('load', () => res(true), { once: true }); el.addEventListener('error', () => res(false), { once: true });
      el.src = src;
    });
    ra.set(room);
    const ok = await Promise.race([Promise.all([loaded(img, base!), ra.el.complete && ra.el.naturalWidth ? Promise.resolve(true) : loaded(ra.el, painting)]).then((a) => a.every(Boolean)), wait(4000).then(() => false)]);
    if (!ok || gen !== this.roomGen || !this.running || this.stage !== 'T5') { ra.dispose(); return; }
    this.roomLayer = { root, frame, ra, pop: null, k: 1 };
    this.layoutRoomLayer();
    document.getElementById('stage')!.insertBefore(root, this.ctx.hud.root);
    // 「動かせる」の案内は絵のすぐ上の小さなポップ（P-12）。置く場面・ほとんど動かない部屋では出さない。上端の操作ボタン（44px）の下に収める
    if (popWorthy(room)) this.roomLayer.pop = mountDragPop(this.ctx.hud.root, ra.el, t('drag_hint', this.ctx.lang), 72);
  }
  // 部屋の枠を、WebGL の部屋と同じ cover の位置・大きさに
  private layoutRoomLayer() {
    const L = this.roomLayer; const room = this.room();
    if (!L || !room?.image_px) return;
    const b = this.roomFrame();
    L.k = b.k;
    Object.assign(L.frame.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
    L.ra.place();
  }
  private disposeRoomLayer() {
    this.roomGen++;
    const L = this.roomLayer; if (!L) return;
    L.ra.dispose(); L.root.remove(); L.pop?.dispose();
    this.roomLayer = null;
  }

  async start(): Promise<StoryEnd> {
    this.setup();
    this.frame();
    let result: StoryEnd = 'exit';
    try {
      do {
        const ended = new Promise<StoryEnd>((res) => (this.resolveEnd = res));
        const timeline = this.timeline();
        result = await Promise.race([ended, timeline.then(() => ended)]);
        this.text.clear();
        if (result === 'again') { this.disposeRoomLayer(); this.ctx.fluid?.reset(); this.ctx.fluid?.setRestore(this.restoreBase); this.posNow = { x: 0, y: 0 }; this.rot = 0; this.vignette = 0; this.fade = 0; if (this.roomMat) this.roomMat.opacity = 0; this.ctx.hud.ending.style.opacity = '0'; this.ctx.hud.ending.style.pointerEvents = 'none'; this.ctx.hud.once.style.opacity = '0'; this.ctx.hud.caption.style.opacity = '0'; this.ctx.hud.caption.textContent = ''; this.band?.classList.remove('on'); if (this.band) this.band.inert = true; }
      } while (result === 'again' && this.running);
    } finally {
      this.running = false;
      window.removeEventListener('resize', this.onResize); window.removeEventListener('keydown', this.onKey);
      this.disposeRoomLayer(); this.text.dispose(); this.img?.remove(); this.roomTex?.dispose(); this.roomMat?.dispose(); this.dots?.dispose();
    }
    return result;
  }

  // 入り：0〜0.6 秒 縁から泡（拡大 1.0 → 1.1）、0.6〜2.4 秒 渦が立ち上がり、その中心へ拡大（→ cover × 1.3）・回転（→ 6°）・周辺減光（→ 0.5）、
  // 2.4〜3.0 秒 回転を戻し、周辺減光 0.15、渦はほどける。数値は docs/EXPERIENCE.md の T1〜T2（設計変更 11-04）
  private async enter() {
    const { sound, space, reduced, fluid } = this.ctx;
    const k = reduced ? 0.5 : 1;                 // reduced は時間を半分に
    const T1 = 0.6 * k, T2 = 2.4 * k, TOTAL = 3.0 * k;
    const maxRot = reduced ? 0 : (6 * Math.PI) / 180;
    const vortexGain = reduced ? 0.5 : 1;
    const bc = space.bright_center ?? [0.5, 0.5];
    const center = fluid ? fluid.rectToUv(bc[0], bc[1]) : ([0.5, 0.5] as [number, number]);
    const lc = { x: bc[0] * 2 - 1, y: bc[1] * 2 - 1 };   // 渦の中心（メッシュのローカル、-1〜1）
    const s0 = { ...this.scaleContain }, s1 = { x: s0.x * 1.1, y: s0.y * 1.1 }, s2 = this.coverScale(1.3);
    // 拡大しながら、渦の中心を画面の中心へ寄せる（絵が画面を覆う範囲で）
    const posFor = (sc: { x: number; y: number }, p: number) => {
      const fit = (l: number, s: number) => { const want = -l * s * p; const lim = Math.max(0, s - 1); return Math.max(-lim, Math.min(lim, want)); };
      return { x: fit(lc.x, sc.x), y: fit(lc.y, sc.y) };
    };
    this.stage = 'T1';
    sound.setAmbientDb(-16, 1);
    sound.fizz(!reduced, -18); sound.drone(-14, 2);
    if (this.img) this.img.style.transform = 'translate(-50%,-50%) scale(1.9)';
    let rotAtT2 = 0, vigAtT2 = 0, droneUp = false;
    await this.tween(TOTAL, (u) => {
      const t = u * TOTAL;
      if (t < T1) {
        const p = t / T1;
        this.scaleNow = { x: lerp(s0.x, s1.x, p), y: lerp(s0.y, s1.y, p) };
        this.posNow = { x: 0, y: 0 };
        if (!reduced) fluid?.fizz(0.2 * p, 1);
        this.strength = lerp(0.05, 0.2, p);
      } else if (t < T2) {
        this.stage = 'T2';
        if (!droneUp) { sound.drone(-10, 1.2); sound.fizz(!reduced, -14); droneUp = true; }   // 泡 + ドローンを高める
        const p = (t - T1) / (T2 - T1);
        const z = easeInOutCubic(Math.pow(p, 1.4));       // 急加速
        const sc = { x: lerp(s1.x, s2.x, z), y: lerp(s1.y, s2.y, z) };
        this.scaleNow = sc;
        this.posNow = posFor(sc, z);
        this.rot = maxRot * easeInOut(p);
        this.vignette = 0.5 * easeInOut(p);
        if (!reduced) fluid?.fizz(lerp(0.2, 1.0, p), 1);
        this.strength = lerp(0.2, 1.0, p);
        // 渦：強さは山形、半径は 0.05 → 0.35
        fluid?.vortex(center, Math.sin(Math.PI * p) * vortexGain, lerp(0.05, 0.35, p));
        rotAtT2 = this.rot; vigAtT2 = this.vignette;
      } else {
        this.stage = 'T2';
        const p = easeInOut((t - T2) / (TOTAL - T2));
        this.scaleNow = { ...s2 }; this.posNow = posFor(s2, 1);
        this.rot = rotAtT2 * (1 - p);
        this.vignette = lerp(vigAtT2, 0.15, p);
        this.strength = 1.0;
      }
    }, (x) => clamp01(x));
    this.rot = 0; this.vignette = 0.15; this.strength = 1;
    this.scaleNow = { ...s2 }; this.posNow = posFor(s2, 1);
    sound.fizz(false); sound.drone(-14, 1.5);
  }

  private async timeline() {
    const { sound, space, hud, lang, reduced, fluid } = this.ctx;
    const msgs = space.messages;
    // T0 絵（3 秒）
    this.stage = 'T0';
    this.introSkip = false; this.floorSkip = false; this.lastMsg = false; this.nextVoiceAt = -1;
    hud.skip.hidden = false;
    hud.pause.hidden = true;   // 一時停止は語りの間だけ効くので、語りの間だけ見せる
    this.scaleNow = { ...this.scaleContain }; this.posNow = { x: 0, y: 0 }; this.strength = 0.05; this.rot = 0; this.vignette = 0;
    sound.ambient(space.audio.ambient || 'calm', -24);
    hud.title.textContent = pick(space.title, lang); hud.title.style.opacity = '1';
    if (this.img) { this.img.style.opacity = '1'; }
    await this.tween(1.5, (t) => (this.fade = t));
    await this.introWait(1500);
    hud.title.style.opacity = '0';
    // 自動の品質調整（溶ける前に 1 回だけ）
    if (fluid && this.fpsSamples.length > 30) {
      const fps = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
      if (fps < 40 && fluid.getQuality() === 'high') fluid.setQuality('medium');
      else if (fps < 30 && fluid.getQuality() === 'medium') fluid.setQuality('low');
    }
    // T1〜T2（設計変更 11-04）：近づきながら溶けて、渦に吸い込まれる。1 つの 3 秒の場面（reduced は 1.5 秒、回転なし、渦は半分）
    await this.enter();
    // T3 流れと語り
    this.stage = 'T3';
    this.introSkip = false;
    hud.pause.hidden = false;
    setTimeout(() => sound.drone(-22, 3), 4000);
    const roomReady = this.loadRoom();
    const voiceUrl = space.audio.voice ? this.ctx.base + space.audio.voice : null;
    let voiceEnded: Promise<boolean> = Promise.resolve(false);
    let voiceOk = false;
    if (voiceUrl) {
      voiceEnded = sound.playVoice(voiceUrl);
      // 200ms 待って再生できているかを見る
      await wait(250);
      voiceOk = sound.voiceTime() >= 0 && sound.voiceDuration() > 0;
    }
    // 時間の弧（頂の「渦 → 静かに戻る」）は、語りの長さ + 余韻に合わせて縮める（文が速くなり、固定の 50 秒では山に届かない）
    if (fluid && space.fluid?.arc) {
      const talk = voiceOk ? sound.voiceDuration() : msgs.reduce((a, m) => { const s = screenTextTiming(pick(m, lang)); return a + s.rise + s.hold + s.dissolve + s.gap; }, 0);
      const total = talk + AFTER_TEXT_S;
      fluid.setParams({ arc: { peak_s: total * 0.4, calm_s: total * 0.95 } });
    }
    for (let i = 0; i < msgs.length && this.running; i++) {
      const m = msgs[i];
      this.lastMsg = i === msgs.length - 1;
      if (voiceOk) this.nextVoiceAt = msgs[i + 1]?.at ?? -1;
      if (voiceOk) {
        // 声の文の開始時刻まで待つ（一時停止中は進まない）
        while (this.running && sound.voiceTime() < m.at && sound.voiceTime() >= 0 && !(await raced(voiceEnded, 100))) { /* wait */ }
      }
      // 文の言語（閲覧者の言語の文が無ければ pick と同じく en → ja）。日本語のときだけ文節に分ける
      this.text.lang = m[lang] ? lang : m.en ? 'en' : 'ja';
      await this.text.show(pick(m, lang), { reduced });
    }
    this.lastMsg = true; this.nextVoiceAt = -1;
    while (voiceOk && this.running && !this.floorSkip && !(await raced(voiceEnded, 100))) { /* 声の終わりまで。「次へ」で抜ける */ }
    // 余韻の流れ：流体があるときだけ（静止画モードは止まった絵を待たせない）。「次へ」で T4 へ。最後の文の途中で押した分もここで効く
    this.pausedTotal = 0;
    const tailStart = performance.now();
    while (this.running && fluid && !this.floorSkip && this.activeSince(tailStart) < AFTER_TEXT_S * 1000) await wait(100);
    // T4 余韻：最後の文字が終わると同時に、シューッと引きながら流れが止まり、元の絵へ戻る（一時停止は T3 だけ。残っていれば解く）
    if (this.paused) this.setPaused(false);
    this.stage = 'T4';
    hud.skip.hidden = true;
    hud.pause.hidden = true;
    sound.fadeOutAll(4);
    fluid?.setRestore(0.08);
    const back = { ...this.scaleNow }, target = { ...this.scaleContain }, pos = { ...this.posNow }, vig = this.vignette;
    await this.tween(reduced ? 1.0 : 1.6, (t) => {
      this.strength = 1 - t;
      this.scaleNow = { x: back.x + (target.x - back.x) * t, y: back.y + (target.y - back.y) * t };
      this.posNow = { x: pos.x * (1 - t), y: pos.y * (1 - t) };
      this.vignette = vig * (1 - t);
    }, reduced ? easeInOut : easeInOutExpo);
    if (this.img) { this.img.style.transform = 'translate(-50%,-50%) scale(1)'; }
    await this.tween(2.2, () => { /* 静止した絵を見せる。回帰で元の絵に戻りきる */ });
    // T5 終わり：その絵が、誰かの部屋に掛かる
    this.stage = 'T5';
    let landed = false;
    await roomReady;
    // 比較の一文は先に帯へ入れておく（帯の高さが決まり、部屋の置き場所が着地のあとで動かない）
    const compare = pick(this.room()?.compare, lang);
    hud.caption.textContent = this.roomMesh && fluid && compare ? compare : '';
    if (this.roomMesh && this.roomMat && fluid) {
      const L = this.roomLayout();
      this.roomMesh.scale.set(L.roomScale.x, L.roomScale.y, 1);
      this.roomMesh.position.set(L.roomPos.x, L.roomPos.y, 0);
      const s0 = { ...this.scaleNow }, p0 = { ...this.posNow };
      await this.tween(reduced ? 1.2 : 2.6, (t) => {
        this.roomMat!.opacity = Math.min(1, t * 1.6);
        this.scaleNow = { x: s0.x + (L.paintScale.x - s0.x) * t, y: s0.y + (L.paintScale.y - s0.y) * t };
        this.posNow = { x: p0.x + (L.paintPos.x - p0.x) * t, y: p0.y + (L.paintPos.y - p0.y) * t };
      });
      // 流体の絵を消して、合成済みの部屋だけにする（同じ場所に同じ絵がある）
      await this.tween(1.0, (t) => (this.fade = 1 - t));
      landed = true;
      // 止まった瞬間に、素の部屋 + 絵の層に入れ替える（見た目は同じ。ここから絵をドラッグで動かせる）
      await this.mountRoomLayer();
    }
    fluid?.setRestore(this.restoreBase);
    // 着地の 1 秒後に、比較の一文を 1 行だけ（数字は出さない）。帯の中・ボタン列の上。文は先に入れて場所を取り、帯の高さが後で跳ねないように
    hud.caption.textContent = landed && compare ? compare : '';
    setPhrases(hud.caption, lang);
    this.band?.classList.add('on');
    if (this.band) this.band.inert = false;
    hud.ending.style.opacity = '1'; hud.ending.style.pointerEvents = 'auto';
    window.dispatchEvent(new CustomEvent('mtp:story-end', { detail: { base: this.ctx.base } }));   // 感想カード（docs/ADMIN.md 3 節）
    if (this.ctx.fromQr) hud.once.style.opacity = '1';
    if (landed && compare) {
      await wait(1000);
      if (!this.running || this.stage !== 'T5') return;
      hud.caption.style.opacity = '1';
    }
  }
}

// 作品 id → 粒の大きさの乱数の種
function hashSeed(id: string): number { let h = 2166136261; for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619); return h >>> 0; }

// p が ms 以内に解決すれば true
function raced(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true), wait(ms).then(() => false)]);
}
