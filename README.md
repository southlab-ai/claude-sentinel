# Claude Sentinel

A session supervisor for Claude Code's Telegram channel plugin. Keeps your bot alive, recovers from crashes, and adds long-term memory — because the official channel is still maturing.

## The problem

Claude Code's Telegram plugin works, but sessions are fragile. When the Claude process exits — idle timeout, rate limit, crash, or just a hiccup — Telegram goes silent. On a local machine you can reopen it manually. On a VPS, nobody's there to restart it.

Even when it's running, each new session starts blank. Yesterday's conversation? Gone. Your preferences? Forgotten. The bot has amnesia every time it restarts.

## What we found (and fixed)

These are real issues discovered running Claude Code as a 24/7 Telegram bot. Each one caused the bot to go silent or behave incorrectly.

### 1. One-shot sessions waste tokens

**Problem**: The default approach spawns a new `claude -p` process per message. Each invocation sends the entire conversation context to the API without cache benefits. With a 237K token context, 6 tool calls in quick succession burned 1.4M tokens in 23 seconds — triggering rate limits.

**Root cause**: Each `claude -p` is a fresh process. The API prompt cache (which lasts ~5 minutes) is never warm because the process dies after each response.

**Fix**: Keep one Claude process alive using `--input-format stream-json` (reverse-engineered from the Desktop client binary). New messages are written to stdin — same process, warm cache. The gateway polls Telegram and feeds messages to the running session.

### 2. Subagents die silently

**Problem**: When Claude spawns a subagent (via the Agent tool) for complex tasks like research, the subagent can die silently — usually when an internal API call with 700K+ tokens of context times out. The parent session waits forever for a tool result that never comes. All subsequent user messages queue up but are never processed. The bot appears dead.

**Root cause**: Subagents run inside the same Claude process (not as separate PIDs). When an internal API call fails silently (network timeout, rate limit absorbed internally), no error is written to the JSONL log or emitted via stream-json. The parent process has no way to know its subagent died.

**Fix**: The gateway monitors the subagent's JSONL file (in `~/.claude/projects/-home-claude/{session_id}/subagents/`). Every 60 seconds, it checks the file's mtime. If the file hasn't been modified in 10 minutes, the subagent is probably dead. The gateway then injects a synthetic `tool_result` (with `is_error: true`) via stdin, unblocking the parent turn without killing the session. It also detects completed subagents whose results never reached the parent (by checking for `stop_reason: "end_turn"` in the JSONL).

### 3. "Continue from where you left off" causes zombie tasks

**Problem**: When a session is interrupted (SIGINT, crash) and resumed with `--resume`, Claude Code injects "Continue from where you left off." as a system message. Claude interprets this as permission to auto-execute whatever was pending — including tasks the user never approved.

**Real example**: The bot asked "Should I install these trading skills?" but the subagent died before the user could respond. On resume, Claude saw its own unanswered question + "Continue from where you left off" and interpreted "Continue" as "yes" — installing 5 trading skill packages the user never asked for.

**Root cause**: The `eB1` function in Claude Code checks the last entry in the session JSONL. If the last entry is a `user` message with a `tool_result` (which happens after SIGINT), it classifies the resume as `interrupted_turn` and injects the "Continue" message.

**Fix**: The watchdog agent decides how to restart. For `KILL_RESUME_CLEAN`, the gateway appends a fake `assistant` entry (with `stop_reason: "end_turn"`) to the JSONL after SIGINT. This makes `eB1` classify it as `kind: "none"` — no "Continue" message. Claude waits for the user instead of auto-acting.

### 4. Sessions accumulate until they bloat

**Problem**: A persistent session that runs for hours accumulates context (conversation history, tool results, subagent outputs). Eventually it hits the context limit or causes rate limits from the sheer volume of tokens per API call.

**Fix**: Every time a session dies (for any reason), the gateway runs the compact job before starting a new session. The compact job summarizes the conversation, extracts permanent memories, and flushes old messages from SQLite. The new session starts fresh with only: identity + compact summary + last 20 messages (~2K tokens total). Sessions idle for 30 minutes with no activity are killed automatically to free resources.

### 5. No way to interact with Claude Code's built-in commands

**Problem**: Claude Code has useful slash commands (`/compact`, `/cost`, `/context`, `/review`, etc.) but they only work in the interactive CLI. There's no way to trigger them from Telegram.

