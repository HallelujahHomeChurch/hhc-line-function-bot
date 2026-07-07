import type { LineSource } from "../types.js";

export function canCreateRequesterScopedSession(source: LineSource): boolean {
  return !requiresRequesterUserId(source) || Boolean(source.userId);
}

export function requesterMatchesForSource(
  source: LineSource,
  expectedRequesterUserId: string | undefined,
  actualRequesterUserId: string | undefined
): boolean {
  if (requiresRequesterUserId(source)) {
    return Boolean(
      expectedRequesterUserId &&
      actualRequesterUserId &&
      expectedRequesterUserId === actualRequesterUserId
    );
  }
  return (
    !expectedRequesterUserId ||
    !actualRequesterUserId ||
    expectedRequesterUserId === actualRequesterUserId
  );
}

function requiresRequesterUserId(source: LineSource): boolean {
  return source.type === "group" || source.type === "room";
}
