import { describe, it, expect } from 'vitest';
import { REDACTED, SecretRestoreError, containsRedacted, redactSecrets, restoreSecrets } from '../../src/core/redaction.js';

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

describe('isSecretKey / redactText', () => {
  it('treats apiKey and tokens as secrets but not token counts', async () => {
    const { isSecretKey } = await import('../../src/core/redaction.js');
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('token')).toBe(true);
    expect(isSecretKey('homebridgeToken')).toBe(true);
    expect(isSecretKey('maxOutputTokens')).toBe(false);
    expect(isSecretKey('contextTokens')).toBe(false);
  });

  it('redacts the AI Kit block', () => {
    expect(
      redactSecrets({ platform: 'HomebridgeAiKit', apiKey: 'sk-1', maxOutputTokens: 2048, mcp: { http: { token: 't', port: 8582 } } }),
    ).toEqual({ platform: 'HomebridgeAiKit', apiKey: REDACTED, maxOutputTokens: 2048, mcp: { http: { token: REDACTED, port: 8582 } } });
  });

  it('redacts secrets in free text', async () => {
    const { redactText } = await import('../../src/core/redaction.js');
    expect(redactText('login password=hunter2 ok')).toBe(`login password=${REDACTED} ok`);
    expect(redactText('{"apiKey": "abc123", "name": "x"}')).toBe(`{"apiKey": "${REDACTED}", "name": "x"}`);
    expect(redactText("token: 'xyz'")).toBe(`token: '${REDACTED}'`);
    expect(redactText('maxOutputTokens: 2048')).toBe('maxOutputTokens: 2048');
    expect(redactText('Authorization: Bearer abcdefghijkl')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactText('key sk-ant-abcdefghijklmnopqrstu end')).toBe(`key ${REDACTED} end`);
    expect(redactText('hbg_abcdefghij and AIzaSyA1234567890123456789012345678901')).toBe(`${REDACTED} and ${REDACTED}`);
    expect(redactText('jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4')).toBe(`jwt ${REDACTED}`);
    expect(redactText('nothing here')).toBe('nothing here');
  });
});
