# Open·Agent

A single-file AI chat app for **OpenRouter** (100+ cloud models) and your **local Ollama models** — with an **Agent mode** (terminal + file access when run locally) and a **Rules & Skills** system inspired by Claude Code.

**🌐 Live web version (chat only, no install): https://micorlov.github.io/openrouter-agent/**

There are two ways to run it:

| | Live web version (GitHub Pages) | Local server (`openrouter-agent.js`) |
|---|---|---|
| Install | none — just open the link | `node openrouter-agent.js` |
| Cloud models (OpenRouter) | ✅ | ✅ |
| Agent — in-browser tools (calc, notes) | ✅ | ✅ |
| Agent — terminal & file access | ❌ (no server) | ✅ |
| Local Ollama models | ❌ | ✅ |
| Rules & Skills | ✅ (in browser) | ✅ (as files) |

For terminal access and local models, run the local server:

```bash
node openrouter-agent.js
# → open http://localhost:3001
```

## Features

- **💬 Chat mode** — streaming, token-by-token conversation with any model.
- **🤖 Agent mode** — the model can run shell commands, read/write files, and navigate your filesystem via a tool-call loop (up to 12 steps).
- **💻 Local models** — auto-detects your installed [Ollama](https://ollama.com) models and runs them fully offline, no API key needed.
- **☁️ Cloud models** — Anthropic, OpenAI, Google, Meta, Mistral, DeepSeek via OpenRouter, with automatic fallback when a free model is rate-limited.
- **📋 Rules** — persistent instructions that shape every response, stored as editable `.md` files.
- **⚡ Skills** — reusable `/commands` (like `/commit`, `/review`, `/explain`), invoked with a `/` autocomplete menu.
- **🎨 Dark / light theme**, markdown rendering, streaming stop button, copy buttons.

## Requirements

- **Node.js** 18+ (uses only built-in modules — `http`, `fs`, `child_process`).
- An **[OpenRouter API key](https://openrouter.ai/keys)** for cloud models (entered in the app, stored in your browser's `localStorage`).
- Optional: **[Ollama](https://ollama.com)** running locally for offline models.

## Usage

1. `node openrouter-agent.js`
2. Open **http://localhost:3001**
3. Click the 🔑 key icon and paste your OpenRouter key (skip this if you only use local models).
4. Pick a model, choose **Chat** or **Agent** mode, and start.

### Rules & Skills

Click the 📋 button to manage them, or edit the files directly:

```
~/.openrouter-agent/
├── rules/     # instructions injected into every system prompt
└── skills/    # reusable /command templates
```

A skill file looks like:

```markdown
---
description: Stage all changes and write a conventional-commit message
---
Run 'git status' and 'git diff --staged', then create a commit
with a conventional-commit message summarizing the changes.
```

Type `/` in the message box to invoke one.

## ⚠️ Security

**Agent mode executes shell commands on your machine with your user's permissions.** The server binds to `127.0.0.1` only (not exposed to your network), but treat it like a terminal:

- Only run models and prompts you trust.
- The default rules discourage destructive commands, but they are guidance to the model, not a hard sandbox.
- Don't expose port 3001 to untrusted networks.

## How it works

A ~40 KB Node.js server serves a self-contained HTML/CSS/JS single-page app and provides a few local endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /run`, `/fs/read`, `/fs/write`, `/fs/list` | Terminal & file tools for Agent mode |
| `POST /local/chat` | Proxy to Ollama's OpenAI-compatible API (avoids CORS) |
| `GET /local/models` | Lists installed Ollama models |
| `GET /config`, `POST /config/save`, `/config/delete` | Rules & skills storage |

Cloud chat calls go directly from the browser to OpenRouter.

## License

MIT — see [LICENSE](LICENSE).
