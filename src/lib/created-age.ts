const DAY_MS = 24 * 60 * 60 * 1000;

/** Completed 24-hour days since creation, regardless of later edits. */
export function daysSinceCreation(
  createdAt: string,
  now: number
): number | null {
  const createdTime = Date.parse(createdAt);
  if (!Number.isFinite(createdTime) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - createdTime) / DAY_MS));
}