**Fix**: The `system/init` event in the stream-json protocol includes a `slash_commands` array listing all available commands. The gateway captures this list and intercepts Telegram messages starting with `/`. If the command matches, it's routed directly to the CLI session via stdin instead of being wrapped as a channel message. The command list updates automatically when plugins are installed or removed. Valid commands are also registered in Telegram's bot menu via `setMyCommands`.

## Architecture

```
User (Telegram) --> Gateway (polls Telegram, supervises session)
                        |
                        v
                    Claude Code (persistent session via stream-json stdin)
                        |
                        v
                    MCP Plugin (reply/react/download tools)
                        |
                        v
                    Telegram Bot API (sends responses)
```

### Session lifecycle

```
[Message arrives, no session]
    --> compact previous session
    --> spawn fresh claude -p --input-format stream-json
    --> inject context (identity + compact + 20 msgs)
    --> send message via stdin

[Message arrives, session alive]
    --> write to stdin (same process, warm cache)

[Session idle 30 min, no tool pending]
    --> SIGTERM, compact, ready for fresh start on next message

[Subagent stuck 10 min]
    --> inject synthetic tool_result via stdin
    --> session unblocks, Claude responds to user

[Watchdog triggers (20 min, or /check)]
    --> diagnostic agent investigates
    --> decides: WAIT / KILL_RESUME_CLEAN / KILL_RESUME_CONTINUE / KILL_FRESH
    --> executes decision with appropriate context injection

[Rate limit]
    --> exponential backoff (60s min) + --fallback-model
```

### Watchdog decisions

| Decision | When | What happens |
|---|---|---|
| **WAIT** | Subagent still active (recent file writes) | Do nothing, check again later |
| **KILL_RESUME_CLEAN** | Stuck + unanswered question pending | SIGINT + fake assistant entry (no "Continue") + 5 recent msgs |
| **KILL_RESUME_CONTINUE** | Stuck + user clearly wants task completed | SIGINT + immediate respawn with "Continue" |
| **KILL_FRESH** | Session bloated / >24h / unrelated stuck task | SIGINT + compact + fresh session |

### Memory system

| Layer | What | When updated | Injected on session start |
|---|---|---|---|
| **Identity** (`identity.md`) | Bot persona, operating principles | Manual edit | Always |
| **Compact** (`session-compact.md`) | Conversation summary | On session death + cron 2x/day | Always |
| **Permanent memories** (`memory/*.md`) | User prefs, project context, decisions | Extracted by compact job | Via Claude's MEMORY.md |
| **Message history** (SQLite) | Last 20 raw messages | Every message | Always |

## Prerequisites

