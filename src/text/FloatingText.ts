// 文字の浮上。screen：DOM で画面の奥から（物語モード）。space：Canvas のスプライトで空間内（VR）
import * as THREE from 'three';
import { splitPhrases, wrapPhrases } from './phrases';
import { screenTextTiming } from './timing';

export interface FloatOptions { rise?: number; hold?: number; dissolve?: number; reduced?: boolean }

// 空間（VR）の滞在：docs/EXPERIENCE.md S4（1 文字 0.25 秒、最短 4 秒）。物語モードは ./timing.ts
const holdFor = (s: string, min = 4) => Math.max(min, s.length * 0.25);

export class ScreenText {
  readonly el: HTMLDivElement;
  private token = 0;
  private resolveSkip: (() => void) | null = null;
  private paused = false;
  private dark = false;   // 墨文字（淡い絵）のとき true：文字の裏に白を敷く
  // 表示する文の言語（呼び出し側が show の前に入れる）。日本語のときだけ文節に分ける（REVIEW-1 P1-2：韓国語の空白が消えた）
  lang = 'en';
  constructor(parent: HTMLElement, color: string) {
    this.el = document.createElement('div');
    this.el.className = 'float-text';
    // 書体・大きさ・太さは page.css の .float-text（11-07 T-1：600）。ここは位置と動きと色。
    // color は作品の text_color（generate が絵の明るさで決める：濃い絵は白、淡い絵は墨。11-07 作家）。にじみは文字色の反対（白文字に墨、墨文字に白）
    this.el.style.cssText = 'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%) scale(.3);text-align:center;opacity:0;filter:blur(6px);pointer-events:none;word-break:keep-all;overflow-wrap:anywhere;';
    const light = isLight(color);
    this.dark = !light;
    this.el.style.setProperty('--ft-ink', color);
    this.el.style.setProperty('--ft-glow', light ? '0 0 12px rgba(20,18,16,.85), 0 0 3px rgba(20,18,16,.9)' : '0 0 10px rgba(255,255,255,.95), 0 0 2px rgba(255,255,255,.95)');
    parent.appendChild(this.el);
    // 最初の文が代わりの書体で出ないよう、600 を先に読んでおく（失敗しても続ける）
    document.fonts?.load('600 40px "Shippori Mincho"').catch(() => {});
  }
  setPaused(p: boolean) { this.paused = p; this.el.getAnimations().forEach((a) => (p ? a.pause() : a.play())); }
  skip() { this.resolveSkip?.(); }
  // 浮上 → 滞在 → 溶ける。resolve で終わり
  async show(sentence: string, opt: FloatOptions = {}): Promise<void> {
    const my = ++this.token;
    const t = screenTextTiming(sentence);
    const rise = opt.rise ?? t.rise, hold = opt.hold ?? t.hold, dissolve = opt.dissolve ?? t.dissolve;
    // 墨文字（淡い絵）は、蛍光ペンのようにはっきりした白を文字の裏に敷く（11-07 作家「黒文字は裏にはっきりした白がないと読めない」）。白文字は従来どおりにじみだけ
    // 改行は文節の間だけ（11-07 作家「踏み出すと／き のような改行はしない」）：文節ごとに inline-block の span
    this.el.textContent = '';
    const band = this.dark ? 'background:rgba(255,255,255,.9);padding:.06em .4em;-webkit-box-decoration-break:clone;box-decoration-break:clone;border-radius:.12em;' : '';
    const wrap = document.createElement('span');
    if (band) wrap.style.cssText = band;
    for (const ph of splitPhrases(sentence, this.lang)) {
      // 文節の前後の空白は span の外（文字ノード）に出す。inline-block の中の末尾の空白は行末として消えるので（"Golden Path を" が "GoldenPath を" になった）
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(ph)!;
      if (lead) wrap.appendChild(document.createTextNode(lead));
      if (core) {
        const s = document.createElement('span');
        s.textContent = core;
        s.style.display = 'inline-block';
        wrap.appendChild(s);
      }
      if (trail) wrap.appendChild(document.createTextNode(trail));
    }
    this.el.appendChild(wrap);
    const anim = (frames: Keyframe[], ms: number) => new Promise<void>((res) => {
      const a = this.el.animate(frames, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.2,.7,.3,1)' });
      if (this.paused) a.pause();
      a.onfinish = () => res();
    });
    // 「次へ」は 1 回で次の文へ（現れている途中でも留まる時間を飛ばす）
    let skipped = false;
    const skippable = (p: Promise<void>) => new Promise<void>((res) => { this.resolveSkip = () => { skipped = true; res(); }; p.then(res); });
    await skippable(anim([{ opacity: 0, transform: 'translateY(-50%) scale(.3)', filter: 'blur(8px)' }, { opacity: 1, transform: 'translateY(-50%) scale(1)', filter: 'blur(0px)' }], rise * 1000));
    if (my !== this.token) return;
    if (!skipped) await skippable(this.wait(hold * 1000));
    if (my !== this.token) return;
    this.resolveSkip = null;
    await anim([{ opacity: 1, transform: 'translateY(-50%) scale(1)', filter: 'blur(0px)' }, { opacity: 0, transform: 'translateY(-50%) scale(1.15)', filter: 'blur(10px)' }], dissolve * 1000);
    if (my !== this.token) return;
    // 次の文までの間（一時停止中は進まない）
    await this.wait(t.gap * 1000);
  }
  private wait(ms: number) {
    return new Promise<void>((res) => {
      let left = ms, last = performance.now();
      const tick = () => { const now = performance.now(); if (!this.paused) left -= now - last; last = now; if (left <= 0) res(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }
  clear() { this.token++; this.el.getAnimations().forEach((a) => a.cancel()); this.el.style.opacity = '0'; }
  dispose() { this.el.remove(); }
}

// 空間内の文字：Canvas に描いたテクスチャのスプライト。視線の奥 8m → 2m
export class SpaceText {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private mat: THREE.MeshBasicMaterial;
  private token = 0;
  private resolveSkip: (() => void) | null = null;
  private gaze = new THREE.Vector3(0, 0, -1);
  private color: string;
  private font: string;
  // 表示する文の言語（呼び出し側が show の前に入れる。ScreenText.lang と同じ）
  lang: string;
  constructor(color: string, lang: string) {
    this.color = color;
    this.lang = lang;
    this.font = /^(ja|zh|ko)/.test(lang) ? '"Hiragino Sans","Noto Sans JP","Noto Sans CJK JP","Noto Sans SC","Noto Sans KR",sans-serif' : 'system-ui,"Noto Sans",sans-serif';
    this.canvas.width = 2048; this.canvas.height = 512;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    // 2m で高さ 12cm の 1 行（2 行なら 24cm）→ 幅は 4:1
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.3), this.mat);
    this.mesh.renderOrder = 10; this.mesh.visible = false;
  }
  setGazeDirection(dir: THREE.Vector3) { this.gaze.copy(dir).normalize(); }
  skip() { this.resolveSkip?.(); }
  private draw(text: string) {
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.font = `600 110px ${this.font}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    // 2 行まで。日本語は文節の間だけで折り返す（11-07）。判定は文の言語（this.lang。物語モードの ScreenText と同じ。REVIEW-2 P2）
    // 中国語は字の間、他の言語（韓国語も）は語の間。語の後ろの空白は語に付けたまま（つなぐときに詰まらない）、行の端の空白は描く前に落とす
    const lang = this.lang;
    const phrases = lang.startsWith('ja') ? splitPhrases(text, 'ja') : lang.startsWith('zh') ? Array.from(text) : (text.match(/\S+\s*/g) ?? [text]);
    const lines = wrapPhrases(phrases, 1024 * 1.8, (s) => c.measureText(s.trim()).width);
    const ls = lines.slice(0, 2).map((l) => l.trim());
    // 背後のにじみ（柔らかい暗い影）
    c.shadowColor = 'rgba(0,0,0,0.95)'; c.shadowBlur = 40;
    c.fillStyle = this.color;
    ls.forEach((l, i) => { const y = 256 + (i - (ls.length - 1) / 2) * 130; c.fillText(l, 1024, y); c.fillText(l, 1024, y); });
    this.tex.needsUpdate = true;
  }
  // camera は視点。rise 6 秒で 8m → 2m、滞在、3 秒で溶ける
  async show(sentence: string, camera: THREE.Object3D, opt: FloatOptions = {}): Promise<void> {
    const my = ++this.token;
    const rise = opt.reduced ? 1.5 : (opt.rise ?? 6), hold = opt.hold ?? holdFor(sentence), dissolve = opt.reduced ? 1 : (opt.dissolve ?? 3);
    this.draw(sentence);
    this.mesh.visible = true;
    const dir = new THREE.Vector3();
    const headPos = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const place = (dist: number, scale: number, opacity: number) => {
      camera.getWorldPosition(headPos);
      // 視線の変化にゆっくり追従（毎秒 30%）
      dir.lerp(this.gaze, 0.3 * (1 / 60)).normalize();
      tmp.copy(headPos).addScaledVector(dir, dist);
      this.mesh.position.copy(tmp); this.mesh.lookAt(headPos);
      this.mesh.scale.setScalar(scale * dist / 2);   // 2m で 1 倍（見かけの大きさ一定に近く）
      this.mat.opacity = opacity;
    };
    dir.copy(this.gaze);
    const run = (sec: number, f: (t: number) => void) => new Promise<void>((res) => {
      const t0 = performance.now();
      const tick = () => { if (my !== this.token) return res(); const t = Math.min(1, (performance.now() - t0) / (sec * 1000)); f(t); if (t < 1) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const skippable = (p: Promise<void>) => new Promise<void>((res) => { this.resolveSkip = res; p.then(res); });
    await skippable(run(rise, (t) => { const e = ease(t); place(8 - 6 * e, 1, Math.pow(e, 1.5)); }));
    if (my !== this.token) return;
    await skippable(run(hold, () => place(2, 1, 1)));
    if (my !== this.token) return;
    this.resolveSkip = null;
    await run(dissolve, (t) => place(2 - 0.3 * t, 1 + 0.15 * t, 1 - t));
    this.mesh.visible = false;
  }
  clear() { this.token++; this.mesh.visible = false; this.mat.opacity = 0; }
  dispose() { this.tex.dispose(); this.mat.dispose(); this.mesh.geometry.dispose(); }
}

// 色が明るいか（#rrggbb の相対輝度 > 0.5）。白文字なら墨のにじみ、墨文字なら白のにじみ
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => x / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}
