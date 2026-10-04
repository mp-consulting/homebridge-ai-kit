import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as mcp from '../src/mcp/index.js';

describe('package entry points', () => {
  it('./mcp exports the TLS pinning helpers', () => {
    expect(typeof mcp.createTrustedFetch).toBe('function');
    expect(mcp.normalizeFingerprint('ab'.repeat(32))).toBe(Array(32).fill('AB').join(':'));
    expect(typeof mcp.pemFingerprints).toBe('function');
  });

  it('. re-exports the ai-core helpers', () => {
    for (const name of [
      'SlidingWindowRateLimiter',
      'TtlCache',
      'ConfirmationBroker',
      'withConfirmTimeout',
      'redactPairing',
      'readLogTail',
      'stripAnsi',
      'tailLines',
      'UsageTracker',
      'JsonFileUsageStore',
      'trackUsage',
      'BudgetExceededError',
      'registerModelPrices',
      'parseRetryAfter',
    ]) {
      expect(root, name).toHaveProperty(name);
    }
  });
});
