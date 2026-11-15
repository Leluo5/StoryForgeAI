export function chapterUrl(workId: string, chapterId: string): string {
  return `/works/${encodeURIComponent(workId)}/write/${encodeURIComponent(chapterId)}?tab=manuscript&panel=chapter`;
}
