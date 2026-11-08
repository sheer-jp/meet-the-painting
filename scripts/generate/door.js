// 受付（/）の最初の読み込みで出す「扉の入場」（docs/ENTRANCE.md 3.7。11-08 v2）。CSS とスクリプトは HTML にインラインで持つ（page.ts はモジュールで遅いので、受付が先に一瞬見えてしまう）
// 守ること：
// - 扉は既定で出ない。先頭のスクリプトが html.door-on を付けたときだけ出る（JS が無い・失敗 → そのまま受付）
// - スクリプトが途中で止まっても、CSS の door-bail だけで見えなくなり、操作を邪魔しない（to だけでは visibility が効かなかったので from,to。画面の外にも出す）
// - 受付の DOM には触らない。上に被せて、終わったら取り除くだけ。扉の奥は専用の「向こうの部屋」の層（受付の壁の画像 + ミニキャラ + 光）で、受付の文字は透かさない
//   （.door は最後のフェードまで不透明。v1 の door-veil は奥の受付の UI が透けたのでやめた）
// - 受付の吹き出しと選択肢は、扉を出したときだけ扉の終わりを待ってから 0.1 秒ずつ下から出す（html.door-on → html.door-done のクラスだけ。DOM は変えない）
// - 動かすのは transform と opacity だけ
// - 開口とミニキャラの行き先は受付の案内役の窓（.cg-host）に合わせる。走り始め（開口の上端と中心）と通り抜けの前（行き先）に窓の位置を測り、CSS 変数に入れる。測れなければ CSS の既定の値
// - 終わりは白に飛ばさない。ミニキャラが窓の中心へ寄りながら小さくなって消えるのと重ねて、扉の層ごとフェードし、受付（案内役）が下から透けて現れる
// - 枠の画像の穴（FRAME_*）と壁の画像の床の線（WALL_FLOOR_Y）は 素材の切り出し（作業記録 evidence/door/source/assets.py）で測った値

const DIR = '/concierge/door';
const ROOM_TALL = 'concierge/wall/wall-tall.webp';   // 奥の部屋の壁。受付の背景と同じ画像（受付のページが preload している）。640px 未満
const ROOM_WIDE = 'concierge/wall/wall-wide.webp';   // 640px 以上（.cg-host::before と同じ境目）
export const DOOR_ASSETS = ['wall.webp', 'frame.webp', 'leaf.webp', 'plate.webp', 'lever.webp', 'chibi.webp'].map((f) => `concierge/door/${f}`);   // CSS の url と同じ画像（ページは / なので同じ URL）。奥の部屋の壁は幅で 1 枚だけ足して待つ

const WALL_COLOR = '#fff4e4';   // 壁の画像の地の色。画像が来るまでの幕
const WALL_ASPECT = 1.5;        // wall.webp の 横/縦
const WALL_FLOOR_Y = 0.803;     // wall.webp の中の床の線（上からの割合）
const DOOR_RATIO = 0.46;        // 開口の 横/縦
const FRAME_SIDE = 0.114;       // 枠の左右の太さ（開口の幅に対する割合）
const FRAME_TOP = 0.0732;       // 枠の上の太さ（開口の高さに対する割合）
// 奥の部屋（受付の壁の画像）。床の線（上からの割合）と 横/縦 は画像から測った値（evidence/door-v2/source）
const ROOM = { tall: { floor: 0.6854, aspect: 0.5625 }, wide: { floor: 0.7713, aspect: 1.7778 } };
const ROOM_WALL = 'rgb(250,242,238)', ROOM_FLOOR = 'rgb(251,203,152)';   // 画像の外に出たところの色（壁と床）
const CHIBI_ASPECT = 0.5083;    // chibi.webp の 1 コマの 横/縦（手を振る 2 コマを横に並べた 1 枚）
const LIGHT = '255,226,170';    // 奥の暖かい光
const LEAK = '255,243,212';     // 隙間から漏れる光（扉の板より明るく）

