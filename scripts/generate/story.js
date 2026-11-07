// 小さな物語の公開の判定（DECISIONS 73）。物語は Claude の下書きから始まるので、作家が確認した印が無ければ公開しない
// 印は work.json の "story_approved": true。下書きの印（「（下書き」）が文に残っていたら、印があっても公開しない
export const DRAFT_MARK = '（下書き';

export function publishedStory(work, stories) {
  const ja = stories?.ja;
  if (typeof ja !== 'string' || !ja.trim()) return null;
  if (work?.story_approved !== true || ja.includes(DRAFT_MARK)) return null;
  return { ja, en: stories.en };
}
