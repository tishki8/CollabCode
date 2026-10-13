// The smallest single replacement that turns `before` into `after`: the common prefix and suffix stay
// untouched, so a restore overwrites only what really differs (and only that is credited to the restorer).
export interface Replacement {
  from: number;
  deleteCount: number;
  insert: string;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export function minimalReplacement(before: string, after: string): Replacement | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // never split a surrogate pair (an emoji) between "common" and "changed"
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  if (endB < before.length && isLowSurrogate(before.charCodeAt(endB))) {
    endB++;
    endA++;
  }
  return { from: start, deleteCount: endB - start, insert: after.slice(start, endA) };
}
