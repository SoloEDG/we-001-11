import type { Session } from "../../../shared/types";
import { assertBattle } from "../../../shared/document";

const ARCHIVE_KEY = "we001-session";

/**
 * Thrown when the browser refuses to persist the archive. Callers must treat
 * this as a failed transaction: the previously stored archive is still valid
 * and must not be removed or overwritten as a fallback.
 */
export class ArchiveWriteError extends Error {
  readonly reason: "quota" | "unavailable";
  constructor(reason: "quota" | "unavailable", cause?: unknown) {
    super(
      reason === "quota" ? "浏览器存储空间不足" : "浏览器拒绝写入本地存储",
    );
    this.name = "ArchiveWriteError";
    this.reason = reason;
    this.cause = cause;
  }
}

function isQuotaError(e: unknown) {
  const name = (e as { name?: string } | null)?.name;
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    (e as { code?: number } | null)?.code === 22
  );
}

/**
 * Persist the complete session (battle state + history) in one write.
 * `localStorage.setItem` is atomic per key, so a thrown quota error leaves the
 * previously saved archive intact. We deliberately do not clear or trim the
 * existing archive on failure: the user's original record must remain
 * exportable and refreshable.
 */
export function saveArchive(s: Session) {
  let payload: string;
  try {
    payload = JSON.stringify(s);
  } catch (e) {
    throw new ArchiveWriteError("unavailable", e);
  }
  try {
    localStorage.setItem(ARCHIVE_KEY, payload);
  } catch (e) {
    throw new ArchiveWriteError(isQuotaError(e) ? "quota" : "unavailable", e);
  }
}

export function loadArchive(): Session | null {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    assertBattle(s.live);
    assertBattle(s.initial);
    if (!Array.isArray(s.events)) return null;
    return s;
  } catch {
    return null;
  }
}

export function downloadArchive(s: Session) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(s, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "灰烬渡口-战斗记录.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
