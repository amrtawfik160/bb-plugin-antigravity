# bb-plugin-antigravity

Run bb threads on **Google Antigravity** over ACP.

Antigravity's `agy` CLI talks to an ACP stdio adapter. This plugin downloads that adapter, points bb's ACP bridge at it, normalizes models into clean families (Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus 4.6, GPT-OSS 120B), and exposes native reasoning effort (Low / Medium / High).

## Requirements

`agy` has to be installed and logged in. The plugin does not install Google's CLI for you.

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy   # log in if it asks
```

`agy-acp` is downloaded into `~/.local/bin` the first time the plugin loads, or when you run `bb antigravity install`. You can still point `adapterCommand` at a binary you already have.

## Installation

```bash
bb plugin install git:github.com/amrtawfik160/bb-plugin-antigravity --yes
```

That is the whole install. After it loads, `acp-antigravity` shows up in the provider picker. If `agy` is missing, the plugin stays in needs-configuration until you install it and reload.

On bb 0.41 the picker reads the builtin ACP plugin's `customAgents` setting. This plugin writes that setting itself. It also still writes `customAcpAgents` in `config.json` for older bb.

Then:

```bash
bb thread spawn --provider acp-antigravity --prompt "..."
```

## Usage

```bash
bb antigravity status     # provider registration and prerequisites
bb antigravity doctor     # status plus a live ACP handshake
bb antigravity install    # download agy-acp if needed and register the provider
bb antigravity enable     # register (also downloads agy-acp if it is missing)
bb antigravity disable    # remove the provider; auto-setup will not put it back
```

`disable` is sticky across reloads so the plugin does not immediately re-register. `enable` or `install` clears that.

agy-acp runs each turn as `agy -p`, which exits when the model yields — including when it starts a screenshot, test, or other background job and says it will look later. With `autoContinue` on (the default), the shim keeps that ACP turn open and sends Continue on the same session so the thread does not go idle.

There is a settings panel under **Extensions → Plugins → Antigravity**.

### Models and reasoning

Models come from the ACP session and are normalized into:

- **Gemini 3.8 Flash** (Reasoning: Low, Medium, High — default High)
- **Gemini 3.7 Flash** (Reasoning: Low, Medium, High — default High)
- **Gemini 3.6 Flash** (Reasoning: Low, Medium, High — default High)
- **Gemini 3.1 Pro** (Reasoning: Low, High — default High)
- **Claude Sonnet 4.6 (Thinking)**
- **Claude Opus 4.6 (Thinking)**
- **GPT-OSS 120B (Medium)**

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `agentId` | `antigravity` | bb exposes this as provider `acp-<id>` |
| `displayName` | `Antigravity` | Shown in the provider picker |
| `transport` | `connect` | `agy-agent-acp` transport (`connect` warm, `cli` per-turn) |
| `adapterCommand` | *(auto)* | Absolute path to the ACP adapter (`agy-acp` or `agy-agent-acp`) |
| `agyCommand` | *(auto)* | Absolute path to the `agy` CLI |
| `compatibilityShim` | `true` | Normalizes models into clean families and bridges native reasoning effort |
| `autoContinue` | `true` | When Antigravity yields on background work, keep the same ACP turn going instead of going idle |

## Development

```bash
npm install               # install dependencies
bb plugin build .         # build dist/ bundles and metadata
bb plugin reload antigravity
```
