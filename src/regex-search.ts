import { Worker } from 'node:worker_threads';

/**
 * Runs in a worker so a catastrophically backtracking pattern can be killed.
 * A time check in the main thread can't help there: a single `re.test()` call
 * blocks the event loop until it returns, which can take hours.
 *
 * Loaded from a data: URL, which Node always evaluates as an ES module, so it
 * needs no separate file in dist/ and works the same under tsx and vitest.
 */
const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
const { lines, pattern, flags } = workerData;
const re = new RegExp(pattern, flags);
const matches = [];
for (let i = 0; i < lines.length; i++) {
  if (re.test(lines[i])) matches.push(i);
}
parentPort.postMessage(matches);
`;

const WORKER_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`);

export class RegexTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`regex search exceeded ${timeoutMs}ms`);
    this.name = 'RegexTimeoutError';
  }
}

/**
 * Indices of the lines that match `pattern`, computed off the main thread.
 * `flags` must not contain `g` or `y` (stateful `lastIndex` would skip matches).
 * @throws RegexTimeoutError if matching takes longer than `timeoutMs`.
 */
export function regexSearch(lines: string[], pattern: string, flags: string, timeoutMs: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { lines, pattern, flags } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new RegexTimeoutError(timeoutMs));
    }, timeoutMs);

    const done = () => clearTimeout(timer);
    worker.once('message', (matches: number[]) => {
      done();
      void worker.terminate();
      resolve(matches);
    });
    worker.once('error', (error) => {
      done();
      reject(error);
    });
  });
}