// 時間（秒）。docs/ENTRANCE.md 3.7 と同じ。合計 2.45 秒（11-08 作家の指摘で止めの時間と白くなる時間をなくした）
const T = {
  show: 0.2,                    // 0〜0.2 ふわっと現れる
  glow: 0.2,                    // 0〜0.2 下の隙間と縁に光がにじむ
  leverAt: 0.2, lever: 0.25,    // 0.2〜0.45 取っ手が大きく回って戻る
  boostAt: 0.3,                 // 取っ手が回り切った瞬間に光が強まる
  swingAt: 0.3, swing: 0.95,    // 0.36 に「カチャッ」で手前に揺れ、0.45〜1.25 奥へ開いて小さく揺れて止まる
  waveAt: 0.75,                 // ミニキャラが手を振り始める（2 コマを 0.25 秒ずつ）
  passAt: 1.2, pass: 0.7,       // 1.2〜1.9 カメラが開口を通り抜ける（扉と壁の層が広がって消える）
  homeAt: 1.2, home: 1.1,       // 1.2〜2.3 ミニキャラが少し近づき、案内役の窓の中心へ寄りながら小さくなる
  fadeAt: 2.0, fade: 0.35,      // 2.0〜2.35 ミニキャラが光の中で消える（受付の案内役と重なる）
  lightAt: 1.65, light: 0.35,   // 窓の位置に暖かい光（白には飛ばさない）
  endAt: 1.85, end: 0.6,        // 1.85〜2.45 扉の層ごとフェードし、受付が下から透けて現れる（クロスフェード）
};
const BAIL_AT = 4.2;            // 画像待ち 0.8 秒 + 2.45 秒 より後
const SAFETY_MS = 3400;         // 走り始めてからこの時間で必ず片付ける（animationend が来ないとき）。tests/smoke.mjs と evidence の frames.mjs がこの値の setTimeout を止めて確かめる

const s = (v) => `${+v.toFixed(3)}s`;
const opener = (n) => `html.door-done .cg-openers>:nth-child(${n})`;
// door-swing のキーフレーム（秒 → 割合）
const sw = (t) => `${+(((t - T.swingAt) / T.swing) * 100).toFixed(1)}%`;

