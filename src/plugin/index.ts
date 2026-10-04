// The shared plugin-UI routes live in @mp-consulting/homebridge-ai-core; re-exported for backward compatibility.
export { PLATFORM_NAME, PLUGIN_NAME, registerAiRoutes, testAiConnection } from '@mp-consulting/homebridge-ai-core/plugin';
export type { AiRoutesOptions, ConnectionTest, PluginRequestBody, PluginUiServer } from '@mp-consulting/homebridge-ai-core/plugin';
export { mcpClientSnippets } from './snippets.js';
export type { McpClientSnippets, SnippetOptions } from './snippets.js';
export { AiKitPlatform } from './platform.js';
export type { PlatformApi, PlatformLogger } from './platform.js';
