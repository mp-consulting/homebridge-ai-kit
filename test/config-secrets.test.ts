import { describe, it, expect } from 'vitest';
import { REDACTED, SecretRestoreError, containsRedacted, redactSecrets, restoreSecrets } from '../src/config-secrets.js';

describe('redactSecrets', () => {
  it('redacts secret-looking keys at any depth', () => {
    const config = {
      bridge: { name: 'HB', pin: '031-45-154' },
      platforms: [
        {
          platform: 'X',
          password: 'p',
          mqttPass: 'm',
          passphrase: 'pp',
          clientSecret: 's',
          accessToken: 't',
          api_key: 'k',
          apiKey: 'k2',
          privateKey: 'pk',
          credentials: { user: 'u', pass: 'x' },
        },
      ],
    };
    const redacted = redactSecrets(config) as typeof config;
    const p = redacted.platforms[0];

    expect(redacted.bridge).toEqual({ name: 'HB', pin: REDACTED });
    expect(p.platform).toBe('X');
    for (const key of ['password', 'mqttPass', 'passphrase', 'clientSecret', 'accessToken', 'api_key', 'apiKey', 'privateKey'] as const) {
      expect(p[key]).toBe(REDACTED);
    }
    // Everything under a secret key is redacted, including nested values.
    expect(p.credentials).toEqual({ user: REDACTED, pass: REDACTED });
  });

  it('redacts each entry of an array under a secret key', () => {
    expect(redactSecrets({ tokens: ['a', 'b'] })).toEqual({ tokens: [REDACTED, REDACTED] });
  });

  it('leaves booleans, null and empty strings alone', () => {
    expect(redactSecrets({ password: '', token: null, apiKey: false })).toEqual({ password: '', token: null, apiKey: false });
  });

  it('does not mutate its input', () => {
    const config = { bridge: { pin: '1' } };
    redactSecrets(config);
    expect(config.bridge.pin).toBe('1');
  });
});

describe('containsRedacted', () => {
  it('detects a placeholder anywhere', () => {
    expect(containsRedacted({ a: [{ b: REDACTED }] })).toBe(true);
    expect(containsRedacted({ a: 'not redacted' })).toBe(false);
  });
});

describe('restoreSecrets', () => {
  const current = {
    bridge: { pin: '031-45-154' },
    platforms: [
      { platform: 'Hue', name: 'Hue', apiKey: 'hue' },
      { platform: 'Ring', name: 'Ring', token: 'ring' },
    ],
  };

  it('is the inverse of redactSecrets', () => {
    expect(restoreSecrets(redactSecrets(current), current)).toEqual(current);
  });

  it('matches array entries by identity, not position', () => {
    const next = redactSecrets({ ...current, platforms: [...current.platforms].reverse() });
    expect(restoreSecrets(next, current)).toEqual({ ...current, platforms: [...current.platforms].reverse() });
  });

  it('keeps values the caller changed', () => {
    const next = { bridge: { pin: '111-11-111' }, platforms: [] };
    expect(restoreSecrets(next, current)).toEqual(next);
  });

  it('falls back to position for entries without identity fields', () => {
    expect(restoreSecrets({ tokens: [REDACTED, 'new'] }, { tokens: ['old', 'x'] })).toEqual({ tokens: ['old', 'new'] });
  });

  it('refuses when two current entries share an identity', () => {
    const dupes = { platforms: [{ platform: 'A', key: 1, token: 'one' }, { platform: 'A', key: 2, token: 'two' }] };
    expect(() => restoreSecrets({ platforms: [{ platform: 'A', token: REDACTED }] }, dupes)).toThrow(SecretRestoreError);
  });

  it('lists every placeholder it cannot restore', () => {
    const next = { bridge: { pin: REDACTED, extraSecret: REDACTED }, platforms: [{ platform: 'Nest', token: REDACTED }] };
    try {
      restoreSecrets(next, current);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SecretRestoreError);
      expect((error as SecretRestoreError).paths).toEqual(['bridge.extraSecret', 'platforms[0].token']);
    }
  });
});