export const doorStyle = () => `<style>
.door{display:none}
html.door-on{background:${WALL_COLOR}}
html.door-on .door{display:block;position:fixed;inset:0;z-index:2147483000;overflow:hidden;background:${WALL_COLOR};cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  --vh:100vh;--sh:max(var(--vh),calc(100vw/${WALL_ASPECT}));--fb:calc(var(--sh)*${(1 - WALL_FLOOR_Y).toFixed(3)});
  --at:clamp(22px,calc(var(--vh)*.075),66px);--ah:calc(var(--vh) - var(--fb) - var(--at));--aw:min(calc(var(--ah)*${DOOR_RATIO}),calc(100vw - 48px));
  --cx:50vw;--ax:calc(var(--cx) - var(--aw)/2);--fs:calc(var(--aw)*${FRAME_SIDE});--ft:calc(var(--ah)*${FRAME_TOP});
  --oy:calc(var(--at) + var(--ah)*.42);--rf:calc(var(--at) + var(--ah)*.8);--rF:${ROOM.tall.floor};--rA:${ROOM.tall.aspect};--rh:calc(var(--ah)*.95/var(--rF));--rw:calc(var(--rh)*var(--rA));
  --hx:var(--cx);--hy:calc(var(--at) + var(--ah)*.2);--mx:calc(var(--hx) - var(--cx));--my:calc(var(--hy) - var(--at) - var(--ah)*.7);
  animation:door-bail .01s linear ${BAIL_AT}s forwards}
@supports (height:100dvh){html.door-on .door{--vh:100dvh}}
@media (min-width:640px){html.door-on .door{--rF:${ROOM.wide.floor};--rA:${ROOM.wide.aspect}}}
@media (orientation:landscape) and (max-height:500px){html.door-on .door{--cx:18vw;--at:8px}}
.door-cam{position:absolute;inset:0;opacity:0}
.door-room{position:absolute;inset:0;opacity:0;background:linear-gradient(${ROOM_WALL} var(--rf),${ROOM_FLOOR} var(--rf));transform-origin:var(--cx) var(--oy)}
.door-room-img{position:absolute;left:calc(var(--cx) - var(--rw)/2);top:calc(var(--rf) - var(--rh)*var(--rF));width:var(--rw);height:var(--rh);background:url(/${ROOM_TALL}) center/100% 100% no-repeat}
@media (min-width:640px){.door-room-img{background-image:url(/${ROOM_WIDE})}}
.door-glow{position:absolute;left:calc(var(--cx) - var(--aw)*1.3);top:calc(var(--at) - var(--ah)*.1);width:calc(var(--aw)*2.6);height:calc(var(--ah)*1.3);background:radial-gradient(closest-side,rgba(${LIGHT},.9),rgba(${LIGHT},.45) 50%,rgba(${LIGHT},0));opacity:.5;transform:scale(.75)}
.door-chibi{position:absolute;left:calc(var(--cx) - var(--ah)*${(0.25 * CHIBI_ASPECT).toFixed(4)});top:calc(var(--at) + var(--ah)*.45);width:calc(var(--ah)*${(0.5 * CHIBI_ASPECT).toFixed(4)});height:calc(var(--ah)*.5);opacity:0}
.door-bob,.door-bob i{position:absolute;inset:0}
.door-bob i{background:url(${DIR}/chibi.webp) 0 0/200% 100% no-repeat}
.door-bob i+i{background-position:100% 0;opacity:0}
.door-rig{position:absolute;inset:0;perspective:calc(var(--vh)*1.7);perspective-origin:var(--cx) calc(var(--at) + var(--ah)/2);transform-origin:var(--cx) var(--oy)}
.door-leak{position:absolute;left:var(--ax);top:var(--at);width:var(--aw);height:var(--ah);background:rgb(${LEAK});opacity:0}
.door-edge{position:absolute;z-index:1;left:var(--ax);top:var(--at);width:var(--aw);height:var(--ah);box-shadow:inset 0 0 calc(var(--aw)*.07) calc(var(--aw)*.014) rgba(${LEAK},.9);background:linear-gradient(0deg,rgba(${LEAK},.95),rgba(${LEAK},0) 8%);opacity:0}
.door-leaf{position:absolute;z-index:1;left:calc(var(--ax) + var(--aw)*.014);top:calc(var(--at) + var(--ah)*.007);width:calc(var(--aw)*.972);height:calc(var(--ah)*.973);background:url(${DIR}/leaf.webp) center/100% 100% no-repeat;transform-origin:100% 50%}
.door-leaf::after{content:"";position:absolute;inset:0;background:#2a1a0c;opacity:0}
.door-plate{position:absolute;left:8%;top:52%;width:10%;aspect-ratio:186/528;transform:translateY(-50%);background:url(${DIR}/plate.webp) center/100% 100% no-repeat}
.door-lever{position:absolute;left:-3%;top:12%;width:330%;aspect-ratio:672/209;background:url(${DIR}/lever.webp) center/100% 100% no-repeat;transform-origin:16% 50%}
.door-wall{position:absolute;z-index:2;inset:0;background:${WALL_COLOR} url(${DIR}/wall.webp) center bottom/auto var(--sh) no-repeat;
  clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,var(--ax) var(--at),calc(var(--ax) + var(--aw)) var(--at),calc(var(--ax) + var(--aw)) calc(var(--at) + var(--ah)),var(--ax) calc(var(--at) + var(--ah)),var(--ax) var(--at))}
.door-spill{position:absolute;z-index:2;left:calc(var(--ax) - var(--aw)*.4);top:calc(var(--at) + var(--ah) - 1px);width:calc(var(--aw)*1.8);height:calc(var(--fb)*.75);background:radial-gradient(50% 100% at 50% 0,rgba(${LEAK},.95),rgba(${LIGHT},.4) 45%,rgba(${LIGHT},0));opacity:0;transform-origin:50% 0}
.door-frame{position:absolute;z-index:3;left:calc(var(--ax) - var(--fs));top:calc(var(--at) - var(--ft));width:calc(var(--aw) + var(--fs)*2);height:calc(var(--ah) + var(--ft));background:url(${DIR}/frame.webp) center/100% 100% no-repeat;filter:drop-shadow(0 2px 5px rgba(90,55,20,.28))}
.door-light{position:absolute;left:calc(var(--hx) - 45vmin);top:calc(var(--hy) - 45vmin);width:90vmin;height:90vmin;background:radial-gradient(closest-side,rgba(${LEAK},.85),rgba(${LIGHT},.35) 55%,rgba(${LIGHT},0));opacity:0;transform:scale(.6)}
html.door-on .door.door-run{animation:door-end ${s(T.end)} cubic-bezier(.45,0,.55,1) ${s(T.endAt)} forwards,door-bail .01s linear ${BAIL_AT}s forwards}
.door-run .door-cam{animation:door-show ${s(T.show)} cubic-bezier(.2,.7,.3,1) both}
.door-run .door-leak,.door-run .door-edge{animation:door-leak-on ${s(T.glow)} ease-out forwards,door-leak-up .1s ease-out ${s(T.boostAt)} forwards,door-leak-off .3s ease-in .5s forwards}
.door-run .door-room{animation:door-on .12s linear .42s forwards,door-room-pass .9s cubic-bezier(.45,0,.4,1) ${s(T.passAt)} forwards}
.door-run .door-chibi{animation:door-on .12s linear .42s forwards,door-home ${s(T.home)} cubic-bezier(.45,0,.3,1) ${s(T.homeAt)} forwards,door-fade ${s(T.fade)} ease-in ${s(T.fadeAt)} forwards}
.door-run .door-spill{animation:door-spill-on ${s(T.glow)} ease-out forwards,door-spill-up .1s ease-out ${s(T.boostAt)} forwards,door-spill-grow .8s cubic-bezier(.3,.1,.3,1) .45s forwards}
.door-run .door-lever{animation:door-lever ${s(T.lever)} linear ${s(T.leverAt)} forwards}
.door-run .door-leaf{animation:door-swing ${s(T.swing)} linear ${s(T.swingAt)} forwards}
.door-run .door-leaf::after{animation:door-shade .8s ease-in .45s forwards}
.door-run .door-glow{animation:door-glow .8s cubic-bezier(.3,.1,.3,1) .45s forwards}
.door-run .door-bob{animation:door-bob .25s ease-in-out ${s(T.waveAt)} infinite}
.door-run .door-bob i{animation:door-blink-a .5s step-end ${s(T.waveAt)} infinite}
.door-run .door-bob i+i{animation-name:door-blink-b}
.door-run .door-rig{animation:door-pass ${s(T.pass)} cubic-bezier(.55,.05,.7,.4) ${s(T.passAt)} forwards}
.door-run .door-light{animation:door-light ${s(T.light)} cubic-bezier(.2,.6,.3,1) ${s(T.lightAt)} forwards}
.door-out{opacity:0!important;pointer-events:none;transition:opacity .14s ease-out}
@keyframes door-show{from{opacity:0;transform:scale(1.03)}to{opacity:1;transform:none}}
@keyframes door-on{to{opacity:1}}
@keyframes door-leak-on{to{opacity:.5}}
@keyframes door-leak-up{from{opacity:.5}to{opacity:1}}
@keyframes door-leak-off{from{opacity:1}to{opacity:0}}
@keyframes door-spill-on{to{opacity:.45}}
@keyframes door-spill-up{from{opacity:.45}to{opacity:1}}
@keyframes door-spill-grow{from{opacity:1;transform:none}to{opacity:1;transform:scale(1.5,1.25)}}
@keyframes door-lever{0%{transform:rotate(0);animation-timing-function:cubic-bezier(.3,0,.3,1)}44%{transform:rotate(52deg);animation-timing-function:ease-in-out}60%{transform:rotate(45deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}100%{transform:rotate(0)}}
@keyframes door-swing{0%{transform:rotateY(0);animation-timing-function:ease-out}${sw(0.36)}{transform:rotateY(1.8deg);animation-timing-function:ease-in}${sw(0.45)}{transform:rotateY(0);animation-timing-function:cubic-bezier(.45,.05,.25,1)}${sw(1.05)}{transform:rotateY(-89deg);animation-timing-function:ease-in-out}${sw(1.15)}{transform:rotateY(-82.5deg);animation-timing-function:ease-in-out}100%{transform:rotateY(-85deg)}}
@keyframes door-shade{to{opacity:.32}}
@keyframes door-glow{to{opacity:1;transform:scale(1.3)}}
@keyframes door-bob{0%,100%{transform:none}45%{transform:translateY(-2.5%)}}
@keyframes door-blink-a{0%{opacity:0}50%{opacity:1}}
@keyframes door-blink-b{0%{opacity:1}50%{opacity:0}}
@keyframes door-home{0%{transform:none}30%{transform:translateY(2%) scale(1.1)}100%{transform:translate(var(--mx),var(--my)) scale(.5)}}
@keyframes door-fade{from{opacity:1}to{opacity:0}}
@keyframes door-room-pass{to{transform:scale(1.2)}}
@keyframes door-pass{0%{transform:none;opacity:1}50%{opacity:1}100%{transform:scale(3.4);opacity:0}}
@keyframes door-light{to{opacity:.6;transform:none}}
@keyframes door-end{to{opacity:0}}
@keyframes door-bail{from,to{visibility:hidden;opacity:0;transform:translateX(-200vw)}}
@media (prefers-reduced-motion:reduce){html.door-on .door{display:none}}
@media (prefers-reduced-motion:no-preference){
html.door-on .cg-greet,html.door-on .cg-foot{animation-delay:calc(${BAIL_AT}s + (var(--d,0s) - .3s)*.25)}
html.door-done .cg-greet,html.door-done .cg-openers>*,html.door-done .cg-foot{animation:door-up .5s cubic-bezier(.2,.7,.25,1) calc((var(--d,0s) - .3s)*.25) backwards}
html.door-done .cg-openers{animation:none}
${[2, 3, 4, 5, 6].map((n) => `${opener(n)}{animation-delay:calc((var(--d,0s) - .3s)*.25 + ${(n - 1) / 10}s)}`).join('\n')}
html.door-done .cg-foot{animation-delay:calc((var(--d,0s) - .3s)*.25 + .45s)}
@keyframes door-up{from{opacity:0;transform:translateY(14px)}}
}
</style>`;

