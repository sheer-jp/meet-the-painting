// ギャラリー /gallery/（docs/ENTRANCE.md 4 節）：壁の画像、大きさの絞り込み、PC はホイールの縦を横に
export function mountGallery(wall: HTMLElement, url: URL, onPick: (id: string) => void): void {
  // 11-08：壁の画像は最初の絵のあとに読む（遅い回線でも絵が先。それまでは CSS のグラデーションの部屋）
  const firstPaintings = [...wall.querySelectorAll<HTMLImageElement>('img[fetchpriority="high"]')];
  const showWall = () => wall.closest('.gw')?.classList.add('has-wall');
  void Promise.race([Promise.allSettled(firstPaintings.map((im) => im.decode?.())), new Promise((res) => setTimeout(res, 6000))]).then(showWall);
  // P-4：壁が横にあふれるとき（狭い PC）だけ、右端の「→」と「横にスクロール」を出す
  const gw = wall.closest<HTMLElement>('.gw');
  // 11-08：端まで歩いたら（.is-end）しるしを消す
  const fit = () => {
    gw?.classList.toggle('is-scroll', wall.scrollWidth > wall.clientWidth + 1);
    gw?.classList.toggle('is-end', wall.scrollLeft >= wall.scrollWidth - wall.clientWidth - 4);
  };
  fit(); new ResizeObserver(fit).observe(wall);
  wall.addEventListener('scroll', fit, { passive: true });
  // G-1：大きさの絞り込み。.gw に data-size を付け、CSS が該当しない作品を薄く（スマホは隠す）。壁の並び・実寸比は変えない
  const items = [...wall.querySelectorAll<HTMLElement>('.gw-item')];
  const chips = [...document.querySelectorAll<HTMLButtonElement>('.gw-filter .gw-chip')];
  const applySize = (size: string, push: boolean) => {
    if (!gw) return;
    if (!/^[sml]$/.test(size) || chips.find((c) => c.dataset.size === size)?.disabled) size = 'all';
    if (size === 'all') delete gw.dataset.size; else gw.dataset.size = size;
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.size === size)));
    items.forEach((el) => {
      const on = size === 'all' || el.dataset.size === size;
      el.inert = !on;   // 薄い作品はタップもフォーカスもしない
    });
    if (push) {
      if (size === 'all') url.searchParams.delete('size'); else url.searchParams.set('size', size);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  };
  // 11-08：壁が横に長いので、選んだ大きさの絵が 1 点も画面に無ければ、そこまで歩く（1 点でも見えていれば動かない）
  const walkToSelected = (smooth: boolean) => {
    const on = items.filter((el) => !el.inert);
    const box = wall.getBoundingClientRect();
    if (!matchMedia('(min-width: 768px)').matches || !on.length || on.some((el) => { const r = el.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right; })) return;
    const left = wall.scrollLeft + on[0].getBoundingClientRect().left - box.left - box.width * .2;
    wall.scrollTo({ left, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  };
  chips.forEach((c) => c.addEventListener('click', () => { applySize(c.dataset.size || 'all', true); walkToSelected(true); }));
  applySize(url.searchParams.get('size') || 'all', false);
  walkToSelected(false);
  wall.addEventListener('click', (e) => { const id = (e.target as Element).closest<HTMLElement>('.gw-item')?.dataset.id; if (id) onPick(id); });
  // ホイールの縦を横に。11-08：1 刻みで跳ばず、すっと歩く（prefers-reduced-motion では動きを付けない）
  let target = 0, gliding = 0;
  const glide = () => {
    const d = target - wall.scrollLeft;
    if (Math.abs(d) < 2) { wall.scrollLeft = target; gliding = 0; return; }
    wall.scrollLeft += Math.sign(d) * Math.max(1, Math.abs(d) * .16);
    gliding = requestAnimationFrame(glide);
  };
  wall.addEventListener('wheel', (e) => {
    if (!matchMedia('(min-width: 768px)').matches || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = wall.scrollWidth - wall.clientWidth;
    if (max <= 0) return;
    const from = gliding ? target : wall.scrollLeft;
    const next = Math.min(max, Math.max(0, from + e.deltaY * (e.deltaMode === 1 ? 40 : 1)));
    if (next === from) return;
    e.preventDefault();
    target = next;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) wall.scrollLeft = next;
    else if (!gliding) gliding = requestAnimationFrame(glide);
  }, { passive: false });
}
