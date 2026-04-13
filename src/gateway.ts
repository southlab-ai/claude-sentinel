// =============================================================================
// TELEGRAM GATEWAY — Persistent Claude Code session manager
// =============================================================================
//
// Architecture: This process runs as a systemd service and manages the lifecycle
// of a single Claude Code CLI session. It polls Telegram for messages, spawns
// Claude with --input-format stream-json, and routes responses back to Telegram.
//
// Key design decisions:
// - Single persistent session (not one-shot per message) for conversation continuity
// - Context injected via --append-system-prompt (identity, compact, protocols, messages)
// - Watchdog system detects stuck tool calls and can kill/respawn the session
// - Subagent monitor handles Agent tool calls that finish but don't deliver results
//
// Incident history (13-abr-2026):
// - E2BIG crash: compact_failed=true loaded 9999 msgs → exceeded 128KB ARG_MAX
// - Fix: msgLimit capped to 100 + buildContext() hard-capped to 80KB total bytes
// - /check was mute during incident because it only worked with a live session
// - Fix: /check now responds inline via tgFetch, independent of session state
// - Duplicate gateway processes ran for 5+ hours without detection
// - Fix: gateway.pid lock with process-name verification
// - Compact failure went unnoticed for hours
// - Fix: notifyCompactFailure() sends direct Telegram message on failure
//
// Security hardening (13-abr-2026 audit):
// - allowFrom check moved BEFORE STT to prevent unauthorized OpenAI API usage
// - Credential JSON files set to chmod 600
// - PRAGMA busy_timeout=5000 prevents SQLITE_BUSY on concurrent access
// - LLM hook auto-creation blocked in compact-job.ts (RCE prevention)
// - Path traversal protection on all LLM-generated file operations
// =============================================================================

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

// --- Config ---
const STATE_DIR = join(process.env.HOME!, ".claude/channels/telegram");
const ENV_FILE = join(STATE_DIR, ".env");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const DB_FILE = join(STATE_DIR, "history.db");
const COMPACT_FILE = join(STATE_DIR, "session-compact.md");
const IDENTITY_FILE = join(STATE_DIR, "identity.md");
const SENTIMENT_FILE = join(STATE_DIR, "sentiment.md");
const NOTE_FILE = join(STATE_DIR, "note_for_next_session.md");
const PROTOCOLS_DIR = join(STATE_DIR, "protocols");
const PID_FILE = join(STATE_DIR, "gateway.pid");

const TOKEN = readFileSync(ENV_FILE, "utf-8")
  .match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]
  ?.trim();
