// 受付（/）の最初の読み込みで出す「扉の入場」（docs/ENTRANCE.md 3.7）。CSS とスクリプトは HTML にインラインで持つ（page.ts はモジュールで遅いので、受付が先に一瞬見えてしまう）
// 守ること：
// - 扉は既定で出ない。先頭のスクリプトが html.door-on を付けたときだけ出る（JS が無い・失敗 → そのまま受付）
// - スクリプトが途中で止まっても、CSS の door-bail だけで見えなくなり、操作を邪魔しない（to だけでは visibility が効かなかったので from,to。画面の外にも出す）
// - 受付の DOM には触らない。上に被せて、終わったら取り除くだけ
// - 枠の画像の穴（DOOR_OPENING_*）と壁の画像の床の線（WALL_FLOOR_Y）は 素材の切り出し（作業記録 evidence/door/source/assets.py）で測った値

const DIR = '/concierge/door';
export const DOOR_ASSETS = ['wall.webp', 'frame.webp', 'leaf.webp', 'plate.webp', 'lever.webp'].map((f) => `concierge/door/${f}`);   // CSS の url と同じ画像（ページは / なので同じ URL）

const WALL_COLOR = '#fff4e4';   // 壁の画像の地の色。画像が来るまでの幕
const WALL_ASPECT = 1.5;        // wall.webp の 横/縦
const WALL_FLOOR_Y = 0.803;     // wall.webp の中の床の線（上からの割合）
const DOOR_RATIO = 0.46;        // 開口の 横/縦
const FRAME_SIDE = 0.114;       // 枠の左右の太さ（開口の幅に対する割合）
const FRAME_TOP = 0.0732;       // 枠の上の太さ（開口の高さに対する割合）

// 時間（秒）。docs/ENTRANCE.md 3.7 と同じ。合計 2.1 秒
const T = { leverAt: 0.4, joltAt: 0.56, openAt: 0.75, open: 0.9, passAt: 1.6, pass: 0.5 };
const BAIL_AT = 3.8;   // 画像待ち 0.8 秒 + 2.1 秒 より後

