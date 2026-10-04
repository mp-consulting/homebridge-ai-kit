/**
 * Diffs between two config.json objects: a list of changed JSON paths (what a
 * model reasons about best) and a unified line diff of the pretty-printed files
 * (what a person reviews). Callers redact both sides first.
 */

export interface ConfigChange {
  /** JSON path such as `platforms[2].name` (`$` for the root). */
  path: string;
  op: 'add' | 'remove' | 'change';
  before?: unknown;
  after?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') {
    return `${parent}[${key}]`;
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `${parent}[${JSON.stringify(key)}]`;
  }
  return parent === '$' ? key : `${parent}.${key}`;
}

/** Path-level changes from `before` to `after`. Arrays are compared index by index. */
export function diffJson(before: unknown, after: unknown, path = '$'): ConfigChange[] {
  if (isObject(before) && isObject(after)) {
    const changes: ConfigChange[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const p = childPath(path, key);
      if (!(key in after)) {
        changes.push({ path: p, op: 'remove', before: before[key] });
      } else if (!(key in before)) {
        changes.push({ path: p, op: 'add', after: after[key] });
      } else {
        changes.push(...diffJson(before[key], after[key], p));
      }
    }
    return changes;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: ConfigChange[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const p = childPath(path, i);
      if (i >= after.length) {
        changes.push({ path: p, op: 'remove', before: before[i] });
      } else if (i >= before.length) {
        changes.push({ path: p, op: 'add', after: after[i] });
      } else {
        changes.push(...diffJson(before[i], after[i], p));
      }
    }
    return changes;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, op: 'change', before, after }];
}

/** Above this many lines in the changed middle, the diff shows it as one replaced block instead of running an LCS. */
const MAX_LCS_LINES = 3000;

type Op = [' ' | '-' | '+', string];

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = a.slice(0, start).map((l) => [' ', l]);

  if (midA.length + midB.length > MAX_LCS_LINES) {
    ops.push(...midA.map((l): Op => ['-', l]), ...midB.map((l): Op => ['+', l]));
  } else {
    // lengths[i][j] = LCS length of midA[i..] and midB[j..]
    const lengths = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lengths[i][j] = midA[i] === midB[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        ops.push([' ', midA[i++]]);
        j++;
      } else if (j < midB.length && (i >= midA.length || lengths[i][j + 1] >= lengths[i + 1][j])) {
        ops.push(['+', midB[j++]]);
      } else {
        ops.push(['-', midA[i++]]);
      }
    }
  }
  ops.push(...a.slice(endA).map((l): Op => [' ', l]));
  return ops;
}

/** A unified diff (`---`/`+++`, `@@` hunks with `context` lines) of two JSON values, pretty-printed. Empty when equal. */
export function unifiedJsonDiff(before: unknown, after: unknown, { context = 3, from = 'config.json (current)', to = 'config.json (proposed)' } = {}): string {
  const a = JSON.stringify(before, null, 2).split('\n');
  const b = JSON.stringify(after, null, 2).split('\n');
  const ops = lineOps(a, b);
  const changed = ops.map((op, index) => (op[0] === ' ' ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) {
    return '';
  }

  // Group changed lines whose context windows touch into hunks.
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const lo = Math.max(0, index - context);
    const hi = Math.min(ops.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = hi;
    } else {
      hunks.push([lo, hi]);
    }
  }

  // Line numbers in a and b where each op starts.
  const posA: number[] = [];
  const posB: number[] = [];
  let la = 1;
  let lb = 1;
  for (const [kind] of ops) {
    posA.push(la);
    posB.push(lb);
    if (kind !== '+') {
      la++;
    }
    if (kind !== '-') {
      lb++;
    }
  }

  const out = [`--- ${from}`, `+++ ${to}`];
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const countA = slice.filter(([k]) => k !== '+').length;
    const countB = slice.filter(([k]) => k !== '-').length;
    out.push(`@@ -${countA ? posA[lo] : posA[lo] - 1},${countA} +${countB ? posB[lo] : posB[lo] - 1},${countB} @@`);
    out.push(...slice.map(([k, line]) => `${k}${line}`));
  }
  return out.join('\n');
}
