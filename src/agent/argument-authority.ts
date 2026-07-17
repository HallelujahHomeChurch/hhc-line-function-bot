export function argumentGroundingCounts(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { groundedFieldCount: number; droppedFieldCount: number } {
  const beforeKeys = Object.keys(before).filter((key) => before[key] !== undefined);
  const afterKeys = new Set(Object.keys(after).filter((key) => after[key] !== undefined));
  return {
    groundedFieldCount: afterKeys.size,
    droppedFieldCount: beforeKeys.filter((key) => !afterKeys.has(key)).length
  };
}
