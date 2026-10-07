// Browser-local record of which notifications this user has already seen.
//
// Notification ids are stable and computed server-side (`expiring-<contractId>`,
// `obligation-<id>`, `milestone-<id>`, `approval-<id>`), so a seen-id list
// survives reloads while a brand-new id — a contract that just started
// expiring, a freshly overdue item — is not in the list yet and therefore stays
// unread. There is no Notification model on the server, so read state lives
// only in this storage key.
//
// The storage key is scoped per user, so two people who share a browser never
// cross-contaminate each other's read state. Every write is best-effort: a
// blocked or unavailable store degrades to "everything unread", which is
// exactly the behaviour of a fresh session.

const STORAGE_PREFIX = 'ricoz_seen_notifications:';

export const seenStorageKey = (userId) => (userId ? `${STORAGE_PREFIX}${userId}` : null);

export const readSeenIds = (userId) => {
  const key = seenStorageKey(userId);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
  } catch (error) {
    return [];
  }
};

export const writeSeenIds = (userId, ids) => {
  const key = seenStorageKey(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch (error) {
    // Storage can be unavailable (private mode, quota). Seen state is a
    // convenience, so a failed write is never worth surfacing.
  }
};

// Shrinks the seen list down to the ids that still exist in the feed, so it
// cannot grow without bound as sources drop in and out. Returns the ids kept.
export const pruneSeenIds = (userId, liveIds) => {
  const live = new Set(liveIds);
  const kept = readSeenIds(userId).filter((id) => live.has(id));
  writeSeenIds(userId, kept);
  return kept;
};