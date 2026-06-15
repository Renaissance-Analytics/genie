#!/usr/bin/env bash
# MCP configuration helpers for tynn-cli
# Handles MCP server configuration for various AI systems

# ─────────────────────────────────────────────────────────────────────────────
# AI System Definitions
# ─────────────────────────────────────────────────────────────────────────────

# Supported AI systems and their config file locations
declare -A AI_SYSTEMS=(
  ["claude-code"]="Claude Code"
  ["claude-desktop"]="Claude Desktop"
  ["cursor"]="Cursor"
  ["windsurf"]="Windsurf"
  ["vscode"]="VS Code (Copilot)"
  ["continue"]="Continue (VS Code)"
  ["zed"]="Zed"
)

# Get config file path for an AI system
# Usage: get_ai_config_path "system" ["project"|"user"]
get_ai_config_path() {
  local system="$1"
  local scope="${2:-project}"
  local path=""

  case "$system" in
    claude-code)
      if [[ "$scope" == "project" ]]; then
        path=".mcp.json"
      else
        path="$HOME/.claude.json"
      fi
      ;;
    claude-desktop)
      if [[ "$OSTYPE" == "darwin"* ]]; then
        path="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
        path="$APPDATA/Claude/claude_desktop_config.json"
      else
        path="$HOME/.config/Claude/claude_desktop_config.json"
      fi
      ;;
    cursor)
      if [[ "$scope" == "project" ]]; then
        path=".cursor/mcp.json"
      else
        path="$HOME/.cursor/mcp.json"
      fi
      ;;
    windsurf)
      if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
        path="$USERPROFILE/.codeium/windsurf/mcp_config.json"
      else
        path="$HOME/.codeium/windsurf/mcp_config.json"
      fi
      ;;
    vscode)
      if [[ "$scope" == "project" ]]; then
        path=".vscode/mcp.json"
      else
        # VS Code uses settings.json for user-level
        path=""
      fi
      ;;
    continue)
      # Continue uses a folder with YAML files
      path=".continue/mcpServers"
      ;;
    zed)
      if [[ "$OSTYPE" == "darwin"* ]]; then
        path="$HOME/.config/zed/settings.json"
      else
        path="$HOME/.config/zed/settings.json"
      fi
      ;;
  esac

  echo "$path"
}

# Get the JSON key path for MCP servers in each system's config
get_mcp_key() {
  local system="$1"

  case "$system" in
    claude-code|claude-desktop|cursor|windsurf)
      echo "mcpServers"
      ;;
    vscode)
      echo "servers"
      ;;
    zed)
      echo "context_servers"
      ;;
    continue)
      echo ""  # Uses separate files
      ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Config File Operations
# ─────────────────────────────────────────────────────────────────────────────

# Check if config file exists
config_exists() {
  local path="$1"
  [[ -f "$path" ]]
}

# Create base config structure for a system
create_base_config() {
  local system="$1"

  case "$system" in
    claude-code|cursor|windsurf)
      echo '{"mcpServers": {}}'
      ;;
    claude-desktop)
      echo '{"mcpServers": {}}'
      ;;
    vscode)
      echo '{"servers": {}}'
      ;;
    zed)
      echo '{"context_servers": {}}'
      ;;
  esac
}

# Read existing MCP servers from config
# Returns JSON object of servers
read_mcp_servers() {
  local path="$1"
  local key="$2"

  if [[ ! -f "$path" ]]; then
    echo "{}"
    return
  fi

  # Use node for JSON parsing (more reliable than jq on Windows)
  node -e "
    const fs = require('fs');
    try {
      const data = JSON.parse(fs.readFileSync('$path', 'utf8'));
      console.log(JSON.stringify(data['$key'] || {}));
    } catch (e) {
      console.log('{}');
    }
  " 2>/dev/null || echo "{}"
}

# Add MCP server to config
# Usage: add_mcp_server "path" "key" "server_name" "server_config_json"
add_mcp_server() {
  local path="$1"
  local key="$2"
  local server_name="$3"
  local server_config="$4"

  local dir
  dir=$(dirname "$path")

  # Create directory if needed
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir"
  fi

  # Create or update config
  node -e "
    const fs = require('fs');
    const path = '$path';
    const key = '$key';
    const serverName = '$server_name';
    const serverConfig = $server_config;

    let config = {};
    try {
      if (fs.existsSync(path)) {
        config = JSON.parse(fs.readFileSync(path, 'utf8'));
      }
    } catch (e) {}

    if (!config[key]) {
      config[key] = {};
    }

    config[key][serverName] = serverConfig;

    fs.writeFileSync(path, JSON.stringify(config, null, 2));
    console.log('ok');
  " 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────────────
# Continue Extension (special handling - uses YAML files)
# ─────────────────────────────────────────────────────────────────────────────

# Add MCP server to Continue extension
add_continue_server() {
  local server_name="$1"
  local server_config="$2"
  local dir=".continue/mcpServers"

  mkdir -p "$dir"

  # Convert JSON config to YAML-ish format
  local yaml_file="$dir/${server_name}.yaml"

  node -e "
    const fs = require('fs');
    const config = $server_config;

    let yaml = 'name: ${server_name}\n';
    yaml += 'version: 0.0.1\n';
    yaml += 'schema: v1\n';
    yaml += 'mcpServers:\n';
    yaml += '  - name: ${server_name}\n';

    if (config.command) {
      yaml += '    command: ' + config.command + '\n';
    }
    if (config.args && config.args.length > 0) {
      yaml += '    args:\n';
      config.args.forEach(arg => {
        yaml += '      - \"' + arg + '\"\n';
      });
    }
    if (config.env) {
      yaml += '    env:\n';
      Object.keys(config.env).forEach(k => {
        yaml += '      ' + k + ': \"' + config.env[k] + '\"\n';
      });
    }

    fs.writeFileSync('$yaml_file', yaml);
    console.log('ok');
  " 2>/dev/null
}

# ─────────────────────────────────────────────────────────────────────────────
# MCP Config Generation
# ─────────────────────────────────────────────────────────────────────────────

# Generate MCP server config from user input
# Returns JSON object
generate_mcp_config() {
  local name="$1"
  local command="$2"
  local args="$3"      # Comma-separated
  local env_vars="$4"  # KEY=value,KEY2=value2 format

  local args_json="[]"
  local env_json="{}"

  # Parse args
  if [[ -n "$args" ]]; then
    args_json=$(node -e "
      const args = '$args'.split(',').map(a => a.trim()).filter(a => a);
      console.log(JSON.stringify(args));
    ")
  fi

  # Parse env vars
  if [[ -n "$env_vars" ]]; then
    env_json=$(node -e "
      const env = {};
      '$env_vars'.split(',').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k && v) env[k.trim()] = v.trim();
      });
      console.log(JSON.stringify(env));
    ")
  fi

  echo "{\"command\": \"$command\", \"args\": $args_json, \"env\": $env_json}"
}

# Parse MCP config from JSON string or file
parse_mcp_config() {
  local input="$1"

  # Check if it's a file path
  if [[ -f "$input" ]]; then
    cat "$input"
  else
    # Assume it's JSON string
    echo "$input"
  fi
}