// <body> の先頭に置く。この <script> は同期なので、受付の <main> はこの判定のあとにしか読まれない（受付が先に見えることがない）
// 同じタブで 1 回（見せなかったときも印を付ける）。sessionStorage が使えないときは毎回出さないよう、出さない
// 計測用のクエリ（utm_ など）以外のクエリ・hash がある深いリンク、裏のタブ、reduced-motion では出さない
// 終わったら html.door-done を残す（受付の吹き出しと選択肢が 0.1 秒ずつ出る。CSS は上の @media の中）
// fit(o)：案内役の窓（.cg-host）を測る。o のときは開口の上端と中心も（走り始めにだけ。途中で変えると扉が跳ぶ）。行き先（--hx / --hy）は通り抜けの前にもう一度
export const doorBody = () => `<div class="door" id="door" aria-hidden="true"><div class="door-cam"><div class="door-room"><div class="door-room-img"></div><div class="door-glow"></div></div><div class="door-light"></div><div class="door-chibi"><div class="door-bob"><i></i><i></i></div></div><div class="door-rig"><div class="door-leak"></div><div class="door-leaf"><div class="door-plate"><div class="door-lever"></div></div></div><div class="door-edge"></div><div class="door-wall"></div><div class="door-spill"></div><div class="door-frame"></div></div></div></div>
<script>(function(){
var r=document.documentElement,d=document.getElementById('door'),k='etp-door-seen';
try{var seen=sessionStorage.getItem(k);sessionStorage.setItem(k,'1');
if(seen||matchMedia('(prefers-reduced-motion: reduce)').matches||document.visibilityState==='hidden'||location.hash||location.search.replace(/[?&](utm_\\w+|fbclid|gclid)=[^&]*/g,'')){d.remove();return}}catch(e){d.remove();return}
r.classList.add('door-on');
var over=0,gate,bye,again;
function clean(){clearTimeout(gate);clearTimeout(bye);clearTimeout(again);document.removeEventListener('keydown',skip);d.remove();r.classList.add('door-done');r.classList.remove('door-on')}
function skip(){if(over)return;over=1;d.classList.add('door-out');bye=setTimeout(clean,160)}
function fit(o){var h=document.querySelector('.cg-host'),b=h&&h.getBoundingClientRect();if(!b||b.width<40||b.height<40)return;var x=b.left+b.width/2,p=function(n,v){d.style.setProperty(n,Math.round(v)+'px')};if(o){p('--cx',x);p('--at',b.top)}p('--hx',x);p('--hy',b.top+b.height/2)}
d.addEventListener('click',skip);
document.addEventListener('keydown',skip);
d.addEventListener('animationend',function(e){if(e.target===d&&e.animationName==='door-end'&&!over){over=1;clean()}});
gate=setTimeout(skip,800);
Promise.all(${JSON.stringify(DOOR_ASSETS)}.concat(innerWidth<640?${JSON.stringify(ROOM_TALL)}:${JSON.stringify(ROOM_WIDE)}).map(function(u){var i=new Image();i.src=u;return i.decode?i.decode():new Promise(function(a,b){i.onload=a;i.onerror=b})})).then(function(){
if(over)return;clearTimeout(gate);try{fit(1)}catch(e){}d.classList.add('door-run');bye=setTimeout(skip,${SAFETY_MS});again=setTimeout(function(){try{fit(0)}catch(e){}},${Math.round((T.homeAt - 0.1) * 1000)})
},skip);
})()</script>`;
