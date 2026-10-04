import { PLATFORM_NAME } from '@mp-consulting/homebridge-ai-core';
import { AiKitPlatform } from './plugin/platform.js';

// ── AI core: redaction, config, providers, features, utilities ──
// Everything from @mp-consulting/homebridge-ai-core, re-exported so existing imports keep working.
export * from '@mp-consulting/homebridge-ai-core';

// ── Agent ──
export { runAgent } from './agent/run-agent.js';
export type { AgentEvent, AgentResult, AgentToolCall, RunAgentOptions } from './agent/run-agent.js';

/** Homebridge plugin entry point. */
export default (api: { registerPlatform(name: string, constructor: unknown): void }): void => {
  api.registerPlatform(PLATFORM_NAME, AiKitPlatform);
};
