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
  const prompt = `Eres un sistema de consolidación de memoria. Tienes dos trabajos:

1. COMPACT: Crear un resumen conciso de las conversaciones para dar contexto a futuras sesiones.
2. MEMORIA PERMANENTE: Identificar información valiosa que debe guardarse como memoria permanente de Claude.

${previousCompact ? `[Compact anterior]\n${previousCompact}` : "[Primera consolidación - no hay compact anterior]"}

[Mensajes nuevos desde última consolidación]
${formatted}

${existingMemories ? `[Memorias permanentes ya guardadas]\n${existingMemories}` : "[No hay memorias permanentes aún]"}

---

PARTE 1 — COMPACT (máximo 800 palabras):
- Preserve decisiones y acuerdos importantes
- Mantenga contexto de proyectos/tareas en curso
- Descarte detalles efímeros ya resueltos
- Integre el compact anterior con la información nueva

PARTE 2 — MEMORIAS PERMANENTES:
Analiza las conversaciones y decide si hay información que merece guardarse permanentemente. Los tipos son:

- **user**: Información sobre el usuario (rol, preferencias, conocimientos, cómo le gusta trabajar)
- **feedback**: Correcciones o validaciones del usuario sobre cómo trabajar ("no hagas X", "así está bien")
- **project**: Decisiones arquitectónicas, contexto de proyectos, infraestructura, configuraciones importantes
- **reference**: Referencias a recursos externos (URLs, servicios, herramientas que usa)

Criterios para guardar:
- ¿Es información que sería útil en conversaciones futuras sin contexto previo?
- ¿Es una decisión o preferencia que no cambiará pronto?
- ¿Es algo que no se puede derivar del código o git history?
- ¿Ya está guardado? (revisa las memorias existentes para no duplicar)

NO guardes:
- Detalles de debugging que ya se resolvieron
- Conversaciones casuales sin valor futuro
- Información que ya está en las memorias existentes

Si hay algo que guardar, agrégalo al final así:
MEMORIES_JSON
[{"type": "user|feedback|project|reference", "name": "nombre_archivo_sin_espacios", "description": "descripción corta en una línea", "content": "contenido detallado de la memoria"}]
END_MEMORIES_JSON

Si no hay nada nuevo que merezca memoria permanente, no incluyas el bloque JSON.`;

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
