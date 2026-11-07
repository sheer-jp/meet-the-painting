import type { Lang } from '../i18n';
export type Multi = Partial<Record<Lang, string>>;
export interface Space {
  id: string; title: Multi; size_cm: [number, number]; aspect: number; year: number | null;
  painting: string; painting_full?: string; painting_blur?: string; source_px?: [number, number];
  palette: string[]; text_color: string; back_color: string;
  flow: { texture: string; strength: number; edge_density: number };
  relief?: { texture: string };               // 絵の具の厚みの初期値（docs/FLUID_LOOK.md）
  bright_center?: [number, number];           // 最も明るい主要色の重心（UV、v は下 → 上）。入りの渦の中心
  fluid: { vorticity: number; speed: number; quality: 'high' | 'medium' | 'low'; restore: number; drive?: number; tempo?: number; look?: Partial<Look>; arc?: { peak_s: number; calm_s: number } };
  space: { radius_m: number; melt_distance_m: number };
  audio: { voice: string | null; ambient: 'calm' | 'wind' | 'water' | 'drone' | 'none' };
  messages: ({ at: number } & Multi)[];
  story: Multi | null;
  size_label?: Multi | null;
  rooms: Room[];
  availability: string | null; contact: string | null;
}

// 部屋で見る（space.json の rooms[]）。文章は docs/SIZE_UX.md 3・5 節
export interface Room {
  name: string; image: string; label: Multi; category?: 'studio' | 'house'; wall_width_cm: number;
  image_px?: [number, number]; quad_px?: [number, number][]; keep_px?: [number, number, number, number];
  base?: string;             // 絵の無い素の部屋（サイトのルートからの相対。例 rooms/<name>.jpg）。無ければ拡大表示も合成画像
  occlusion?: boolean;       // 絵の前に手前の物がある（true なら拡大表示は合成画像のままで、絵を動かせない）
  px_per_cm?: number; confidence?: 'high' | 'mid' | 'low' | null; primary_ref?: string | null;
  compare?: Multi | null;    // 比較の一文（数字なし）
  compare2?: Multi | null;   // 2 つ目の比較（基準物の実寸つき）
  about?: Multi | null;      // 部屋の説明（壁の幅、掛ける高さ）
  note?: Multi | null;       // 注記（AI のイメージ、目安）
  // 置く場面（docs/PLACEMENT.md 6 節）。easel：卓上イーゼル、lean：棚に立てかけ。拡大表示では絵を横にだけ動かす
  place?: 'easel' | 'lean';
  move_px?: [number, number, number, number];   // 拡大表示で動かせる範囲（壁。家具の手前には出さない）
  side_color?: string;       // キャンバスの側面の色（絵の下端を 35% 暗く）
  sides_px?: { bottom: number; right: number; shadow: number };   // 側面の帯（下・右）と接地の影の大きさ（画像の px）
}

// 質感のパラメータ（space.json の fluid.look。docs/FLUID_LOOK.md 2 節）
export interface Look {
  relief: number;      // 厚みの陰影の強さ 0〜1
  gloss: number;       // 鏡面の強さ 0〜1（アクリル：小さく）
  sharpness: number;   // 鏡面の指数（大きいほど小さく鋭い）
  bloom: number;       // 明るい所のにじみ 0〜0.5
  grain: number;       // 粒子 0〜0.1
  vivid: number;       // 彩度の補正
}
