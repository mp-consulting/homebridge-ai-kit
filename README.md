# @mp-consulting/homebridge-mcp-server

MCP (Model Context Protocol) server for [Homebridge](https://homebridge.io) — control your smart home accessories, manage plugins, edit configuration, and monitor your Homebridge server from AI assistants like Claude.

## Features

- **Accessories** — List, inspect, and control all your Homebridge accessories (lights, switches, thermostats, sensors, etc.)
- **Server Management** — Check status, restart Homebridge, view pairing info, manage cached accessories
- **Configuration** — Read and update your `config.json`
- **Plugins** — List installed plugins, search npm, view config schemas and changelogs
- **System Info** — CPU, memory, OS, and network details of the host machine
- **Logs** — Read recent Homebridge log output and search it for errors or specific devices

## Prerequisites

- [Homebridge](https://homebridge.io) with [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x) installed (provides the REST API)
- Node.js 18+

## Installation

```bash
npm install -g @mp-consulting/homebridge-mcp-server
```

## Configuration

The server requires three environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `HOMEBRIDGE_URL` | URL of your Homebridge UI | `http://192.168.1.100:8581` |
| `HOMEBRIDGE_USERNAME` | Homebridge UI login username | `admin` |
| `HOMEBRIDGE_PASSWORD` | Homebridge UI login password | `admin` |

## Usage

### Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "homebridge": {
      "command": "homebridge-mcp-server",
      "env": {
        "HOMEBRIDGE_URL": "http://192.168.1.100:8581",
        "HOMEBRIDGE_USERNAME": "admin",
        "HOMEBRIDGE_PASSWORD": "your-password"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add homebridge -- homebridge-mcp-server
```

Then set the environment variables in your shell or `.env` file.

### MCP Inspector (for testing)

```bash
HOMEBRIDGE_URL=http://192.168.1.100:8581 \
HOMEBRIDGE_USERNAME=admin \
HOMEBRIDGE_PASSWORD=your-password \
npx @modelcontextprotocol/inspector homebridge-mcp-server
```

## Available Tools

### Accessories

| Tool | Description |
|------|-------------|
| `list_accessories` | List all accessories with current state. Supports filtering by `room`, `type`, `name`, `manufacturer`, and `excludeManufacturer` |
| `get_accessory` | Get detailed info for a specific accessory |
| `set_accessory` | Control an accessory (on/off, brightness, temperature, etc.) |
| `get_accessory_layout` | Get the room layout from the Homebridge UI |

### Server

| Tool | Description |
|------|-------------|
| `get_homebridge_status` | Check if Homebridge is running |
| `get_server_status` | Get server version, uptime, Node.js version, OS details, and instance ID |
| `restart_homebridge` | Restart the Homebridge service |
| `get_pairing_info` | Get HomeKit pairing code / QR info |
| `get_cached_accessories` | List cached accessories |
| `remove_cached_accessory` | Remove a specific cached accessory |
| `reset_cached_accessories` | Reset all cached accessories |

### Configuration

| Tool | Description |
|------|-------------|
| `get_config` | Read the current config.json |
| `update_config` | Update config.json (full replacement) |

### Plugins

| Tool | Description |
|------|-------------|
| `list_plugins` | List installed plugins |
| `search_plugins` | Search npm for Homebridge plugins |
| `lookup_plugin` | Get details about a specific plugin |
| `get_plugin_versions` | Get available versions for a plugin |
| `get_plugin_config_schema` | Get the configuration schema for a plugin |
| `get_plugin_changelog` | Get the changelog for a plugin |

### System

| Tool | Description |
|------|-------------|
| `get_system_info` | Get host system information (CPU, memory, OS) |

### Logs

| Tool | Description |
|------|-------------|
| `get_recent_logs` | Return the most recent lines from the Homebridge log |
| `search_logs` | Search the log by substring or regex, returning the most recent matches |

> The log tools read the log through the Homebridge UI, so they work against a remote
> instance like every other tool. They require a Homebridge install managed by
> [hb-service](https://github.com/homebridge/homebridge-config-ui-x/wiki/Homebridge-Service-Command),
> which is what makes the log file available over the API.

## Example Prompts

Once configured, you can ask Claude things like:

- "List all my smart home accessories and their current status"
- "Turn off the living room lights"
- "Set the bedroom thermostat to 21 degrees"
- "What plugins are installed on my Homebridge?"
- "Show me the Homebridge config"
- "Is Homebridge running? What version?"
- "Search for a Homebridge plugin for Philips Hue"

## Development

```bash
git clone https://github.com/mp-consulting/homebridge-mcp-server.git
cd homebridge-mcp-server
npm install
npm run build
```

```bash
npm run dev          # Run with auto-reload (tsx)
npm test             # Run tests
npm run test:watch   # Run tests in watch mode
```

## License

MIT
