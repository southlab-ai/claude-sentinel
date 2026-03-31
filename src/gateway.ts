import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

// --- Config ---
const STATE_DIR = join(process.env.HOME!, ".claude/channels/telegram");
const ENV_FILE = join(STATE_DIR, ".env");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const DB_FILE = join(STATE_DIR, "history.db");
const COMPACT_FILE = join(STATE_DIR, "session-compact.md");
const IDENTITY_FILE = join(STATE_DIR, "identity.md");

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
const BACKOFF = {
  initial: 5_000,
  max: 300_000,
  multiplier: 2,
  healthReset: 600_000,  // 10 min of uptime = healthy
  maxFailures: 10,
  rateLimitMin: 60_000,
};

// --- OpenAI STT (gpt-4o-mini-transcribe) ---
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
const db = new Database(DB_FILE);
db.run("PRAGMA journal_mode=WAL");
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
function buildContext(): string {
  const parts: string[] = [];

  if (existsSync(IDENTITY_FILE)) {
    try {
      const identity = readFileSync(IDENTITY_FILE, "utf-8").trim();
      if (identity) parts.push(identity);
    } catch {}
  }

  if (existsSync(COMPACT_FILE)) {
    try {
      const compact = readFileSync(COMPACT_FILE, "utf-8").trim();
      if (compact) parts.push(`Previous sessions summary:\n${compact}`);
    } catch {}
  }

  const messages = getLastMessages(20).reverse();
  if (messages.length > 0) {
    const formatted = messages
      .map((m) => {
        const time = m.ts;
        const who = m.role === "user" ? `@${m.username ?? "user"}` : "Bot";
        return `[${time}] ${who}: ${m.content}`;
      })
      .join("\n");
    parts.push(`Recent Telegram messages:\n${formatted}`);
  }

  return parts.join("\n\n");
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
function spawnPersistentSession(fresh = false): ChildProcess {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--channels", "plugin:telegram@claude-plugins-official",
    "--dangerously-skip-permissions",
    "--fallback-model", "claude-opus-4-6",
  ];

  const sessionId = getState("session_id");
  if (sessionId && !fresh) {
    args.push("--resume", sessionId);
  }

  // Always inject context (identity + compact + last 20 msgs)
  const context = buildContext();
  if (context) {
    args.push("--append-system-prompt", context);
  }

  const mode = fresh ? "fresh (no resume)" : sessionId ? `resume ${sessionId.slice(0, 8)}` : "new";
  console.log(`[gateway] Spawning session: ${mode}`);

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
    cwd: process.env.HOME,
    env: {
      ...process.env,
      HOME: process.env.HOME,
      PATH: `/usr/local/bin:/home/claude/.local/bin:${process.env.PATH}`,
    },
  });

  return proc;
}

// --- Typing indicator ---
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
  // Capture session_id from init or result events
  if (event.session_id && event.type === "system" && event.subtype === "init") {
    setState("session_id", event.session_id);
    console.log(`[gateway] Session initialized: ${event.session_id.slice(0, 8)}... model=${event.model}`);
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

  // Capture reply tool calls for history DB + stop typing
  if (event.type === "assistant") {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
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

  // Also stop typing on result (turn complete)
  if (event.type === "result") {
    stopTyping();
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
}

// --- Telegram polling ---
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

    let text = msg.text ?? msg.caption ?? "";
    let attachment: TelegramMessage["attachment"] = undefined;

    if (msg.voice) {
      attachment = { kind: "voice", file_id: msg.voice.file_id, mime: msg.voice.mime_type, size: msg.voice.file_size };
      const transcript = await transcribeAudio(msg.voice.file_id);
      if (transcript) {
        text = `[Audio transcribed]: ${transcript}`;
      } else if (!text) {
        text = "(voice message)";
      }
    } else if (msg.audio) {
      attachment = { kind: "audio", file_id: msg.audio.file_id, mime: msg.audio.mime_type, size: msg.audio.file_size };
      const transcript = await transcribeAudio(msg.audio.file_id);
      if (transcript) {
        text = `[Audio transcribed]: ${transcript}`;
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

    const senderId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const username = msg.from.username ?? senderId;

    // Always save to history
    saveMessage(chatId, "user", username, text);

    // Check access
    if (!allowList.includes(senderId)) {
      console.log(`[gateway] Ignored message from ${senderId} (not in allowlist)`);
      continue;
    }

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

// --- Main supervisor loop ---
let running = true;

process.on("SIGINT", () => {
  running = false;
  console.log("[gateway] Shutting down...");
});
process.on("SIGTERM", () => {
  running = false;
  console.log("[gateway] Shutting down...");
});

function isSessionAlive(state: SupervisorState): boolean {
  return state.proc !== null && !state.proc.killed && state.proc.exitCode === null;
}

function setupExitHandler(proc: ChildProcess, state: SupervisorState) {
  proc.on("exit", (code) => {
    const uptime = Date.now() - state.lastStartTime;
    console.log(`[gateway] Session exited code=${code} uptime=${Math.round(uptime / 1000)}s`);

    // On error: next spawn tries fresh (no --resume) but keeps context
    if (code !== 0) {
      state.resumeFailed = true;
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
    console.error(`[gateway] Failed to spawn Claude: ${err.message}`);
    state.proc = null;
  });
}

async function run() {
  console.log("[gateway] Telegram Gateway started (persistent mode). Waiting for messages...");

  const state: SupervisorState = {
    proc: null,
    backoffMs: BACKOFF.initial,
    consecutiveFailures: 0,
    lastStartTime: 0,
    hitRateLimit: false,
    resumeFailed: false,
  };

  while (running) {
    // If another session (e.g. Desktop) is running with channels, defer to it
    if (!isSessionAlive(state) && isClaudeChannelRunning()) {
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }

    // Always poll Telegram for new messages
    try {
      const messages = await pollTelegram();

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

          // Spawn persistent session
          console.log("[gateway] Spawning persistent Claude session...");
          state.hitRateLimit = false;
          state.lastStartTime = Date.now();

          const proc = spawnPersistentSession(state.resumeFailed);
          state.resumeFailed = false;
          state.proc = proc;

          setupStreamParser(proc, state);
          setupExitHandler(proc, state);

          // Wait a moment for init before sending
          await new Promise((r) => setTimeout(r, 2_000));

          sendToSession(proc, messages);
        }
      }
    } catch (err) {
      console.error(`[gateway] Error: ${err}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  // Graceful shutdown: kill child process
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
