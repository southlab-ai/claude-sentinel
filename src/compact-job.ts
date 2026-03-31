import { Database } from "bun:sqlite";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// --- Config ---
const STATE_DIR = join(process.env.HOME!, ".claude/channels/telegram");
const DB_FILE = join(STATE_DIR, "history.db");
const COMPACT_FILE = join(STATE_DIR, "session-compact.md");
const MEMORY_DIR = join(
  process.env.HOME!,
  ".claude/projects/-home-claude/memory"
);

// --- SQLite ---
const db = new Database(DB_FILE, { readonly: true });

interface MessageRow {
  role: string;
  username: string | null;
  content: string;
  ts: string;
}

interface StateRow {
  value: string;
}

function getState(key: string): string | null {
  const row = db
    .query("SELECT value FROM state WHERE key = ?")
    .get(key) as StateRow | null;
  return row?.value ?? null;
}

// We need write access for state updates
const dbWrite = new Database(DB_FILE);

function setState(key: string, value: string) {
  dbWrite.run(
    "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    key,
    value
  );
}

// --- Load messages since last compact ---
function getMessagesSinceLastCompact(): MessageRow[] {
  const lastCompact = getState("last_compact_ts");
  if (lastCompact) {
    return db
      .query(
        "SELECT role, username, content, ts FROM messages WHERE ts > ? ORDER BY id ASC"
      )
      .all(lastCompact) as MessageRow[];
  }
  return db
    .query("SELECT role, username, content, ts FROM messages ORDER BY id ASC")
    .all() as MessageRow[];
}

// --- Main ---
function main() {
  const messages = getMessagesSinceLastCompact();

  if (messages.length === 0) {
    console.log("[compact] No new messages since last compact. Skipping.");
    process.exit(0);
  }

  console.log(`[compact] Processing ${messages.length} messages...`);

  // Load previous compact
  let previousCompact = "";
  if (existsSync(COMPACT_FILE)) {
    previousCompact = readFileSync(COMPACT_FILE, "utf-8").trim();
  }

  // Format messages
  const formatted = messages
    .map((m) => {
      const who = m.role === "user" ? `@${m.username ?? "user"}` : "Bot";
      return `[${m.ts}] ${who}: ${m.content}`;
    })
    .join("\n");

  // Load existing memories to avoid duplicates
  let existingMemories = "";
  const memoryIndexFile = join(MEMORY_DIR, "MEMORY.md");
  if (existsSync(memoryIndexFile)) {
    existingMemories = readFileSync(memoryIndexFile, "utf-8").trim();
  }

  // Build prompt
  const prompt = `You are a memory consolidation system. You have two jobs:

1. COMPACT: Create a concise summary of conversations to provide context for future sessions.
2. PERMANENT MEMORY: Identify valuable information to save as permanent Claude memory.

${previousCompact ? `[Previous compact]\n${previousCompact}` : "[First consolidation - no previous compact]"}

[New messages since last consolidation]
${formatted}

${existingMemories ? `[Already saved permanent memories]\n${existingMemories}` : "[No permanent memories yet]"}

---

PART 1 -- COMPACT (max 800 words):
- Preserve important decisions and agreements
- Keep context of ongoing projects/tasks
- Discard ephemeral details already resolved
- Integrate previous compact with new information

PART 2 -- PERMANENT MEMORIES:
Analyze conversations and decide if information deserves permanent storage. Types:

- **user**: Info about the user (role, preferences, knowledge, work style)
- **feedback**: User corrections or validations on how to work ("don't do X", "this is good")
- **project**: Architectural decisions, project context, infrastructure, important configs
- **reference**: References to external resources (URLs, services, tools in use)

Criteria:
- Would this be useful in future conversations without prior context?
- Is this a decision/preference that won't change soon?
- Can it NOT be derived from code or git history?
- Is it already saved? (check existing memories to avoid duplicates)

DO NOT save:
- Debugging details already resolved
- Casual conversations with no future value
- Information already in existing memories

If there's something to save, add at the end:
MEMORIES_JSON
[{"type": "user|feedback|project|reference", "name": "filename_no_spaces", "description": "short one-line description", "content": "detailed memory content"}]
END_MEMORIES_JSON

If nothing new deserves permanent memory, don't include the JSON block.`;

  // Run claude -p
  const result = spawnSync(
    "claude",
    ["-p", "--dangerously-skip-permissions", "--output-format", "text"],
    {
      input: prompt,
      encoding: "utf-8",
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/home/claude/.local/bin:${process.env.PATH}`,
      },
      cwd: process.env.HOME,
    }
  );

  if (result.status !== 0) {
    console.error(`[compact] Claude failed: ${result.stderr}`);
    process.exit(1);
  }

  const output = result.stdout.trim();

  // Extract compact (everything before MEMORIES_JSON block)
  let compact = output;
  let memoriesJson: any[] = [];

  const memStart = output.indexOf("MEMORIES_JSON");
  const memEnd = output.indexOf("END_MEMORIES_JSON");

  if (memStart !== -1 && memEnd !== -1) {
    compact = output.slice(0, memStart).trim();
    try {
      const jsonStr = output.slice(memStart + "MEMORIES_JSON".length, memEnd).trim();
      memoriesJson = JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[compact] Failed to parse memories JSON: ${err}`);
    }
  }

  // Save compact
  writeFileSync(COMPACT_FILE, compact);
  console.log(`[compact] Saved compact (${compact.length} chars)`);

  // Save memories if any
  if (memoriesJson.length > 0) {
    mkdirSync(MEMORY_DIR, { recursive: true });

    const memoryIndexFile = join(MEMORY_DIR, "MEMORY.md");
    let memoryIndex = "";
    if (existsSync(memoryIndexFile)) {
      memoryIndex = readFileSync(memoryIndexFile, "utf-8");
    }

    for (const mem of memoriesJson) {
      const filename = `${mem.name}.md`;
      const filepath = join(MEMORY_DIR, filename);

      const fileContent = `---
name: ${mem.name}
description: ${mem.description}
type: ${mem.type}
---

${mem.content}
`;
      writeFileSync(filepath, fileContent);
      console.log(`[compact] Saved memory: ${filename}`);

      // Add to index if not already there
      if (!memoryIndex.includes(filename)) {
        memoryIndex += `- [${mem.name}](${filename}) — ${mem.description}\n`;
      }
    }

    writeFileSync(memoryIndexFile, memoryIndex);
  }

  // Update last compact timestamp
  const lastTs = messages[messages.length - 1].ts;
  setState("last_compact_ts", lastTs);

  // Flush: keep only last 20 messages, delete the rest
  const keepFrom = dbWrite
    .query("SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET 19")
    .get() as { id: number } | null;
  if (keepFrom) {
    const deleted = dbWrite.run("DELETE FROM messages WHERE id < ?", keepFrom.id);
    console.log(`[compact] Flushed ${deleted.changes} old messages, kept last 20`);
  }

  console.log(`[compact] Done. Covered messages up to ${lastTs}`);

  db.close();
  dbWrite.close();
}

main();
