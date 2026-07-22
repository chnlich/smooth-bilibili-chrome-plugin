export const RETAIN_PASS = null;

export function computeRetentionAction(currentTime, removeStart, removeEnd, retainSeconds) {
  if (!Number.isFinite(currentTime) || currentTime <= 0 ||
    !Number.isFinite(removeStart) || !Number.isFinite(removeEnd) || removeEnd <= removeStart) {
    return RETAIN_PASS;
  }
  const floor = currentTime - retainSeconds;
  if (removeEnd <= floor) return RETAIN_PASS;
  if (removeStart >= floor) return { action: 'skipped', adjustedEnd: undefined };
  return { action: 'truncated', adjustedEnd: floor };
}