if (!TOKEN) {
  console.error("No TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const OPENAI_API_KEY = readFileSync(ENV_FILE, "utf-8")
  .match(/OPENAI_API_KEY=(.+)/)?.[1]
  ?.trim();

const API = `https://api.telegram.org/bot${TOKEN}`;

// --- Backoff config ---
// Exponential backoff prevents spawn-fail loops (root cause of 5h incident).
// After 10 consecutive failures, the gateway exits entirely — systemd Restart=always
// will restart it, but the delay prevents runaway resource consumption.
// healthReset: if a session runs >10min, we consider it healthy and reset counters.
const BACKOFF = {
  initial: 5_000,
  max: 300_000,
  multiplier: 2,
  healthReset: 600_000,  // 10 min of uptime = healthy
  maxFailures: 10,
  rateLimitMin: 60_000,
};

// --- OpenAI STT (gpt-4o-mini-transcribe) ---
// Voice/audio messages from Telegram are transcribed via OpenAI's API.
// The access check runs BEFORE this function is called (since 13-abr-2026 audit)
// to prevent unauthorized users from burning OpenAI credits with spam audio.
async function transcribeAudio(fileId: string): Promise<string | null> {
  if (!OPENAI_API_KEY) {
    console.error("[gateway] No OPENAI_API_KEY, skipping transcription");
    return null;
  }
  try {
    const fileInfo = await tgFetch("getFile", { file_id: fileId });
    const filePath = fileInfo.result?.file_path;
    if (!filePath) return null;

    const audioUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) return null;
    const audioBlob = await audioRes.blob();

    const ext = filePath.split(".").pop() ?? "ogg";
    const form = new FormData();
    form.append("file", audioBlob, `audio.${ext}`);
    form.append("model", "gpt-4o-mini-transcribe");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      console.error(`[gateway] OpenAI transcription failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const data = await res.json() as { text: string };
    console.log(`[gateway] Transcribed: ${data.text.slice(0, 80)}`);
    return data.text;
  } catch (err) {
    console.error(`[gateway] Transcription error: ${err}`);
    return null;
  }
}

// --- SQLite ---
// WAL mode allows concurrent reads during writes (gateway reads while compact-job writes).
// busy_timeout=5000: wait up to 5s for a lock instead of failing immediately with SQLITE_BUSY.
// This prevents silent data loss when compact-job's DELETE runs during gateway's INSERT.
// (Issue #3 from 13-abr-2026 audit: race between gateway INSERT and compact-job DELETE)
const db = new Database(DB_FILE);
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA busy_timeout = 5000");
let walInsertCount = 0;
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    username TEXT,
    content TEXT NOT NULL,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

function getState(key: string): string | null {
  const row = db.query("SELECT value FROM state WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

function setState(key: string, value: string) {
  db.run(
    "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    key,
    value
  );
}

// --- Access control ---
// Re-reads access.json on every poll cycle (~30s) so changes take effect without restart.
// Managed exclusively via /telegram:access skill — never edited directly (enforced by hook).
function loadAllowList(): string[] {
  if (!existsSync(ACCESS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(ACCESS_FILE, "utf-8"));
    return data.allowFrom ?? [];
  } catch {
    return [];
  }
}

// --- History ---
function saveMessage(
  chatId: string,
  role: string,
  username: string | null,
  content: string
) {
  db.run(
    "INSERT INTO messages (chat_id, role, username, content) VALUES (?, ?, ?, ?)",
    chatId,
    role,
    username,
    content
  );
  // WAL auto-checkpoint every 100 inserts. Without this, the WAL file grew to 4MB+
  // during the 13-abr incident (no automatic checkpoint triggered). PASSIVE mode is
  // safe to run during reads — it checkpoints what it can without blocking.
  walInsertCount++;
  if (walInsertCount >= 100) {
    db.run("PRAGMA wal_checkpoint(PASSIVE)");
    walInsertCount = 0;
  }
}

interface HistoryRow {
  role: string;
  username: string | null;
  content: string;
  ts: string;
}

function getLastMessages(n: number): HistoryRow[] {
  return db
    .query(
      "SELECT role, username, content, ts FROM messages ORDER BY id DESC LIMIT ?"
    )
    .all(n) as HistoryRow[];
}

// --- Telegram API ---
async function tgFetch(method: string, body?: Record<string, unknown>) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<{ ok: boolean; result?: any }>;
}

// --- Session detection ---
function isClaudeChannelRunning(): boolean {
  const result = spawnSync("ps", ["aux"]);
  const output = result.stdout.toString();
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.includes("--channels") && line.includes("telegram")) {
      if (line.includes("gateway.ts")) continue;
      return true;
    }
  }
  return false;
}

// --- Build context for new session ---
// Assembles system prompt context from multiple files: identity, sentiment, compact summary,
// one-time notes, behavioral protocols, and recent message history.
// CRITICAL: This entire string becomes a single --append-system-prompt CLI argument.
// Linux limits individual args to MAX_ARG_STRLEN=128KB. The 80KB byte cap at the end
// ensures we never exceed this, regardless of how large individual components grow.
// The cap was added after the 13-abr-2026 E2BIG incident where 9999 messages caused
// the execve() call to fail, crashing the gateway into a 5-hour spawn-fail loop.
function buildContext(): string {
  const parts: string[] = [];

  if (existsSync(IDENTITY_FILE)) {
    try {
      const identity = readFileSync(IDENTITY_FILE, "utf-8").trim();
      if (identity) parts.push(identity);
    } catch {}
  }

  if (existsSync(SENTIMENT_FILE)) {
    try {
      const sentiment = readFileSync(SENTIMENT_FILE, "utf-8").trim();
      if (sentiment) parts.push(sentiment);
    } catch {}
  }

  if (existsSync(COMPACT_FILE)) {
    try {
      const compact = readFileSync(COMPACT_FILE, "utf-8").trim();
      if (compact) parts.push(`Previous sessions summary:\n${compact}`);
    } catch {}
  }

  if (existsSync(NOTE_FILE)) {
    try {
      const note = readFileSync(NOTE_FILE, "utf-8").trim();
      if (note) {
        parts.push(`Nota de tu subconsciente (del último compact):\n${note}`);
        unlinkSync(NOTE_FILE);
      }
    } catch {}
  }

  // Load behavioral protocols from subconscious
  if (existsSync(PROTOCOLS_DIR)) {
    try {
      const protoFiles = readdirSync(PROTOCOLS_DIR).filter(f => f.endsWith(".md")).sort();
      if (protoFiles.length > 0) {
        const protocols = protoFiles.map(f => {
          const c = readFileSync(join(PROTOCOLS_DIR, f), "utf-8").trim();
          return `[${f}]\n${c}`;
        }).join("\n\n");
        parts.push(`Protocolos de comportamiento (creados por tu subconsciente para mejorar tu rendimiento):\n${protocols}`);
      }
    } catch {}
  }

  // Fallback: if compact failed, the session-compact.md is stale/missing, so we load
  // more raw messages to compensate. Capped at 100 (was 9999 pre-incident) to prevent
  // E2BIG. The 80KB byte cap below is the ultimate safety net regardless of message count.
  const compactFailed = getState("compact_failed") === "true";
  const msgLimit = compactFailed ? 100 : 30;
  if (compactFailed) {
    console.log("[gateway] compact_failed flag detected — loading last 100 messages as fallback (capped to prevent E2BIG)");
  }

  const messages = getLastMessages(msgLimit).reverse();
  if (messages.length > 0) {
    const formatted = messages
      .map((m) => {
        const time = m.ts;
        const who = m.role === "user" ? `@${m.username ?? "user"}` : "Bot";
        return `[${time}] ${who}: ${m.content}`;
      })
      .join("\n");
    const label = compactFailed
      ? `⚠️ COMPACT FAILED — loading all ${messages.length} raw messages as fallback:\n`
      : `Últimas conversaciones de Telegram:\n`;
    parts.push(`${label}${formatted}`);
  }

  let result = parts.join("\n\n");

  // Hard cap at 80KB to prevent E2BIG. Linux MAX_ARG_STRLEN = 128KB for a single arg.
  // We leave ~48KB headroom for env vars and other CLI args.
  // Truncation removes from the end (messages), preserving identity and compact summary.
  const MAX_CONTEXT_BYTES = 80 * 1024;
  if (Buffer.byteLength(result, "utf-8") > MAX_CONTEXT_BYTES) {
    console.log(`[gateway] Context too large (${Buffer.byteLength(result, "utf-8")} bytes), truncating to ${MAX_CONTEXT_BYTES} bytes`);
    // Truncate from the end (messages are the most expendable part)
    while (Buffer.byteLength(result, "utf-8") > MAX_CONTEXT_BYTES && result.length > 1000) {
      // Remove last 10% of characters
      result = result.slice(0, Math.floor(result.length * 0.9));
    }
    result += "\n\n[... context truncated to fit ARG_MAX safely ...]";
  }

  return result;
}

// --- Message types ---
interface TelegramMessage {
  chatId: string;
  messageId?: string;
  username: string;
  text: string;
  ts: string;
  attachment?: {
    kind: string;
    file_id: string;
    mime?: string;
    size?: number;
  };
}

// --- Format message as channel tag ---
function formatAsChannelTag(m: TelegramMessage): string {
  const msgIdAttr = m.messageId ? ` message_id="${m.messageId}"` : "";
  const attachAttrs = m.attachment
    ? ` attachment_kind="${m.attachment.kind}" attachment_file_id="${m.attachment.file_id}"${m.attachment.mime ? ` attachment_mime="${m.attachment.mime}"` : ""}${m.attachment.size ? ` attachment_size="${m.attachment.size}"` : ""}`
    : "";
  return `<channel source="telegram" chat_id="${m.chatId}"${msgIdAttr}${attachAttrs} user="${m.username}" ts="${m.ts}">\n${m.text}\n</channel>`;
}

// --- Spawn persistent Claude session ---
// Three context modes control how much memory the new session receives:
//   "full"  = identity + compact + protocols + 30 msgs (default for fresh starts)
//   "light" = last 5 msgs only (after KILL_RESUME_CLEAN, session retains its history)
//   "none"  = no extra context (KILL_RESUME_CONTINUE, session has everything it needs)
//
// Context is injected via --append-system-prompt which APPENDS to the existing system
// prompt (CLAUDE.md, channel plugin instructions). Using --system-prompt instead would
// OVERWRITE the defaults and break the channel plugin. This distinction is critical.
//
// The session uses stream-json for bidirectional communication:
// - stdin: JSON messages (user messages, tool results, slash commands)
// - stdout: JSON events (assistant messages, tool use, system events)
//
// PATH includes both .local/bin (where claude CLI lives) and .bun/bin (where bun lives).
// These are different locations — mixing them up caused the cron failure in the incident.
function spawnPersistentSession(fresh = false, contextMode: "full" | "light" | "none" = "full"): ChildProcess {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--channels", "plugin:telegram@claude-plugins-official",
    "--model", "claude-opus-4-6[1m]",
    "--effort", "high",
    "--dangerously-skip-permissions",
    "--fallback-model", "claude-opus-4-6",
  ];

  const sessionId = getState("session_id");
  if (sessionId && !fresh) {
    args.push("--resume", sessionId);
  }

  // Inject context based on mode
  if (contextMode === "full") {
    const context = buildContext();
    if (context) args.push("--append-system-prompt", context);
  } else if (contextMode === "light") {
    // Only last 5 messages — for catching queue messages that didn't make it into the session
    const msgs = getLastMessages(5).reverse();
    if (msgs.length > 0) {
      const formatted = msgs
        .map((m) => {
          const who = m.role === "user" ? `@${m.username ?? "user"}` : "Bot";
          return `[${m.ts}] ${who}: ${m.content}`;
        })
        .join("\n");
      args.push("--append-system-prompt", `Recent messages:\n${formatted}`);
    }
  }
  // contextMode === "none" → no --append-system-prompt

  const mode = fresh ? "fresh" : sessionId ? `resume ${sessionId.slice(0, 8)}` : "new";
  console.log(`[gateway] Spawning session: ${mode} context=${contextMode}`);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    cwd: process.env.HOME,
    env: {
      ...process.env,
      HOME: process.env.HOME,
      PATH: `/usr/local/bin:/home/claude/.local/bin:/home/claude/.bun/bin:${process.env.PATH}`,
    },
  });

  return proc;
}

// --- Typing indicator ---
// Sends "typing..." indicator to Telegram every 4s while Claude is processing.
// stopTyping() is called in: reply events, result events, proc.on("exit"), proc.on("error").
// The exit/error handlers were added after the audit found that a crash would leave
// the typing indicator running indefinitely, misleading the user into thinking the bot
// was still processing. (Issue #16 from 13-abr-2026 audit)
let typingInterval: ReturnType<typeof setInterval> | null = null;
let typingChatId: string | null = null;

function startTyping(chatId: string) {
  stopTyping();
  typingChatId = chatId;
  tgFetch("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  typingInterval = setInterval(() => {
    tgFetch("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }, 4_000);
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
  typingChatId = null;
}

// --- Send message to persistent session via stdin ---
function sendToSession(proc: ChildProcess, messages: TelegramMessage[]) {
  const chatId = messages[messages.length - 1]?.chatId;
  if (chatId) startTyping(chatId);

  const channelTags = messages.map(formatAsChannelTag).join("\n\n");
  const msg = JSON.stringify({
    type: "user",
    message: { role: "user", content: channelTags },
  });
  proc.stdin?.write(msg + "\n");
}

// --- Stream-JSON stdout parser ---
function setupStreamParser(proc: ChildProcess, state: SupervisorState) {
  let buffer = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleStreamEvent(event, state);
      } catch {}
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.trim()) {
      console.error(`[gateway] stderr: ${text.slice(0, 300)}`);
    }
    if (text.includes("rate limit") || text.includes("429")) {
      state.hitRateLimit = true;
    }
  });
}

function handleStreamEvent(event: any, state: SupervisorState) {
  // Every event = activity (for watchdog)
  state.lastActivityTime = Date.now();

  // Track session_id
  if (event.session_id) {
    state.currentSessionId = event.session_id;
  }

  // Capture session_id and available commands from init
  if (event.session_id && event.type === "system" && event.subtype === "init") {
    setState("session_id", event.session_id);
    const cmds = event.slash_commands ?? [];
    state.availableCommands = new Set(cmds.map((c: string) => c.toLowerCase()));
    console.log(`[gateway] Session initialized: ${event.session_id.slice(0, 8)}... model=${event.model} commands=${cmds.length}`);

    // Register commands in Telegram Bot API (auto-updates on plugin changes)
    const botCommands = [
      { command: "check", description: "Quick status check" },
      { command: "health", description: "Full telemetry report" },
      { command: "reboot", description: "Force watchdog diagnostic" },
      { command: "vpsstatus", description: "Quick VPS/session status" },
      ...cmds
        .filter((c: string) => !c.includes(":"))  // Telegram doesn't allow : in commands
        .slice(0, 99)  // Telegram max 100 commands
        .map((c: string) => ({ command: c.toLowerCase(), description: "Claude slash command" })),
    ];
    tgFetch("setMyCommands", { commands: botCommands })
      .then(() => console.log(`[gateway] Registered ${botCommands.length} bot commands`))
      .catch((err) => console.error(`[gateway] Failed to register commands: ${err}`));
  }

  // Capture session_id from result events too
  if (event.session_id && event.type === "result") {
    setState("session_id", event.session_id);
  }

  // Detect rate limit events
  if (event.type === "rate_limit_event") {
    state.hitRateLimit = true;
    console.log(`[gateway] Rate limit event: ${JSON.stringify(event.rate_limit_info ?? {})}`);
  }

  // Detect rate limit in assistant error responses
  if (event.type === "assistant" && event.error === "rate_limit") {
    state.hitRateLimit = true;
    console.log("[gateway] Rate limit error in assistant response");
  }

  // Track active tool_use id (for watchdog + subagent monitor)
  if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use") {
          state.activeToolUseId = block.id;
          // Start file monitor for Agent subagents
          if (block.name === "Agent") {
            startSubagentMonitor(state);
          }
        }
        // Capture reply tool calls for history DB + stop typing
        if (block.type === "tool_use" && block.name?.includes("reply")) {
          stopTyping();
          const input = block.input;
          if (input?.chat_id && input?.text) {
            saveMessage(input.chat_id, "assistant", "bot", input.text.slice(0, 2000));
          }
        }
      }
    }
  }

  // Clear active tool on result (turn complete)
  if (event.type === "result") {
    stopTyping();
    stopSubagentMonitor(state);
    state.activeToolUseId = null;
  }
}

// --- Supervisor state ---
interface SupervisorState {
  proc: ChildProcess | null;
  backoffMs: number;
  consecutiveFailures: number;
  lastStartTime: number;
  hitRateLimit: boolean;
  resumeFailed: boolean;
  // Watchdog
  lastActivityTime: number;
  activeToolUseId: string | null;
  currentSessionId: string | null;
  watchdogRunning: boolean;
  lastFailureContext: string | null;
  // Dynamic slash commands
  availableCommands: Set<string>;
  // Next spawn context mode (set by watchdog)
  nextContextMode: "full" | "light" | "none";
  // Subagent file monitor
  subagentMonitorInterval: ReturnType<typeof setInterval> | null;
}

// --- Subagent file monitor ---
// When Claude spawns an Agent subagent, the parent session blocks waiting for the result.
// If the subagent finishes but the result never gets delivered (IPC failure), or if the
// subagent hangs for >10 minutes, this monitor reads the subagent's JSONL file directly
// and injects a synthetic tool_result into the parent session's stdin to unblock it.
// This prevents the common "Agent finished but parent is stuck waiting" failure mode.
const SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min idle = probably dead

function startSubagentMonitor(state: SupervisorState) {
  if (state.subagentMonitorInterval) clearInterval(state.subagentMonitorInterval);

  state.subagentMonitorInterval = setInterval(() => {
    if (!isSessionAlive(state) || !state.activeToolUseId || !state.currentSessionId) {
      clearInterval(state.subagentMonitorInterval!);
      state.subagentMonitorInterval = null;
      return;
    }

    try {
      const subagentDir = join(process.env.HOME!, `.claude/projects/-home-claude/${state.currentSessionId}/subagents`);
      if (!existsSync(subagentDir)) return;

      const files = readdirSync(subagentDir)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ name: f, mtime: statSync(join(subagentDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) return;

      const latest = files[0];
      const idleMs = Date.now() - latest.mtime;
      const latestPath = join(subagentDir, latest.name);

      // Read last lines to check status
      let subagentFinished = false;
      let summary = "No partial results available.";
      try {
        const content = readFileSync(latestPath, "utf-8");
        const lines = content.trim().split("\n");
        const lastLines = lines.slice(-10);

        // Check if subagent finished (last assistant has stop_reason: "end_turn")
        for (let i = lastLines.length - 1; i >= 0; i--) {
          const d = JSON.parse(lastLines[i]);
          if (d.type === "assistant" && d.message?.stop_reason === "end_turn") {
            subagentFinished = true;
            // Extract the final response as summary
            const finalContent = d.message.content;
            if (Array.isArray(finalContent)) {
              const texts = finalContent
                .filter((c: any) => c.type === "text" && c.text?.trim())
                .map((c: any) => c.text.trim());
              if (texts.length > 0) summary = texts.join("\n").slice(0, 2000);
            }
            break;
          }
        }

        // If not finished, extract partial results
        if (!subagentFinished) {
          const partialResults: string[] = [];
          for (const line of lastLines) {
            const d = JSON.parse(line);
            const msgContent = d.message?.content;
            if (Array.isArray(msgContent)) {
              for (const block of msgContent) {
                if (block.type === "text" && block.text?.trim()) {
                  partialResults.push(block.text.trim().slice(0, 200));
                }
              }
            }
          }
          if (partialResults.length > 0) {
            summary = "Partial results before timeout:\n" + partialResults.slice(-3).join("\n");
          }
        }
      } catch {}

      // Inject if: subagent finished but parent never got result, OR idle too long
      const shouldInject = subagentFinished || idleMs > SUBAGENT_TIMEOUT_MS;

      if (shouldInject) {
        const reason = subagentFinished
          ? `Subagent completed but result was not delivered to parent session.`
          : `Subagent timed out after ${Math.round(idleMs / 60_000)} minutes without responding.`;

        console.log(`[gateway] ${reason} Injecting tool_result.`);

        const toolResult = JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: state.activeToolUseId,
              content: `${reason}\n\n${summary}${subagentFinished ? "" : "\n\nInform the user that the task did not complete and ask if they want to retry."}`,
              is_error: !subagentFinished,
            }],
          },
        });
        state.proc!.stdin?.write(toolResult + "\n");

        clearInterval(state.subagentMonitorInterval!);
        state.subagentMonitorInterval = null;
        state.activeToolUseId = null;
        state.lastActivityTime = Date.now();
      }
    } catch (err) {
      console.error(`[gateway] Subagent monitor error: ${err}`);
    }
  }, 60_000); // Check every 60s
}

function stopSubagentMonitor(state: SupervisorState) {
  if (state.subagentMonitorInterval) {
    clearInterval(state.subagentMonitorInterval);
    state.subagentMonitorInterval = null;
  }
}

// --- Watchdog (fallback) ---
// Last-resort diagnostic system for stuck sessions. Spawns a separate one-shot Claude
// instance that investigates the stuck session (reads JSONL, checks processes) and writes
// a decision to /tmp/watchdog-action. Decisions:
// - WAIT: subagent is still working, do nothing
// - KILL_RESUME_CLEAN: kill + resume WITHOUT "continue" (prevents auto-acting on unanswered questions)
// - KILL_RESUME_CONTINUE: kill + resume WITH "continue" (auto-retry explicitly requested tasks)
// - KILL_FRESH: kill + compact + fresh start (for bloated or corrupt sessions)
//
// Auto-trigger: 20 min no activity with a pending tool call.
// Manual trigger: /check (if tool stuck >60s) or /reboot (unconditional).
//
// NOTE: The watchdog has two --model flags (lines ~713-717). The second one (sonnet)
// overrides the first (opus). This is a known pre-existing issue — the watchdog runs
// on Sonnet, which is sufficient for diagnostic analysis.
const WATCHDOG_TIMEOUT_MS = 20 * 60 * 1000; // 20 min no activity

async function spawnWatchdogAgent(state: SupervisorState): Promise<void> {
  const sessionId = state.currentSessionId;
  const toolUseId = state.activeToolUseId;
  const idleMinutes = Math.round((Date.now() - state.lastActivityTime) / 60_000);
  const subagentDir = join(process.env.HOME!, `.claude/projects/-home-claude/${sessionId}/subagents`);
  const sessionFile = join(process.env.HOME!, `.claude/projects/-home-claude/${sessionId}.jsonl`);

  console.log(`[gateway] Watchdog: spawning diagnostic agent (idle ${idleMinutes}min, tool=${toolUseId?.slice(0, 12)})`);

  const prompt = `You are a watchdog diagnostic agent for a Claude Code Telegram bot. The bot session has been idle for ${idleMinutes} minutes with a pending tool call (id: ${toolUseId}).

## Investigation steps

Run these commands and analyze the results:

1. Check parent process: ps -p ${state.proc!.pid} -o pid,state,etime
2. List subagent files: ls -lt ${subagentDir}/ 2>/dev/null
3. Read the LAST 10 lines of the most recent subagent JSONL to check if it finished or is stuck
4. Check queued user messages: tail -15 ${sessionFile} | grep -c "queue-operation"
5. Find the last assistant message BEFORE the stuck tool call — check if it was a question or proposal awaiting user reply

## Decision: write ONE action to /tmp/watchdog-action

### WAIT
The subagent is still actively working. Evidence: subagent JSONL file modified within the last 5 minutes, or the process is alive and making progress.

### KILL_RESUME_CLEAN
The subagent is stuck (no activity for ${idleMinutes}+ min) but the conversation topic is still relevant. The session will resume WITHOUT "Continue from where you left off" — Claude will NOT auto-retry the failed task.

**Use this when (most common):**
- Subagent received all tool results but never generated a final response
- Subagent process is dead or not making progress
- There are user messages waiting in queue

**CRITICAL — use this when the last assistant message was a question or proposal:**
If the assistant's last message before the stuck tool was something like "¿Te las instalo?" or "Should I proceed?" — the user NEVER answered. If we use KILL_RESUME_CONTINUE, Claude will interpret "Continue from where you left off" as implicit approval and auto-execute the unanswered proposal. This is dangerous — the bot would take actions the user never approved.

### KILL_RESUME_CONTINUE
The subagent is stuck on a task the user explicitly requested AND there is no unanswered question. The session will resume WITH "Continue from where you left off" so Claude auto-retries the task. The gateway will respawn immediately without waiting for a user message.

**Use this only when ALL of these are true:**
- The user explicitly asked for the stuck task (not a subagent's own initiative)
- The last assistant message was NOT a question awaiting reply
- The task is clearly incomplete (e.g., file write interrupted mid-way)
- This is RARE — when in doubt, use KILL_RESUME_CLEAN

### KILL_FRESH
The session should be completely restarted. A compact job will run first to preserve conversation memory. The new session starts clean with no history from the old one.

**Use this when:**
- The session JSONL is very large (check file size with: wc -c ${sessionFile})
- The session has been running for more than 24 hours
- The stuck task is completely unrelated to the user's likely next request
- There are signs of a bloat death spiral (repeated API errors, context too large)

## Output format

Write to /tmp/watchdog-action with the decision on the first line and a concise reason on the second line. Example:

KILL_RESUME_CLEAN
Subagent received all WebSearch results 4 hours ago but never generated response. Last assistant message was "¿Te las instalo?" — an unanswered question. Clean resume prevents auto-acting on this.`;

  try {
    try { require("fs").unlinkSync("/tmp/watchdog-action"); } catch {}

    const result = spawnSync("claude", [
      "-p", prompt,
      "--model", "claude-opus-4-6[1m]",
    "--effort", "high",
    "--dangerously-skip-permissions",
      "--output-format", "text",
      "--model", "claude-sonnet-4-6",
    ], {
      encoding: "utf-8",
      timeout: 120_000,
      cwd: process.env.HOME,
      env: {
        ...process.env,
        HOME: process.env.HOME,
        PATH: `/usr/local/bin:/home/claude/.local/bin:/home/claude/.bun/bin:${process.env.PATH}`,
      },
    });

    if (result.status !== 0) {
      console.error(`[gateway] Watchdog agent failed: ${result.stderr?.slice(0, 200)}`);
      return;
    }

    const actionFile = readFileSync("/tmp/watchdog-action", "utf-8").trim();
    const [decision, ...reasonLines] = actionFile.split("\n");
    const reason = reasonLines.join(" ").trim();
    console.log(`[gateway] Watchdog decision: ${decision} — ${reason}`);

    if (decision === "WAIT") {
      console.log("[gateway] Watchdog: waiting, session appears active");

    } else if (decision === "KILL_RESUME_CLEAN") {
      state.proc!.kill("SIGINT");
      console.log("[gateway] Watchdog: SIGINT sent (clean resume)");
      await new Promise(r => setTimeout(r, 2_000));
      // Write fake assistant entry so --resume doesn't inject "Continue from where you left off"
      try {
        const fakeEntry = JSON.stringify({
          type: "assistant",
          message: {
            model: "<synthetic>",
            role: "assistant",
            content: [{ type: "text", text: `[Session interrupted by watchdog: ${reason}]` }],
            stop_reason: "end_turn",
          },
          timestamp: new Date().toISOString(),
        });
        appendFileSync(sessionFile, fakeEntry + "\n");
      } catch (e) {
        console.error(`[gateway] Watchdog: failed to write fake entry: ${e}`);
      }
      state.lastFailureContext = `[System: The previous session was interrupted by the watchdog after ${idleMinutes} minutes of inactivity. Reason: ${reason}. Do NOT retry or continue the failed task unless the user explicitly asks. Inform the user briefly what happened and wait for instructions.]`;
      state.nextContextMode = "light";

    } else if (decision === "KILL_RESUME_CONTINUE") {
      state.proc!.kill("SIGINT");
      console.log("[gateway] Watchdog: SIGINT sent (resume with continue)");
      await new Promise(r => setTimeout(r, 2_000));
      // Respawn immediately with no extra context — session has everything
      console.log("[gateway] Watchdog: respawning session to continue task...");
      const proc = spawnPersistentSession(false, "none");
      state.proc = proc;
      state.lastStartTime = Date.now();
      state.lastActivityTime = Date.now();
      setupStreamParser(proc, state);
      setupExitHandler(proc, state);

    } else if (decision === "KILL_FRESH") {
      state.proc!.kill("SIGINT");
      console.log("[gateway] Watchdog: SIGINT sent (fresh start)");
      await new Promise(r => setTimeout(r, 2_000));
      // Run compact to preserve memory before starting fresh
      runCompactJob();
      setState("session_id", "");
      state.resumeFailed = true;
      state.lastFailureContext = `[System: The previous session was terminated and compacted by the watchdog after ${idleMinutes} minutes of inactivity. Reason: ${reason}. This is a fresh session — conversation history has been compacted into memory. Do NOT retry the failed task. Inform the user what happened and wait for instructions.]`;

    } else {
      console.log(`[gateway] Watchdog: unknown decision '${decision}', doing nothing`);
    }

  } catch (err) {
    console.error(`[gateway] Watchdog error: ${err}`);
  }
}

// --- Telegram polling ---
// Long-polls Telegram every 30s. Access control runs FIRST, before any media processing.
// This order was changed in the 13-abr-2026 audit (Issue #9): previously, STT transcription
// ran BEFORE the access check, meaning unauthorized voice messages burned OpenAI API credits.
// Now: unauthorized users get their raw text saved (audit trail) but no STT, no forwarding.

let offset = parseInt(getState("polling_offset") ?? "0", 10);

async function pollTelegram(): Promise<TelegramMessage[]> {
  const data = await tgFetch("getUpdates", {
    offset,
    timeout: 30,
    allowed_updates: ["message"],
  });

  if (!data.ok || !data.result?.length) return [];

  const allowList = loadAllowList();
  const pendingMessages: TelegramMessage[] = [];

  for (const update of data.result) {
    offset = update.update_id + 1;
    setState("polling_offset", String(offset));

    const msg = update.message;
    if (!msg?.from) continue;

    const senderId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const username = msg.from.username ?? senderId;

    // Access check FIRST — before STT to avoid wasting OpenAI credits on unauthorized users
    if (!allowList.includes(senderId)) {
      const rawText = msg.text ?? msg.caption ?? "(unauthorized media)";
      saveMessage(chatId, "user", username, rawText); // audit trail with raw text only
      console.log(`[gateway] Ignored message from ${senderId} (not in allowlist)`);
      continue;
    }

    // Authorized user — now process media and STT
    let text = msg.text ?? msg.caption ?? "";
    let attachment: TelegramMessage["attachment"] = undefined;

    if (msg.voice) {
      attachment = { kind: "voice", file_id: msg.voice.file_id, mime: msg.voice.mime_type, size: msg.voice.file_size };
      const transcript = await transcribeAudio(msg.voice.file_id);
      if (transcript) {
        text = `[Audio transcrito]: ${transcript}`;
      } else if (!text) {
        text = "(voice message)";
      }
    } else if (msg.audio) {
      attachment = { kind: "audio", file_id: msg.audio.file_id, mime: msg.audio.mime_type, size: msg.audio.file_size };
      const transcript = await transcribeAudio(msg.audio.file_id);
      if (transcript) {
        text = `[Audio transcrito]: ${transcript}`;
      } else if (!text) {
        text = `(audio: ${msg.audio.title ?? msg.audio.file_name ?? "audio"})`;
      }
    } else if (msg.photo) {
      const best = msg.photo[msg.photo.length - 1];
      attachment = { kind: "photo", file_id: best.file_id, size: best.file_size };
      if (!text) text = "(photo)";
    } else if (msg.video) {
      attachment = { kind: "video", file_id: msg.video.file_id, mime: msg.video.mime_type, size: msg.video.file_size };
      if (!text) text = `(video: ${msg.video.file_name ?? "video"})`;
    } else if (msg.video_note) {
      attachment = { kind: "video_note", file_id: msg.video_note.file_id, size: msg.video_note.file_size };
      if (!text) text = "(video note)";
    } else if (msg.sticker) {
      attachment = { kind: "sticker", file_id: msg.sticker.file_id };
      if (!text) text = `(sticker: ${msg.sticker.emoji ?? "sticker"})`;
    } else if (msg.document) {
      attachment = { kind: "document", file_id: msg.document.file_id, mime: msg.document.mime_type, size: msg.document.file_size };
      if (!text) text = `(document: ${msg.document.file_name ?? "file"})`;
    }

    if (!text && !attachment) continue;

    // Save to history (authorized user, full content including transcription)
    saveMessage(chatId, "user", username, text);
    setState("last_chat_id", chatId); // track for compact failure notifications

    console.log(`[gateway] Message from @${username}: ${text.slice(0, 80)}`);
    pendingMessages.push({
      chatId,
      messageId: String(msg.message_id),
      username,
      text,
      ts: new Date(msg.date * 1000).toISOString(),
      ...(attachment ? { attachment } : {}),
    });
  }

  return pendingMessages;
}

// --- PID lock ---
// Prevents duplicate gateway processes (caused 5h of competing spawns in the incident).
// On startup, checks if gateway.pid contains a live PID:
// - Dead PID → stale lock, take over (handles crashes, SIGKILL, reboots)
// - Live PID of another process → PID reuse after reboot, take over (verified via ps)
// - Live PID of gateway.ts → another gateway running, abort
// Released on SIGINT/SIGTERM. Only deletes if PID matches ours (prevents cross-deletion).
// Known limitation: TOCTOU race if two gateways start simultaneously (negligible in practice).
function acquirePidLock(): boolean {
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0); // test if process is alive
        // Verify it's actually a gateway process, not a PID-reuse false positive
        const psResult = spawnSync("ps", ["-p", String(oldPid), "-o", "args="], { encoding: "utf-8" });
        const psOutput = psResult.stdout?.trim() ?? "";
        if (psOutput.includes("gateway.ts")) {
          console.error(`[gateway] Another gateway is already running (PID ${oldPid}). Aborting.`);
          return false;
        } else {
          console.log(`[gateway] PID ${oldPid} is alive but not a gateway process ("${psOutput.slice(0, 60)}"). Taking over.`);
        }
      } catch {
        console.log(`[gateway] Stale PID file found (PID ${oldPid} dead). Taking over.`);
      }
    }
  }
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`[gateway] PID lock acquired: ${process.pid}`);
  return true;
}

function releasePidLock() {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (pid === process.pid) {
        unlinkSync(PID_FILE);
        console.log("[gateway] PID lock released.");
      }
    }
  } catch {}
}

if (!acquirePidLock()) {
  process.exit(1);
}

// --- Main supervisor loop ---
// Core event loop: poll Telegram → route commands → manage session lifecycle.
// Key behaviors:
// - Defers to Desktop Claude sessions (avoids conflicts when user has terminal open)
// - Kills idle sessions after 30min to free resources (will resume on next message)
// - Auto-triggers watchdog after 20min of tool inactivity
// - Exits after 10 consecutive spawn failures (systemd restarts the service)
let running = true;

process.on("SIGINT", () => {
  running = false;
  releasePidLock();
  console.log("[gateway] Shutting down...");
});
process.on("SIGTERM", () => {
  running = false;
  releasePidLock();
  console.log("[gateway] Shutting down...");
});

function isSessionAlive(state: SupervisorState): boolean {
  return state.proc !== null && !state.proc.killed && state.proc.exitCode === null;
}

function runCompactJob() {
  console.log("[gateway] Running compact job...");
  const result = spawnSync("bun", ["run", join(STATE_DIR, "compact-job.ts")], {
    encoding: "utf-8",
    timeout: 660_000, // 11 min (compact has 5min timeout x2 attempts + overhead)
    cwd: process.env.HOME,
    env: {
      ...process.env,
      HOME: process.env.HOME,
      PATH: `/usr/local/bin:/home/claude/.local/bin:/home/claude/.bun/bin:${process.env.PATH}`,
    },
  });
  if (result.status === 0) {
    console.log("[gateway] Compact job completed");
  } else {
    console.error(`[gateway] Compact job failed: ${result.stderr?.slice(0, 200)}`);
  }
}

function setupExitHandler(proc: ChildProcess, state: SupervisorState) {
  proc.on("exit", (code) => {
    stopTyping();
    stopSubagentMonitor(state);
    const uptime = Date.now() - state.lastStartTime;
    console.log(`[gateway] Session exited code=${code} uptime=${Math.round(uptime / 1000)}s`);

    // Always compact + fresh on next spawn (unless watchdog already set a specific mode)
    if (!state.lastFailureContext) {
      // No watchdog decision pending — default to compact + fresh
      runCompactJob();
      setState("session_id", "");
      state.resumeFailed = true;
      state.nextContextMode = "full";
    }

    // Backoff logic
    if (uptime > BACKOFF.healthReset) {
      state.consecutiveFailures = 0;
      state.backoffMs = BACKOFF.initial;
    } else if (code === 0) {
      state.backoffMs = BACKOFF.initial;
    } else {
      state.consecutiveFailures++;
      state.backoffMs = Math.min(state.backoffMs * BACKOFF.multiplier, BACKOFF.max);
      if (state.hitRateLimit) {
        state.backoffMs = Math.max(state.backoffMs, BACKOFF.rateLimitMin);
        console.log(`[gateway] Rate limit detected, backoff=${state.backoffMs}ms`);
      }
    }

    state.proc = null;
  });

  proc.on("error", (err) => {
    stopTyping();
    console.error(`[gateway] Failed to spawn Claude: ${err.message}`);
    state.proc = null;
  });
}

async function run() {
  console.log("[gateway] Telegram Gateway started (persistent mode). Waiting for messages...");

  const gatewayStartTime = Date.now();

  const state: SupervisorState = {
    proc: null,
    backoffMs: BACKOFF.initial,
    consecutiveFailures: 0,
    lastStartTime: 0,
    hitRateLimit: false,
    resumeFailed: false,
    lastActivityTime: 0,
    activeToolUseId: null,
    currentSessionId: null,
    watchdogRunning: false,
    lastFailureContext: null,
    availableCommands: new Set<string>(),
    nextContextMode: "full",
    subagentMonitorInterval: null,
  };

  while (running) {
    // If another session (e.g. Desktop) is running with channels, defer to it
    if (!isSessionAlive(state) && isClaudeChannelRunning()) {
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }

    // Idle session killer: 30 min no activity, no pending tools → kill session
    if (isSessionAlive(state) && !state.activeToolUseId && state.lastActivityTime > 0) {
      const idleMs = Date.now() - state.lastActivityTime;
      if (idleMs > 30 * 60 * 1000) {
        console.log(`[gateway] Session idle ${Math.round(idleMs / 60_000)}min with no activity, killing to free resources`);
        state.proc!.kill("SIGTERM");
        // Don't set resumeFailed — next spawn will resume cleanly
      }
    }

    // Watchdog: check for stuck turns
    if (isSessionAlive(state) && !state.watchdogRunning) {
      const idleMs = state.lastActivityTime > 0 ? Date.now() - state.lastActivityTime : 0;
      const autoTrigger = state.activeToolUseId && idleMs > WATCHDOG_TIMEOUT_MS;

      if (autoTrigger) {
        // Auto watchdog — 20 min no activity with pending tool
        state.watchdogRunning = true;
        spawnWatchdogAgent(state).finally(() => {
          state.watchdogRunning = false;
        });
      }
    }

    // Always poll Telegram for new messages
    try {
      const allMessages = await pollTelegram();

      // Separate slash commands from regular messages
      const pendingSlashCommands: string[] = [];
      const messages: TelegramMessage[] = [];

      for (const msg of allMessages) {
        const trimmed = msg.text.trim();
        if (trimmed.startsWith("/")) {
          const cmd = trimmed.split(/\s+/)[0].slice(1).toLowerCase();

          // /check: fast-path health check (gateway-internal, never forwarded to Claude session).
          // Pre-incident: only set a flag consumed inside isSessionAlive() → silent when session dead.
          // Post-fix: responds INLINE via tgFetch regardless of session state.
          // Also triggers watchdog diagnostic if a tool has been stuck >60s (activeToolUseId + idle).
          if (cmd === "check") {
            const alive = isSessionAlive(state);
            const gwH = Math.round((Date.now() - gatewayStartTime) / 3600_000);
            const sessMin = alive ? Math.round((Date.now() - state.lastStartTime) / 60_000) : 0;
            const idleMs = state.lastActivityTime > 0 ? Date.now() - state.lastActivityTime : 0;
            const idleStr = idleMs < 60_000 ? `${Math.round(idleMs / 1000)}s` : `${Math.round(idleMs / 60_000)}min`;
            const tool = state.activeToolUseId ? state.activeToolUseId.slice(0, 12) : "none";
            const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const compactFlag = getState("compact_failed") === "true" ? "⚠️ YES" : "OK";
            const walSize = (() => { try { return Math.round(statSync(DB_FILE + "-wal").size / 1024); } catch { return 0; } })();

            // Always respond with status first (works even with dead session)
            const statusLines = [
              `🔍 Health Check`,
              `Gateway: ${gwH}h uptime | PID ${process.pid} | ${memMB}MB RAM`,
              `Session: ${alive ? `✅ active ${sessMin}min` : "❌ dead"} [${state.currentSessionId?.slice(0, 8) ?? "-"}]`,
              `Idle: ${idleStr} | Tool: ${tool}`,
              `Failures: ${state.consecutiveFailures} | compact_failed: ${compactFlag}`,
              `WAL: ${walSize}KB | Model: opus-1m`,
            ];

            // If session alive with a stuck tool (>60s), also trigger watchdog diagnostic
            if (alive && state.activeToolUseId && idleMs > 60_000 && !state.watchdogRunning) {
              statusLines.push(`⚠️ Tool stuck ${Math.round(idleMs / 1000)}s — launching watchdog diagnostic...`);
              state.watchdogRunning = true;
              spawnWatchdogAgent(state).finally(() => {
                state.watchdogRunning = false;
              });
            }

            tgFetch("sendMessage", {
              chat_id: msg.chatId,
              text: statusLines.join("\n"),
            }).catch(() => {});
            continue;
          }

          // /reboot: unconditional watchdog trigger (added post-audit per Jorge's request).
          // Unlike /check which only triggers watchdog if tool stuck >60s, /reboot forces
          // a full diagnostic regardless. If session is dead, forces a fresh spawn instead.
          if (cmd === "reboot") {
            const alive = isSessionAlive(state);
            if (!alive) {
              tgFetch("sendMessage", {
                chat_id: msg.chatId,
                text: "🔄 No hay sesión activa. Forzando spawn fresh...",
              }).catch(() => {});
              state.resumeFailed = true;
              state.nextContextMode = "full";
              // Session will be spawned by the main loop on next iteration
            } else if (state.watchdogRunning) {
              tgFetch("sendMessage", {
                chat_id: msg.chatId,
                text: "⚠️ Watchdog ya está corriendo. Esperá a que termine.",
              }).catch(() => {});
            } else {
              tgFetch("sendMessage", {
                chat_id: msg.chatId,
                text: "🔄 Forzando watchdog diagnóstico...",
              }).catch(() => {});
              state.watchdogRunning = true;
              spawnWatchdogAgent(state).finally(() => {
                state.watchdogRunning = false;
              });
            }
            continue;
          }

          // /vpsstatus is gateway-internal (instant status report)
          if (cmd === "vpsstatus") {
            const alive = isSessionAlive(state);
            const gwH = Math.round((Date.now() - gatewayStartTime) / 3600_000);
            const sessMin = alive ? Math.round((Date.now() - state.lastStartTime) / 60_000) : 0;
            const idleMs = state.lastActivityTime > 0 ? Date.now() - state.lastActivityTime : 0;
            const idleStr = idleMs < 60_000 ? `${Math.round(idleMs / 1000)}s` : `${Math.round(idleMs / 60_000)}min`;
            const tool = state.activeToolUseId ? state.activeToolUseId.slice(0, 12) : "none";
            const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
            tgFetch("sendMessage", {
              chat_id: msg.chatId,
              text: [
                `Gateway: ${gwH}h uptime, ${memMB}MB RAM`,
                `Session: ${alive ? `active ${sessMin}min` : "dead"} [${state.currentSessionId?.slice(0, 8) ?? "-"}]`,
                `Idle: ${idleStr} | Tool: ${tool}`,
                `Failures: ${state.consecutiveFailures} | Model: opus-1m high`,
              ].join("\n"),
            }).catch(() => {});
            continue;
          }

          // /health is a comprehensive telemetry report — works even without a live session
          if (cmd === "health") {
            const alive = isSessionAlive(state);
            const gwUptime = Math.round((Date.now() - gatewayStartTime) / 1000);
            const gwH = Math.floor(gwUptime / 3600);
            const gwM = Math.floor((gwUptime % 3600) / 60);
            const sessMin = alive ? Math.round((Date.now() - state.lastStartTime) / 60_000) : 0;
            const idleMs = state.lastActivityTime > 0 ? Date.now() - state.lastActivityTime : 0;
            const idleStr = idleMs < 60_000 ? `${Math.round(idleMs / 1000)}s` : `${Math.round(idleMs / 60_000)}min`;
            const tool = state.activeToolUseId ? state.activeToolUseId.slice(0, 16) : "none";
            const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

            // State flags
            const compactFlag = getState("compact_failed") === "true" ? "⚠️ TRUE" : "✅ false";
            const lastCompactTs = getState("last_compact_ts") ?? "never";
            const sessionId = state.currentSessionId?.slice(0, 12) ?? "none";

            // DB + WAL sizes
            const dbSize = (() => { try { return Math.round(statSync(DB_FILE).size / 1024); } catch { return 0; } })();
            const walSize = (() => { try { return Math.round(statSync(DB_FILE + "-wal").size / 1024); } catch { return 0; } })();

            // Last message processed
            const lastMsg = (() => {
              try {
                const row = db.query("SELECT ts, role, content FROM messages ORDER BY id DESC LIMIT 1").get() as any;
                if (row) return `[${row.ts}] ${row.role}: ${(row.content || "").slice(0, 60)}`;
              } catch {}
              return "none";
            })();

            // Message count
            const msgCount = (() => {
              try {
                const row = db.query("SELECT COUNT(*) as c FROM messages").get() as any;
                return row?.c ?? 0;
              } catch { return 0; }
            })();

            // PID lock
            const pidFile = join(STATE_DIR, "gateway.pid");
            const pidStatus = (() => {
              try {
                if (existsSync(pidFile)) {
                  const pid = readFileSync(pidFile, "utf-8").trim();
                  return `${pid} (${pid === String(process.pid) ? "self" : "OTHER!"})`;
                }
                return "none";
              } catch { return "error"; }
            })();

            tgFetch("sendMessage", {
              chat_id: msg.chatId,
              text: [
                `📊 HEALTH REPORT`,
                ``,
                `🔧 Gateway`,
                `  PID: ${process.pid} | Lock: ${pidStatus}`,
                `  Uptime: ${gwH}h${gwM}m | RAM: ${memMB}MB (heap ${heapMB}MB)`,
                ``,
                `🧠 Session`,
                `  Status: ${alive ? "✅ ALIVE" : "❌ DEAD"} [${sessionId}]`,
                `  Uptime: ${sessMin}min | Idle: ${idleStr}`,
                `  Tool: ${tool}`,
                `  Failures: ${state.consecutiveFailures} | Backoff: ${state.backoffMs}ms`,
                ``,
                `💾 Database`,
                `  Size: ${dbSize}KB | WAL: ${walSize}KB`,
                `  Messages: ${msgCount}`,
                `  Last: ${lastMsg}`,
                ``,
                `🚩 Flags`,
                `  compact_failed: ${compactFlag}`,
                `  last_compact: ${lastCompactTs}`,
                `  resumeFailed: ${state.resumeFailed}`,
                `  watchdog: ${state.watchdogRunning ? "RUNNING" : "idle"}`,
                `  contextMode: ${state.nextContextMode}`,
              ].join("\n"),
            }).catch(() => {});
            continue;
          }

          // Interactive TUI commands that cannot work over Telegram (require terminal input)
          const interactiveOnlyCommands = new Set(["config", "permissions", "terminal-setup", "vim", "voice"]);
          if (interactiveOnlyCommands.has(cmd)) {
            await tgFetch("sendMessage", {
              chat_id: msg.chatId,
              text: `⚠️ /${cmd} requires an interactive terminal and can't run from Telegram.`,
            }).catch(() => {});
            continue;
          }

          // Route to CLI if command is available
          if (state.availableCommands.has(cmd) || (state.availableCommands.size === 0 && !isSessionAlive(state))) {
            if (isSessionAlive(state)) {
              // Session alive — route directly
              console.log(`[gateway] Routing /${cmd} to CLI session`);
              const slashMsg = JSON.stringify({
                type: "user",
                message: { role: "user", content: trimmed },
              });
              state.proc!.stdin?.write(slashMsg + "\n");
              tgFetch("sendMessage", { chat_id: msg.chatId, text: `⚡ /${cmd}` }).catch(() => {});
            } else {
              // Session not alive — queue as pending command to route after spawn
              pendingSlashCommands.push(trimmed);
              tgFetch("sendMessage", { chat_id: msg.chatId, text: `⚡ /${cmd} (starting session...)` }).catch(() => {});
            }
            continue;
          }
        }

        // Regular message (or unrecognized command)
        messages.push(msg);
      }

      // If we have pending slash commands but no session, spawn one
      if (pendingSlashCommands.length > 0 && !isSessionAlive(state) && messages.length === 0) {
        messages.push({
          chatId: allMessages[0]?.chatId ?? "",
          username: allMessages[0]?.username ?? "",
          text: "(session init)",
          ts: new Date().toISOString(),
        });
      }

      if (messages.length > 0) {
        // Send typing indicator
        const lastMsg = messages[messages.length - 1];
        await tgFetch("sendChatAction", {
          chat_id: lastMsg.chatId,
          action: "typing",
        });

        if (isSessionAlive(state)) {
          // Session alive — send messages via stdin
          console.log(`[gateway] Sending ${messages.length} message(s) to active session`);
          sendToSession(state.proc!, messages);
        } else {
          // No session — check backoff
          if (state.consecutiveFailures >= BACKOFF.maxFailures) {
            console.error(`[gateway] ${BACKOFF.maxFailures} consecutive failures, exiting`);
            process.exit(1);
          }

          if (state.backoffMs > BACKOFF.initial && state.lastStartTime > 0) {
            const elapsed = Date.now() - state.lastStartTime;
            if (elapsed < state.backoffMs) {
              console.log(`[gateway] Backoff: waiting ${state.backoffMs - elapsed}ms`);
              await new Promise((r) => setTimeout(r, state.backoffMs - elapsed));
            }
          }

          // Spawn persistent session.
          // state.resumeFailed=true forces fresh start (new session, no --resume).
          // state.nextContextMode controls how much context to inject (set by watchdog or exit handler).
          console.log("[gateway] Spawning persistent Claude session...");
          state.hitRateLimit = false;
          state.lastStartTime = Date.now();
          state.lastActivityTime = Date.now();

          const proc = spawnPersistentSession(state.resumeFailed, state.nextContextMode);
          state.resumeFailed = false;
          state.nextContextMode = "full";
          state.proc = proc;

          setupStreamParser(proc, state);
          setupExitHandler(proc, state);

          // Wait a moment for init before sending
          await new Promise((r) => setTimeout(r, 2_000));

          // Inject failure context from watchdog. This goes via STDIN as a user message
          // (not --append-system-prompt) so Claude actively responds to it and informs the user.
          if (state.lastFailureContext) {
            const contextMsg = JSON.stringify({
              type: "user",
              message: { role: "user", content: state.lastFailureContext },
            });
            proc.stdin?.write(contextMsg + "\n");
            console.log("[gateway] Injected watchdog failure context into new session");
            state.lastFailureContext = null;
            await new Promise((r) => setTimeout(r, 1_000));
          }

          sendToSession(proc, messages);

          // Route any pending slash commands now that session is alive
          for (const cmd of pendingSlashCommands) {
            console.log(`[gateway] Routing deferred /${cmd.split(/\s+/)[0].slice(1)} to new session`);
            const slashMsg = JSON.stringify({
              type: "user",
              message: { role: "user", content: cmd },
            });
            proc.stdin?.write(slashMsg + "\n");
          }
        }
      }
    } catch (err) {
      console.error(`[gateway] Error: ${err}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  // Graceful shutdown: SIGTERM first, wait 5s, then SIGKILL if still alive.
  // db.close() runs after to ensure WAL is checkpointed.
  if (state.proc && state.proc.exitCode === null) {
    console.log("[gateway] Sending SIGTERM to Claude process...");
    state.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 5_000));
    if (state.proc && state.proc.exitCode === null) {
      state.proc.kill("SIGKILL");
    }
  }

  db.close();
  console.log("[gateway] Goodbye.");
}

run();
