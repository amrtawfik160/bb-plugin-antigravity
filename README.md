# bb-plugin-antigravity

Run bb threads on **Google Antigravity** over ACP.

Antigravity's `agy` CLI communicates over an ACP stdio adapter. This plugin manages the `customAcpAgents` entry that points bb's ACP bridge at the adapter, normalizes models into clean model families (Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6, GPT-OSS 120B), provides native reasoning effort selection (Low / Medium / High), and gives you a `bb antigravity` command to check and manage the integration.

## Requirements

| Tool | Purpose | Install |
|---|---|---|
| `agy` | Antigravity CLI, logged in | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| `agy-acp` | ACP adapter | [releases](https://github.com/shubzkothekar/antigravity-acp/releases) → `~/.local/bin/agy-acp`, then `chmod +x` |

Both are found automatically on `PATH` plus standard install directories (`~/.local/bin`, Homebrew, pipx venvs). You can also override either in the plugin settings via `agyCommand` or `adapterCommand`.

## Installation

```bash
bb plugin install git:github.com/amrtawfik160/bb-plugin-antigravity
bb antigravity enable
```

## Usage

```bash
bb antigravity status     # check provider registration and prerequisites
bb antigravity doctor     # status + a live ACP handshake through the adapter
bb antigravity enable     # write the config entry and reload bb
bb antigravity disable    # remove the provider entry
```

After `enable`:

```bash
bb thread spawn --provider acp-antigravity --prompt "..."
```

### Models & Reasoning Efforts

Models are dynamically discovered and normalized from the ACP session:

- **Gemini 3.8 Flash** (Reasoning: *Low*, *Medium*, *High* — Default: *High*)
- **Gemini 3.7 Flash** (Reasoning: *Low*, *Medium*, *High* — Default: *High*)
- **Gemini 3.6 Flash** (Reasoning: *Low*, *Medium*, *High* — Default: *High*)
- **Gemini 3.1 Pro** (Reasoning: *Low*, *High* — Default: *High*)
- **Claude Sonnet 4.6 (Thinking)**
- **Claude Opus 4.6 (Thinking)**
- **GPT-OSS 120B (Medium)**

There is also a settings panel under **Extensions → Plugins → Antigravity** showing provider status with Enable / Disable / Refresh buttons.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `agentId` | `antigravity` | bb exposes this as provider `acp-<id>` |
| `displayName` | `Antigravity` | Shown in the provider picker |
| `transport` | `connect` | `agy-agent-acp` transport (`connect` warm, `cli` per-turn) |
| `adapterCommand` | *(auto)* | Absolute path to the ACP adapter (`agy-acp` or `agy-agent-acp`) |
| `agyCommand` | *(auto)* | Absolute path to the `agy` CLI |
| `compatibilityShim` | `true` | Normalizes models into clean families and bridges native reasoning effort |

## Development

```bash
npm install               # install dependencies
bb plugin build .         # build dist/ bundles and metadata
bb plugin reload antigravity
```
