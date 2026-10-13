# bb-plugin-antigravity

Run bb threads on **Google Antigravity** over ACP.

Antigravity's `agy` CLI talks to an ACP stdio adapter. This plugin downloads that adapter, points bb's ACP bridge at it, groups the models `agy` offers into clean families (Gemini 4 Argon, Claude Opus 5.5, …), and exposes native reasoning effort (Low / Medium / High / Max, as each model supports).

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

Models come from the ACP session: whatever `agy models` lists is what the picker shows, so new models appear without a plugin update. Variants that differ only by effort suffix (`-max`, `-high`, `-medium`, `-low`) collapse into one model with a **Reasoning Effort** selector. For example, `opus-5.5-max` … `opus-5.5-low` become **Claude Opus 5.5** with Max / High / Medium / Low. Models with a single variant (such as `gemini-3.5-flash-lite`) are listed as-is, with no effort selector.

The shim caches the discovered list in `~/.bb/antigravity-acp-models.json`, so a new session can translate a selection before the adapter answers. Set `AGY_ACP_MODEL_CACHE` to move it.

After changing `compatibilityShim`, run `bb antigravity enable` to re-register the provider with the new launch command.

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
