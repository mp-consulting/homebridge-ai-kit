import { describe, expect, it } from 'vitest';
import { envList, httpOptionsFromEnv } from '../../src/mcp/stdio.js';

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
