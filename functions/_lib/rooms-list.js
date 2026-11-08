// 部屋の一覧（rooms/*.json の要約）。管理画面の確認カードと set_rooms の検査に使う。Functions からは rooms/ を読めないので写しを持つ
// rooms/*.json を変えたら直す（tests/register.test.ts が rooms/*.json と照らす）
export const ROOMS = [
  {"name":"desk-easel","label":"机の上のイーゼル","suits_cm":[15,45],"category":"studio","place":true,"disabled":false},
  {"name":"entrance-console","label":"玄関の靴箱の上","suits_cm":[15,45],"category":"studio","place":true,"disabled":false},
  {"name":"entrance-house","label":"玄関","suits_cm":[45,70],"category":"house","place":false,"disabled":false},
  {"name":"living-apartment","label":"ソファの向かいの壁","suits_cm":[45,120],"category":"house","place":false,"disabled":false},
  {"name":"living-chair","label":"椅子の横の壁","suits_cm":[45,120],"category":"house","place":false,"disabled":false},
  {"name":"living-sofa","label":"ソファの後ろの壁","suits_cm":[45,120],"category":"house","place":false,"disabled":false},
  {"name":"living-window","label":"窓辺の壁","suits_cm":[45,120],"category":"house","place":false,"disabled":false},
  {"name":"shelf-lean","label":"棚に立てかけて","suits_cm":[15,45],"category":"studio","place":true,"disabled":false},
  {"name":"sideboard-easel","label":"サイドボードのイーゼル","suits_cm":[15,45],"category":"house","place":true,"disabled":false},
  {"name":"sq-bedroom","label":"寝室のヘッドボードの上","suits_cm":[45,90],"category":"house","place":false,"disabled":true},
  {"name":"sq-dining-close","label":"ダイニングの壁（寄り）","suits_cm":[45,90],"category":"house","place":false,"disabled":false},
  {"name":"sq-dining-wide","label":"ダイニングの壁（遠い壁）","suits_cm":[100,200],"category":"house","place":false,"disabled":false},
  {"name":"sq-sideboard","label":"ローボードの上","suits_cm":[45,120],"category":"house","place":false,"disabled":false},
  {"name":"sq-sofa","label":"ソファの上の壁","suits_cm":[45,140],"category":"house","place":false,"disabled":false},
  {"name":"studio-bedside","label":"ベッド脇","suits_cm":[15,80],"category":"studio","place":false,"disabled":true},
  {"name":"studio-desk","label":"机の上","suits_cm":[15,80],"category":"studio","place":false,"disabled":true},
  {"name":"studio-entrance","label":"小さな玄関","suits_cm":[15,80],"category":"studio","place":false,"disabled":true},
  {"name":"studio-kitchen","label":"キッチンカウンター","suits_cm":[15,80],"category":"studio","place":false,"disabled":true},
  {"name":"studio-shelf","label":"低い棚の上","suits_cm":[15,80],"category":"studio","place":false,"disabled":true},
];
