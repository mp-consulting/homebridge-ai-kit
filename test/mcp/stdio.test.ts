import { describe, expect, it } from 'vitest';
import { envList, httpOptionsFromEnv, parseClientTokens, serverOptionsFromEnv } from '../../src/mcp/stdio.js';

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
