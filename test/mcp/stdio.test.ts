import { afterEach, describe, expect, it, vi } from 'vitest';
import { envList, httpOptionsFromEnv, parseClientTokens, runHttpFromEnv, serverOptionsFromEnv } from '../../src/mcp/stdio.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('httpOptionsFromEnv', () => {
  it('reads the token and transport limits', () => {
    expect(
      httpOptionsFromEnv({
        HOMEBRIDGE_AI_MCP_TOKEN: ' tok ',
        HOMEBRIDGE_AI_MCP_ALLOWED_ORIGINS: 'https://a.example, http://b.example:8080',
        HOMEBRIDGE_AI_MCP_MAX_SESSIONS: '4',
        HOMEBRIDGE_AI_MCP_SESSION_IDLE_MINUTES: '5',
      }),
    ).toEqual({ token: 'tok', allowedOrigins: ['https://a.example', 'http://b.example:8080'], maxSessions: 4, sessionIdleMs: 300_000 });
  });

  it('leaves unset values out', () => {
    expect(httpOptionsFromEnv({})).toEqual({ token: '' });
    expect(httpOptionsFromEnv({ HOMEBRIDGE_AI_MCP_MAX_SESSIONS: ' ' })).toEqual({ token: '' });
  });

  it('rejects bad numbers', () => {
    expect(() => httpOptionsFromEnv({ HOMEBRIDGE_AI_MCP_MAX_SESSIONS: '0' })).toThrow('HOMEBRIDGE_AI_MCP_MAX_SESSIONS must be a positive integer');
    expect(() => httpOptionsFromEnv({ HOMEBRIDGE_AI_MCP_SESSION_IDLE_MINUTES: 'soon' })).toThrow('positive integer');
  });

  it('splits lists on commas and whitespace', () => {
    expect(envList(undefined)).toEqual([]);
    expect(envList('a,,b c')).toEqual(['a', 'b', 'c']);
  });
});

describe('serverOptionsFromEnv', () => {
  it('reads read-only mode and the secrets opt-in, never both', () => {
    expect(serverOptionsFromEnv({})).toEqual({ readOnly: false, allowSecrets: false });
    expect(serverOptionsFromEnv({ HOMEBRIDGE_ALLOW_SECRETS: 'true' })).toEqual({ readOnly: false, allowSecrets: true });
    expect(serverOptionsFromEnv({ HOMEBRIDGE_READ_ONLY: '1', HOMEBRIDGE_ALLOW_SECRETS: 'yes' })).toEqual({ readOnly: true, allowSecrets: false });
  });

  it('opens an audit log at HOMEBRIDGE_AI_AUDIT_LOG', () => {
    expect(serverOptionsFromEnv({ HOMEBRIDGE_AI_AUDIT_LOG: ' /tmp/audit.jsonl ' }).audit?.path).toBe('/tmp/audit.jsonl');
    expect(serverOptionsFromEnv({ HOMEBRIDGE_AI_AUDIT_LOG: ' ' }).audit).toBeUndefined();
  });
});

describe('parseClientTokens', () => {
  it('reads scope:token pairs', () => {
    expect(parseClientTokens('read:abc, control:d:e')).toEqual([
      { scope: 'read', token: 'abc', name: 'read-1' },
      { scope: 'control', token: 'd:e', name: 'control-2' },
    ]);
    expect(httpOptionsFromEnv({ HOMEBRIDGE_AI_MCP_TOKENS: 'admin:x' }).clients).toEqual([{ scope: 'admin', token: 'x', name: 'admin-1' }]);
  });

  it('rejects malformed entries', () => {
    for (const bad of ['abc', 'root:abc', 'read:']) {
      expect(() => parseClientTokens(bad)).toThrow('HOMEBRIDGE_AI_MCP_TOKENS entry 1');
    }
  });
});

describe('runHttpFromEnv', () => {
  function trapExit() {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    return errors;
  }

  it('exits with a readable message without a token', async () => {
    const errors = trapExit();
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKEN', '');
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKENS', '');
    await expect(runHttpFromEnv('hb-ai')).rejects.toThrow('exit 1');
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^hb-ai: HOMEBRIDGE_AI_MCP_TOKEN is required/));
  });

  it('exits on a malformed setting', async () => {
    const errors = trapExit();
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKEN', 't');
    vi.stubEnv('HOMEBRIDGE_AI_MCP_MAX_SESSIONS', 'many');
    await expect(runHttpFromEnv('hb-ai')).rejects.toThrow('exit 1');
    expect(errors).toHaveBeenCalledWith('hb-ai: HOMEBRIDGE_AI_MCP_MAX_SESSIONS must be a positive integer, got "many"');
  });

  it('exits when the Homebridge client cannot be configured', async () => {
    const errors = trapExit();
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKEN', '');
    vi.stubEnv('HOMEBRIDGE_AI_MCP_TOKENS', 'read:r');
    vi.stubEnv('HOMEBRIDGE_URL', 'http://127.0.0.1:8581');
    vi.stubEnv('HOMEBRIDGE_TOKEN', '');
    vi.stubEnv('HOMEBRIDGE_USERNAME', '');
    vi.stubEnv('HOMEBRIDGE_PASSWORD', '');
    await expect(runHttpFromEnv('hb-ai')).rejects.toThrow('exit 1');
    expect(errors.mock.calls[0][0]).toMatch(/^hb-ai: /);
  });
});