export const doorStyle = () => `<style>
.door{display:none}
html.door-on{background:${WALL_COLOR}}
html.door-on .door{display:block;position:fixed;inset:0;z-index:2147483000;overflow:hidden;background:${WALL_COLOR};cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  --vh:100vh;--sh:max(var(--vh),calc(100vw/${WALL_ASPECT}));--fb:calc(var(--sh)*${(1 - WALL_FLOOR_Y).toFixed(3)});
  --at:clamp(22px,calc(var(--vh)*.075),66px);--ah:calc(var(--vh) - var(--fb) - var(--at));--aw:min(calc(var(--ah)*${DOOR_RATIO}),calc(100vw - 48px));
  --cx:50vw;--ax:calc(var(--cx) - var(--aw)/2);--fs:calc(var(--aw)*${FRAME_SIDE});--ft:calc(var(--ah)*${FRAME_TOP});
  animation:door-bail .01s linear ${BAIL_AT}s forwards}
@supports (height:100dvh){html.door-on .door{--vh:100dvh}}
@media (orientation:landscape) and (max-height:500px){html.door-on .door{--cx:18vw}}
.door-rig{position:absolute;inset:0;opacity:0;perspective:calc(var(--vh)*1.7);perspective-origin:var(--cx) calc(var(--at) + var(--ah)/2);transform-origin:var(--cx) calc(var(--at) + var(--ah)*.32)}
.door-leaf{position:absolute;z-index:1;left:var(--ax);top:var(--at);width:var(--aw);height:var(--ah);background:url(${DIR}/leaf.webp) center/100% 100% no-repeat;transform-origin:100% 50%}
.door-leaf::after{content:"";position:absolute;inset:0;background:#2a1a0c;opacity:0}
.door-plate{position:absolute;left:8%;top:52%;width:10%;aspect-ratio:186/528;transform:translateY(-50%);background:url(${DIR}/plate.webp) center/100% 100% no-repeat}
.door-lever{position:absolute;left:-3%;top:12%;width:330%;aspect-ratio:672/209;background:url(${DIR}/lever.webp) center/100% 100% no-repeat;transform-origin:16% 50%}
.door-wall{position:absolute;z-index:2;inset:0;background:${WALL_COLOR} url(${DIR}/wall.webp) center bottom/auto var(--sh) no-repeat;
  clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,var(--ax) var(--at),calc(var(--ax) + var(--aw)) var(--at),calc(var(--ax) + var(--aw)) calc(var(--at) + var(--ah)),var(--ax) calc(var(--at) + var(--ah)),var(--ax) var(--at))}
.door-frame{position:absolute;z-index:3;left:calc(var(--ax) - var(--fs));top:calc(var(--at) - var(--ft));width:calc(var(--aw) + var(--fs)*2);height:calc(var(--ah) + var(--ft));background:url(${DIR}/frame.webp) center/100% 100% no-repeat;filter:drop-shadow(0 2px 5px rgba(90,55,20,.28))}
html.door-on .door.door-run{animation:door-veil .01s linear ${T.openAt}s forwards,door-bail .01s linear ${BAIL_AT}s forwards}
.door-run .door-rig{animation:door-show .12s ease-out both,door-pass ${T.pass}s cubic-bezier(.5,0,.85,.45) ${T.passAt}s forwards}
.door-run .door-lever{animation:door-lever .16s cubic-bezier(.3,0,.3,1) ${T.leverAt}s forwards,door-lever-back .25s ease ${T.openAt + 0.05}s forwards}
.door-run .door-leaf{animation:door-jolt .1s ease-out ${T.joltAt}s forwards,door-open ${T.open}s cubic-bezier(.45,.03,.25,1) ${T.openAt}s forwards}
.door-run .door-leaf::after{animation:door-shade ${T.open}s ease-in ${T.openAt}s forwards}
.door-out{opacity:0!important;pointer-events:none;transition:opacity .14s ease-out}
@keyframes door-show{from{opacity:0}to{opacity:1}}
@keyframes door-lever{0%{transform:rotate(0)}70%{transform:rotate(30deg)}100%{transform:rotate(26deg)}}
@keyframes door-lever-back{from{transform:rotate(26deg)}to{transform:rotate(0)}}
@keyframes door-jolt{to{transform:rotateY(-2.4deg)}}
@keyframes door-open{from{transform:rotateY(-2.4deg)}to{transform:rotateY(-84deg)}}
@keyframes door-shade{to{opacity:.3}}
@keyframes door-veil{to{background-color:transparent}}
@keyframes door-pass{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(3.4)}}
@keyframes door-bail{from,to{visibility:hidden;opacity:0;transform:translateX(-200vw)}}
@media (prefers-reduced-motion:reduce){html.door-on .door{display:none}}
</style>`;

// <body> の先頭に置く。この <script> は同期なので、受付の <main> はこの判定のあとにしか読まれない（受付が先に見えることがない）
// 同じタブで 1 回（見せなかったときも印を付ける）。sessionStorage が使えないときは毎回出さないよう、出さない
// 計測用のクエリ（utm_ など）以外のクエリ・hash がある深いリンク、裏のタブ、reduced-motion では出さない
export const doorBody = () => `<div class="door" id="door" aria-hidden="true"><div class="door-rig"><div class="door-leaf"><div class="door-plate"><div class="door-lever"></div></div></div><div class="door-wall"></div><div class="door-frame"></div></div></div>
<script>(function(){
var r=document.documentElement,d=document.getElementById('door'),k='etp-door-seen';
try{var seen=sessionStorage.getItem(k);sessionStorage.setItem(k,'1');
if(seen||matchMedia('(prefers-reduced-motion: reduce)').matches||document.visibilityState==='hidden'||location.hash||location.search.replace(/[?&](utm_\\w+|fbclid|gclid)=[^&]*/g,'')){d.remove();return}}catch(e){d.remove();return}
r.classList.add('door-on');
var over=0,gate,bye;
function clean(){clearTimeout(gate);clearTimeout(bye);document.removeEventListener('keydown',skip);d.remove();r.classList.remove('door-on')}
function skip(){if(over)return;over=1;d.classList.add('door-out');bye=setTimeout(clean,160)}
d.addEventListener('click',skip);
document.addEventListener('keydown',skip);
d.addEventListener('animationend',function(e){if(e.animationName==='door-pass'&&!over){over=1;clean()}});
gate=setTimeout(skip,800);
Promise.all(${JSON.stringify(DOOR_ASSETS)}.map(function(u){var i=new Image();i.src=u;return i.decode?i.decode():new Promise(function(a,b){i.onload=a;i.onerror=b})})).then(function(){
if(over)return;clearTimeout(gate);d.classList.add('door-run');bye=setTimeout(skip,3000)
},skip);
})()</script>`;