- Linux machine (VPS or local, Ubuntu/Debian recommended)
- [Bun](https://bun.sh) runtime
- [Claude Code CLI](https://claude.ai/install.sh) installed and authenticated
- Claude Code [Telegram plugin](https://github.com/anthropics/claude-plugins-official) enabled
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- OpenAI API Key (optional, for voice message transcription)

## Setup

### 1. Install Claude Code

```bash
# Install Claude Code CLI
curl -fsSL https://claude.ai/install.sh | bash

# IMPORTANT: Create a non-root user
# Claude Code blocks --dangerously-skip-permissions as root
sudo adduser claude --disabled-password
sudo usermod -aG sudo claude

# Switch to the claude user
su - claude

# Authenticate (opens URL for OAuth — copy the URL to your browser)
claude auth login
```

### 2. Enable the Telegram plugin

```bash
claude
# Inside Claude Code:
# /telegram:configure
# Paste your bot token when prompted
```

### 3. Deploy Sentinel

```bash
# Create the channel directory
mkdir -p ~/.claude/channels/telegram

# Copy source files
cp src/gateway.ts ~/.claude/channels/telegram/gateway.ts
cp src/compact-job.ts ~/.claude/channels/telegram/compact-job.ts

# Copy and configure
cp examples/.env.example ~/.claude/channels/telegram/.env
cp examples/access.json ~/.claude/channels/telegram/access.json
cp examples/identity.md ~/.claude/channels/telegram/identity.md

# Edit .env with your tokens
nano ~/.claude/channels/telegram/.env

# Set permissions
chmod 600 ~/.claude/channels/telegram/.env
```

### 4. Configure access control

Edit `~/.claude/channels/telegram/access.json`:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["YOUR_TELEGRAM_USER_ID"],
  "groups": {},
  "pending": {}
}
```

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

### 5. Create the gateway environment file

```bash
cat > ~/.claude/channels/telegram/gateway.env << 'EOF'
TELEGRAM_BOT_TOKEN=your-token-here
EOF
chmod 600 ~/.claude/channels/telegram/gateway.env
```

### 6. Install systemd services

```bash
mkdir -p ~/.config/systemd/user
cp systemd/telegram-gateway.service ~/.config/systemd/user/
cp systemd/telegram-compact.service ~/.config/systemd/user/
cp systemd/telegram-compact.timer ~/.config/systemd/user/

# Enable lingering (keeps services running after SSH logout)
sudo loginctl enable-linger claude

# Reload and start
systemctl --user daemon-reload
systemctl --user enable --now telegram-gateway.service
systemctl --user enable --now telegram-compact.timer
```

### 7. Verify

```bash
# Check gateway status
systemctl --user status telegram-gateway.service

# Watch logs
journalctl --user -u telegram-gateway.service -f

# Send a message on Telegram — you should see:
# [gateway] Message from @username: your message
# [gateway] Spawning persistent Claude session...
# [gateway] Session initialized: abc12345... model=claude-sonnet-4-6
```

## Configuration

### Claude Code settings (`~/.claude/settings.json`)

```json
{
  "model": "claude-sonnet-4-6",
  "effortLevel": "high",
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "enabledPlugins": {
    "telegram@claude-plugins-official": true
  }
}
```

### Identity (`identity.md`)

Customize the bot's persona and behavior. Injected as system prompt on every session start. See `examples/identity.md` for a template.

### Compact schedule

Defaults to 08:00 and 20:00 UTC. Edit:

```bash
systemctl --user edit telegram-compact.timer
```

## Key technical details

### Stream-JSON protocol

The gateway communicates with Claude Code via the undocumented stream-json protocol (reverse-engineered from the Desktop client binary):

**Input** (stdin):
```json
{"type":"user","message":{"role":"user","content":"<channel source=\"telegram\" ...>message</channel>"}}
```

**Cancel a stuck turn** (stdin):
```
SIGINT signal → generates "[Request interrupted by user for tool use]" and exits cleanly
```

**Inject subagent result** (stdin):
```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"<id>","content":"timeout message","is_error":true}]}}
```

**Slash commands** (stdin):
```json
{"type":"user","message":{"role":"user","content":"/compact"}}
```

**Output** (stdout, one JSON per line):
- `system/init` — session ID, model, available slash commands, tools
- `rate_limit_event` — rate limit status and reset time
- `assistant` — Claude's response with tool calls (reply, react, etc.)
- `result` — turn complete with usage stats

### Resume behavior (`eB1` function)

Claude Code decides whether to inject "Continue from where you left off" based on the last entry in the session JSONL:

| Last entry type | Behavior |
|---|---|
| `assistant` | Clean resume — no auto-message |
| `user` with `tool_result` | Injects "Continue from where you left off" |
| `user` (plain) | Re-sends the user's message |

The gateway exploits this: after a watchdog KILL_RESUME_CLEAN, it appends a fake `assistant` entry to force a clean resume.

## Troubleshooting

### Bot not responding

```bash
# Check if gateway is running
systemctl --user status telegram-gateway.service

# Check for stuck Claude processes
ps aux | grep "claude.*stream-json"

# Restart
systemctl --user restart telegram-gateway.service
```

### Bot forgot everything

Run the compact job manually:

```bash
systemctl --user start telegram-compact.service
journalctl --user -u telegram-compact.service -n 20
```

### "API Error: Rate limit reached"

Rate limits are per-model on Claude Max. The `--fallback-model` flag automatically tries an alternate model. The gateway waits with exponential backoff (60s minimum) before retrying.

### Multiple sessions competing (409 errors)

Only one Telegram poller can run at a time. If you have Desktop connected while the gateway runs, they may conflict:

```bash
# Find all telegram MCP servers
ps aux | grep "bun.*telegram" | grep -v grep

# Keep only the gateway's child, kill others
kill <competing_pids>
```

## Status

This is an early-stage project born from practical needs. Claude Code's channel system is actively evolving — some of these gaps will probably be addressed officially. Until then, Sentinel keeps things running.

## License

MIT
