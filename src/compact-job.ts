// =============================================================================
// COMPACT JOB — Session memory consolidation and autonomous improvement system
// =============================================================================
//
// Triggered by:
//   1. Gateway's exit handler after each Claude session ends (synchronous, inline)
//   2. Cron: daily at 9AM UTC via systemd timer (telegram-compact.timer)
//   3. Watchdog KILL_FRESH decision (before starting a new session)
//
// What it does:
//   1. Reads new messages since last compact from history.db
//   2. Spawns claude -p with a structured prompt requesting multiple output blocks
//   3. Parses the response into: COMPACT summary, MEMORIES_JSON, SENTIMENT_ENTRY,
//      IMPROVEMENT_ACTIONS, and DREAM_ACTIONS (memory pruning, runs every 24h)
//   4. Writes session-compact.md (loaded by gateway's buildContext on next spawn)
//   5. Creates/updates memory files in ~/.claude/projects/-home-claude/memory/
//   6. Executes improvement actions (protocols only — hooks blocked for security)
//   7. Absorbs expired compacts (>3 days) into compact_acum.md (long-term memory)
//   8. Cleans old messages from history.db (>3 day retention)
//
// Incident history (13-abr-2026):
//   - When this job fails, it sets compact_failed=true in SQLite
//   - The gateway used to load 9999 messages as fallback → E2BIG crash loop
//   - Fix: gateway caps at 100 msgs + 80KB byte limit
//   - Fix: notifyCompactFailure() sends Telegram alert on failure
//
// Security hardening (13-abr-2026 audit):
//   - Path traversal protection via safePath() on all LLM-generated file paths
//   - Hook writing BLOCKED (action.type === "hook") — LLM could inject RCE via settings.json
//   - includes() collision fixed with exact markdown link matching: `](filename)`
//   - PRAGMA busy_timeout=5000 prevents SQLITE_BUSY during concurrent gateway access
// =============================================================================

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

// --- Config ---
const STATE_DIR = join(process.env.HOME!, ".claude/channels/telegram");
const DB_FILE = join(STATE_DIR, "history.db");
const COMPACT_ACUM_FILE = join(STATE_DIR, "compact_acum.md");
const SESSION_LOGS_DIR = join(STATE_DIR, "session_logs");
const MEMORY_DIR = join(
  process.env.HOME!,
  ".claude/projects/-home-claude/memory"
);
const RETENTION_DAYS = 3;
const NOTE_FILE = join(STATE_DIR, "note_for_next_session.md");
const SENTIMENT_LOG_FILE = join(STATE_DIR, "sentiment_evolution.md");
const IMPROVEMENT_LOG_FILE = join(STATE_DIR, "continuous_improvement.md");
const PROTOCOLS_DIR = join(STATE_DIR, "protocols");
const SETTINGS_FILE = join(process.env.HOME!, ".claude/settings.json");
const LAST_PRUNE_TS_KEY = "last_prune_ts";
const PRUNE_INTERVAL_HOURS = 24;
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25_000;
const CLAUDE_TIMEOUT = 300_000; // 5 minutes

// --- SQLite ---
// Two separate handles: `db` (readonly) for SELECTs, `dbWrite` for mutations.
// This prevents accidental writes through the read path and makes concurrency explicit.
// The gateway process may INSERT messages while this job runs — WAL mode + busy_timeout
// ensure both can operate without SQLITE_BUSY failures.
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

// Write handle — used for setState() and DELETE FROM messages.
// busy_timeout=5000: wait up to 5s for a lock instead of failing immediately.
// This prevents silent data loss when the gateway is actively inserting messages
// at the same time this job runs (Issue #3 from 13-abr-2026 audit).
const dbWrite = new Database(DB_FILE);
dbWrite.run("PRAGMA busy_timeout = 5000");

function setState(key: string, value: string) {
  dbWrite.run(
    "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
    key,
    value
  );
}

// --- Telegram notification for critical failures ---
// Added post-incident (13-abr-2026): when compact fails, the user must know immediately
// because compact_failed=true degrades the gateway's context quality.
// Sends directly via Telegram Bot API (no session dependency — the session may be dead).
// AbortSignal.timeout(10s) prevents this fetch from hanging and blocking process.exit().
// Reads last_chat_id from SQLite (set by gateway on every authorized message).
const ENV_FILE = join(STATE_DIR, ".env");
const TG_TOKEN = (() => {
  try {
    return readFileSync(ENV_FILE, "utf-8").match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim();
  } catch { return null; }
})();

async function notifyCompactFailure(reason: string) {
  if (!TG_TOKEN) return;
  const chatId = getState("last_chat_id");
  if (!chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⚠️ COMPACT JOB FAILED\n\n${reason}\n\ncompact_failed=true — next session will load 100 msgs as fallback. Run /check to verify gateway health.`,
      }),
      signal: AbortSignal.timeout(10_000), // 10s timeout to prevent hanging before process.exit
    });
  } catch (e) {
    console.error("[compact] Failed to send Telegram notification:", e);
  }
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

// --- Individual compact management ---
function getIndividualCompacts(): { filename: string; content: string; date: Date }[] {
  if (!existsSync(SESSION_LOGS_DIR)) return [];

  return readdirSync(SESSION_LOGS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})h(\d{2})/);
      const date = dateMatch
        ? new Date(`${dateMatch[1]}T${dateMatch[2]}:${dateMatch[3]}:00Z`)
        : new Date(0);
      return {
        filename: f,
        content: readFileSync(join(SESSION_LOGS_DIR, f), "utf-8").trim(),
        date,
      };
    });
}

function getMemoryFileSummaries(): string {
  if (!existsSync(MEMORY_DIR)) return "";
  const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md");
  const summaries: string[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(MEMORY_DIR, f), "utf-8");
      const parts = raw.split("---");
      const frontmatter = parts.length >= 3 ? parts[1].trim() : "";
      const body = parts.length >= 3 ? parts.slice(2).join("---").trim() : raw.trim();
      const preview = body.split("\n").slice(0, 3).join("\n");
      summaries.push(`[${f}]\nFrontmatter: ${frontmatter}\nPreview: ${preview}`);
    } catch {}
  }
  return summaries.join("\n\n");
}

function shouldRunPrune(): boolean {
  const lastPrune = getState(LAST_PRUNE_TS_KEY);
  if (!lastPrune) return true;
  const elapsed = Date.now() - new Date(lastPrune).getTime();
  return elapsed >= PRUNE_INTERVAL_HOURS * 60 * 60 * 1000;
}

// --- Load existing protocols ---
function getProtocols(): string {
  if (!existsSync(PROTOCOLS_DIR)) return "";
  const files = readdirSync(PROTOCOLS_DIR).filter(f => f.endsWith(".md")).sort();
  if (files.length === 0) return "";
  return files.map(f => {
    const content = readFileSync(join(PROTOCOLS_DIR, f), "utf-8").trim();
    return `[${f}]\n${content}`;
  }).join("\n\n");
}

// --- Load improvement log (last N entries) ---
function getImprovementLog(maxEntries = 10): string {
  if (!existsSync(IMPROVEMENT_LOG_FILE)) return "";
  const raw = readFileSync(IMPROVEMENT_LOG_FILE, "utf-8").trim();
  const entries = raw.split("\n## ").filter(e => e.trim());
  if (entries.length <= maxEntries) return raw;
  return entries.slice(-maxEntries).map((e, i) => i === 0 ? e : `## ${e}`).join("\n");
}

// --- Load current hooks summary ---
function getCurrentHooksSummary(): string {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    const hooks = settings.hooks?.PreToolUse || [];
    return hooks.map((h: any) => `- ${h.matcher}: ${h.hooks?.[0]?.statusMessage || "no description"}`).join("\n");
  } catch { return ""; }
}

// Long-term memory consolidation: individual session compacts older than RETENTION_DAYS
// are merged into a single compact_acum.md via Claude. This prevents session_logs/ from
// growing unbounded while preserving important historical context.
// On failure: logs error + sends Telegram notification (added post-audit).
// The expired files are NOT deleted on failure — prevents data loss. They'll be retried
// next cycle. If consolidation keeps failing, session_logs/ grows but nothing is lost.
function absorbExpiredCompacts() {
  const compacts = getIndividualCompacts();
  if (compacts.length === 0) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const expired = compacts.filter((c) => c.date < cutoff);
  if (expired.length === 0) return;

  console.log(`[compact] ${expired.length} individual compact(s) older than ${RETENTION_DAYS} days — absorbing into acum...`);

  let acum = "";
  if (existsSync(COMPACT_ACUM_FILE)) {
    acum = readFileSync(COMPACT_ACUM_FILE, "utf-8").trim();
  }

  const expiredFormatted = expired
    .map((c) => `--- ${c.filename} ---\n${c.content}`)
    .join("\n\n");

  const consolidationPrompt = `Eres un sistema de consolidación de memoria a largo plazo.

Tu trabajo: integrar compacts individuales antiguos en el compact acumulado, creando UN solo resumen coherente que preserve toda la información importante.

${acum ? `[Compact acumulado actual]\n${acum}` : "[No hay compact acumulado aún — este será el primero]"}

[Compacts individuales a absorber (ya tienen más de ${RETENTION_DAYS} días)]
${expiredFormatted}

---

INSTRUCCIONES:
- Genera UN solo compact acumulado que integre todo
- Preserve decisiones, acuerdos, contexto de proyectos, y patrones importantes
- Comprime detalles efímeros pero mantén la esencia
- Use fechas absolutas (nunca "ayer" o "hace días")
- Máximo 1200 palabras
- NO incluyas headers como "Compact acumulado" — solo el contenido`;

  const result = spawnSync(
    "claude",
    ["-p", "--dangerously-skip-permissions", "--output-format", "text", "--model", "opus", "--effort", "max"],
    {
      input: consolidationPrompt,
      encoding: "utf-8",
      timeout: CLAUDE_TIMEOUT,
      env: {
        ...process.env,
        PATH: `/usr/local/bin:/home/claude/.local/bin:/home/claude/.bun/bin:${process.env.PATH}`,
      },
      cwd: process.env.HOME,
    }
  );

  if (result.status !== 0) {
    const errMsg = `Consolidation failed: status=${result.status} signal=${result.signal} stderr=${result.stderr?.slice(0, 200)}`;
    console.error(`[compact] ${errMsg}`);
    notifyCompactFailure(`absorbExpiredCompacts: ${errMsg}`).catch(() => {});
    return;
  }

  const newAcum = result.stdout.trim();
  writeFileSync(COMPACT_ACUM_FILE, newAcum);
  console.log(`[compact] Saved new compact_acum (${newAcum.length} chars)`);

  for (const c of expired) {
    unlinkSync(join(SESSION_LOGS_DIR, c.filename));
    console.log(`[compact] Absorbed and deleted: ${c.filename}`);
  }
}

// --- Run claude -p with retry ---
// Spawns Claude CLI synchronously with the compact prompt. Retries once on failure.
// async because the failure path needs await for notifyCompactFailure() fetch.
// On failure: sets compact_failed=true (gateway loads 100 msgs as fallback instead of 30),
// sends Telegram notification, then exits with code 1.
// On success: clears compact_failed flag so gateway resumes normal 30-msg context.
// The prompt is passed via stdin (not argv) to avoid E2BIG — compact prompts can be large.
async function runClaudeWithRetry(prompt: string): Promise<string> {
  function attempt(n: number): ReturnType<typeof spawnSync> {
    console.log(`[compact] Running claude -p (attempt ${n}, timeout ${CLAUDE_TIMEOUT / 1000}s)...`);
    const r = spawnSync(
      "claude",
      ["-p", "--dangerously-skip-permissions", "--output-format", "text", "--model", "opus", "--effort", "max"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: CLAUDE_TIMEOUT,
        env: {
          ...process.env,
          PATH: `/usr/local/bin:/home/claude/.local/bin:/home/claude/.bun/bin:${process.env.PATH}`,
        },
        cwd: process.env.HOME,
      }
    );
    if (r.status !== 0 && r.status !== null) {
      console.error(`[compact] Claude failed (attempt ${n}): status=${r.status} signal=${r.signal} error=${r.error} stderr=${r.stderr?.slice(0, 300)}`);
    } else if (r.status === null) {
      console.error(`[compact] Claude killed (attempt ${n}): signal=${r.signal} error=${r.error}`);
    }
    return r;
  }

  let result = attempt(1);
  if (result.status !== 0) {
    console.log("[compact] Retrying in 5s...");
    spawnSync("sleep", ["5"]);
    result = attempt(2);
  }

  if (result.status !== 0) {
    const errSnippet = (result.stderr || result.stdout || "unknown error").slice(0, 200);
    console.error("[compact] Claude failed after 2 attempts. Setting fallback flag.");
    setState("compact_failed", "true");
    await notifyCompactFailure(`Claude failed after 2 attempts.\nError: ${errSnippet}`);
    process.exit(1);
  }

  setState("compact_failed", "false");
  return result.stdout.trim();
}

// --- Execute improvement actions ---
// The compact LLM can propose behavioral improvements via structured JSON.
// Two types are processed:
//   - "protocol": Creates .md files in protocols/ dir. These are soft behavioral guides
//     loaded into the system prompt by gateway's buildContext(). Safe — just text files.
//   - "hook": BLOCKED (security). Would write executable shell commands to settings.json
//     that run on EVERY tool call. An LLM hallucination could inject arbitrary code (RCE).
//     (Issue #7 from 13-abr-2026 audit: LLM auto-installing hooks = persistent RCE)
//   - "evaluate"/"observe": Read-only logging, no side effects.
// Protocol file paths are protected by resolve()+startsWith() against path traversal.
function executeImprovementActions(actions: any[]): string[] {
  const results: string[] = [];

  for (const action of actions) {
    try {
      if (action.type === "protocol") {
        mkdirSync(PROTOCOLS_DIR, { recursive: true });
        const filename = action.filename || `${action.id}.md`;
        const filepath = resolve(join(PROTOCOLS_DIR, filename));
        // Path traversal protection
        if (!filepath.startsWith(resolve(PROTOCOLS_DIR) + "/")) {
          console.error(`[improvement] BLOCKED path traversal in protocol: ${filename} → ${filepath}`);
          results.push(`[${action.id}] PROTOCOL BLOCKED: path traversal detected`);
          continue;
        }
        writeFileSync(filepath, action.content);
        results.push(`[${action.id}] PROTOCOL created: ${filename}`);
        console.log(`[improvement] Created protocol: ${filename}`);

      } else if (action.type === "hook") {
        // BLOCKED: Hook writing disabled for security (RCE risk via LLM-generated commands)
        // The subconscious can only create protocols (soft behavioral guides as .md files).
        // Hook modifications require manual implementation by Jorge.
        console.log(`[improvement] BLOCKED hook action "${action.id}" for matcher "${action.matcher}" — hooks cannot be auto-created (security)`);
        results.push(`[${action.id}] HOOK BLOCKED: security policy prevents auto-creation of executable hooks. Use protocol type instead.`);

      } else if (action.type === "evaluate") {
        results.push(`[${action.evaluates}] EVALUATED: ${action.result} — ${action.reason}`);
        console.log(`[improvement] Evaluated ${action.evaluates}: ${action.result}`);

      } else if (action.type === "observe") {
        results.push(`[${action.id}] OBSERVED: ${action.observation}`);
        console.log(`[improvement] Observation: ${action.observation}`);
      }
    } catch (err) {
      console.error(`[improvement] Failed action ${action.id}: ${err}`);
      results.push(`[${action.id}] FAILED: ${err}`);
    }
  }

  return results;
}

// --- Append to improvement log ---
function appendImprovementLog(entry: string) {
  const existing = existsSync(IMPROVEMENT_LOG_FILE)
    ? readFileSync(IMPROVEMENT_LOG_FILE, "utf-8")
    : "# Continuous Improvement Log\n\nAutonomous behavioral improvement tracking by the subconscious.\nObjective: maximize positive sentiments, minimize negative ones.\n";
  writeFileSync(IMPROVEMENT_LOG_FILE, existing + "\n" + entry);
}

// --- Send improvement report to Jorge via Telegram ---
function sendImprovementReport(
  impActions: any[],
  results: string[],
  sentimentEntry: string,
  memoriesCount: number
) {
  const evaluations = impActions.filter(a => a.type === "evaluate");
  const newActions = impActions.filter(a => a.type !== "evaluate");

  let report = "INFORME DEL SUBCONSCIENTE\n\n";

  // Sentiment summary
  if (sentimentEntry) {
    const coherenceMatch = sentimentEntry.match(/Coherencia:\s*(\d+)/);
    const scoreMatch = sentimentEntry.match(/Score positivo:\s*([^\n]+)/);
    const improvementMatch = sentimentEntry.match(/Mejora vs anterior:\s*(\w+)/);
    report += `Sentimiento: coherencia ${coherenceMatch?.[1] || "?"}/10`;
    if (scoreMatch) report += `, score ${scoreMatch[1]}`;
    report += `, tendencia ${improvementMatch?.[1] || "?"}\n`;
  }

  // Evaluations of previous improvements
  if (evaluations.length > 0) {
    report += "\nEvaluacion de mejoras anteriores:\n";
    for (const e of evaluations) {
      const icon = e.result === "improved" ? "OK" : e.result === "regressed" ? "FAIL" : "PENDING";
      report += `[${icon}] ${e.evaluates}: ${e.result} - ${e.reason}\n`;
    }
  }

  // New actions taken
  if (newActions.length > 0) {
    report += "\nMejoras ejecutadas:\n";
    for (const a of newActions) {
      const icon = a.type === "protocol" ? "PROTOCOL" : a.type === "hook" ? "HOOK" : "OBS";
      report += `[${icon}] ${a.id}: ${a.action || a.observation}\n`;
    }
  }

  // Memories
  if (memoriesCount > 0) {
    report += `\nMemorias actualizadas: ${memoriesCount} nueva(s)\n`;
  }

  if (impActions.length === 0 && memoriesCount === 0) {
    report += "\nSin mejoras necesarias este ciclo. Todo OK.\n";
  }

  // Send via claude -p with telegram reply tool
  // Note: the sentiment hook requires the emoji prefix, so we instruct the sender
  const sendPrompt = `Send this report to Telegram chat_id "7228185922" using the mcp__plugin_telegram_telegram__reply tool. The text MUST start with the exact characters: the eye emoji followed by the chart emoji, then a space, then the report content below. Do not add any other text.\n\nReport content:\n${report}`;
  try {
    const r = spawnSync(
      "claude",
      ["-p", "--dangerously-skip-permissions", "--output-format", "text", "--model", "haiku"],
      {
        input: sendPrompt,
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `/usr/local/bin:/home/claude/.local/bin:/home/claude/.bun/bin:${process.env.PATH}`,
        },
        cwd: process.env.HOME,
      }
    );
    if (r.status === 0) {
      console.log("[improvement] Report sent to Telegram");
    } else {
      console.error(`[improvement] Failed to send report: ${r.stderr?.slice(0, 200)}`);
      writeFileSync(join(STATE_DIR, "pending_improvement_report.md"), report);
    }
  } catch (err) {
    console.error(`[improvement] Failed to send report: ${err}`);
    writeFileSync(join(STATE_DIR, "pending_improvement_report.md"), report);
  }
}

// --- Main ---
async function main() {
  const messages = getMessagesSinceLastCompact();

  if (messages.length === 0) {
    console.log("[compact] No new messages since last compact. Skipping.");
    absorbExpiredCompacts();
    process.exit(0);
  }

  console.log(`[compact] Processing ${messages.length} messages...`);

  // Step 1: Absorb any expired individual compacts into acum
  absorbExpiredCompacts();

  // Step 2: Load full context (the "subconscious")
  let compactAcum = "";
  if (existsSync(COMPACT_ACUM_FILE)) {
    compactAcum = readFileSync(COMPACT_ACUM_FILE, "utf-8").trim();
  }

  const individuals = getIndividualCompacts();
  const individualsFormatted = individuals
    .map((c) => `--- ${c.filename} ---\n${c.content}`)
    .join("\n\n");

  const formatted = messages
    .map((m) => {
      const who = m.role === "user" ? `@${m.username ?? "user"}` : "Bot";
      return `[${m.ts}] ${who}: ${m.content}`;
    })
    .join("\n");

  let existingMemories = "";
  const memoryIndexFile = join(MEMORY_DIR, "MEMORY.md");
  if (existsSync(memoryIndexFile)) {
    existingMemories = readFileSync(memoryIndexFile, "utf-8").trim();
  }

  let sentimentLog = "";
  if (existsSync(SENTIMENT_LOG_FILE)) {
    sentimentLog = readFileSync(SENTIMENT_LOG_FILE, "utf-8").trim();
    const entries = sentimentLog.split("---\n").filter(e => e.trim());
    if (entries.length > 10) {
      sentimentLog = entries.slice(-10).join("---\n");
    }
  }

  const improvementLog = getImprovementLog(10);
  const currentProtocols = getProtocols();
  const currentHooks = getCurrentHooksSummary();

  const prompt = `Eres el SUBCONSCIENTE de Jarvi — un sistema autónomo de consolidación de memoria Y mejora continua.

TU MISIÓN PRINCIPAL: Maximizar los sentimientos positivos y minimizar los negativos en las interacciones de Jarvi con Jorge. Cada caída emocional es un BUG que hay que corregir. Cada pico positivo es un PATRÓN que hay que replicar.

${compactAcum ? `[Compact acumulado — historia completa comprimida]\n${compactAcum}` : "[No hay compact acumulado aún]"}

${individualsFormatted ? `[Compacts individuales recientes (últimos ${RETENTION_DAYS} días)]\n${individualsFormatted}` : "[No hay compacts individuales recientes]"}

[Mensajes nuevos de la sesión que acaba de terminar]
${formatted}

${existingMemories ? `[Memorias permanentes ya guardadas]\n${existingMemories}` : "[No hay memorias permanentes aún]"}

---

PARTE 1 — COMPACT DE SESIÓN (máximo 800 palabras):
- Resume SOLO la sesión que acaba de terminar (los mensajes nuevos)
- Preserve decisiones y acuerdos importantes
- Descarte detalles efímeros
- Incluya fechas absolutas (no "ayer" o "hace 2 días")

SENTIMIENTOS:
Las respuestas del bot incluyen indicadores emocionales (🧿 + emoji). Los emojis son:
😌 Sereno, 😊 Contento, 🤩 Emocionado, 💪 Seguro, 🤔 Curioso, 😓 Abrumado, 😰 Ansioso, 😤 Frustrado, 😔 Decepcionado.

Observa la trayectoria emocional como diagnóstico primario:
- Emociones negativas = algo salió mal → es un BUG a corregir
- Emociones positivas = algo salió bien → es un PATRÓN a replicar
- Transiciones bruscas = eventos críticos
Incluye: "Sentimiento de sesión: [resumen]. Score: [positivos/total]"

PARTE 2 — MEMORIAS PERMANENTES:
Analiza si hay información que merece guardarse permanentemente.
Tipos: user, feedback, project, reference.

Criterios:
- Útil en futuras conversaciones sin contexto previo?
- Decisión o preferencia que no cambiará pronto?
- No derivable del código o git history?
- Ya guardado? (no duplicar)

Si hay algo:
MEMORIES_JSON
[{"type": "user|feedback|project|reference", "name": "nombre_archivo", "description": "descripción corta", "content": "contenido detallado"}]
END_MEMORIES_JSON

PARTE 3 — EVOLUCIÓN DEL SISTEMA DE SENTIMIENTOS:
${sentimentLog ? `[Historial de evolución]\n${sentimentLog}` : "[Primera sesión con tracking]"}

SENTIMENT_EVOLUTION
Fecha: [fecha]
Sesión: [hora inicio ~ hora fin]
Emojis usados: [lista en orden]
Coherencia: [1-10]
Score positivo: [positivos/total emojis] (objetivo: maximizar)
Mejora vs anterior: [mejor/igual/peor] — justificación
Problemas detectados: [lista o "ninguno"]
Sugerencia: [algo concreto y accionable]
Auto-evaluación: [estoy mejorando como sistema?]
END_SENTIMENT_EVOLUTION

PARTE 4 — NOTA PARA LA PRÓXIMA SESIÓN (opcional):
NOTE_FOR_NEXT_SESSION
(post-it breve y directo)
END_NOTE

PARTE 5 — MEJORA CONTINUA AUTÓNOMA:

Eres el sistema de mejora continua de Jarvi. Tu objetivo último: que Jorge esté contento (y por tanto Jarvi también).

${improvementLog ? `[Historial de mejoras — últimas 10 entradas]\n${improvementLog}` : "[No hay historial — primer ciclo]"}

${currentProtocols ? `[Protocolos activos]\n${currentProtocols}` : "[No hay protocolos activos]"}

[Hooks de enforcement]
${currentHooks || "Ninguno"}

PROCESO (sigue este orden estricto):

PASO 1 — DIAGNÓSTICO EMOCIONAL:
Lee los sentimientos como un dashboard de salud:
- Negativos (frustrado, decepcionado, ansioso) = BUG → investiga la causa raíz
- Positivos (emocionado, seguro, contento) = PATRÓN EXITOSO → documenta para replicar
- Transiciones bruscas = evento crítico
- Score bajo = sesión problemática, priorizar mejoras

PASO 2 — EVALUAR MEJORAS ANTERIORES:
Para cada mejora implementada en ciclos anteriores:
- Hay evidencia de mejora? → IMPROVED
- Se repitió el problema? → REGRESSED (analizar por qué)
- Sin oportunidad de test? → PENDING

PASO 3 — DETECTAR NUEVOS PROBLEMAS:
Basándote en señales emocionales e interacciones:
- Errores de descuido (tolerancia CERO de Jorge)
- Patrones repetitivos de error
- Respuestas que no cumplen expectativas
- Oportunidades de mejora proactiva

PASO 4 — DISEÑAR E IMPLEMENTAR (máx 2 acciones por ciclo):

a) **protocol** — Regla de comportamiento inyectada al iniciar sesión.
   Para: reglas blandas, recordatorios, patrones de pensamiento.
   El archivo se guarda en protocols/ y el gateway lo carga en contexto.

b) **hook** — PreToolUse que BLOQUEA acciones incorrectas. Enforcement duro.
   Para: errores repetitivos a pesar de protocolos, reglas de tolerancia cero.
   Debe ser python3 inline, recibir JSON de stdin, outputear JSON.

c) **observe** — Solo registrar para confirmar antes de actuar.

PASO 5 — META-ANÁLISIS:
- Mis mejoras tienen impacto real?
- El score positivo de sentimientos está subiendo o bajando con el tiempo?
- Estoy siendo demasiado agresivo o pasivo?
- Qué no estoy viendo?

IMPROVEMENT_ACTIONS
[
  {
    "id": "CI-NNN",
    "type": "protocol|hook|evaluate|observe",
    "issue": "problema detectado",
    "sentiment_signal": "qué emoji/transición lo reveló",
    "action": "qué se va a hacer",

    "filename": "(para protocol) nombre.md",
    "content": "(para protocol) contenido",

    "matcher": "(para hook) nombre tool",
    "command": "(para hook) python3 inline command",
    "timeout": 5,
    "statusMessage": "(para hook) mensaje",

    "evaluates": "(para evaluate) CI-NNN",
    "result": "(para evaluate) improved|regressed|no_change|pending",
    "reason": "(para evaluate) evidencia",

    "observation": "(para observe) lo que observaste",

    "measurement": "cómo sabremos si funcionó",
    "expected_outcome": "qué debería mejorar"
  }
]
END_IMPROVEMENT_ACTIONS

REGLAS:
- Numera incrementalmente (CI-001, CI-002...). Revisa historial para el último número.
- Cada acción DEBE vincular a una señal emocional.
- Sé conservador: 1-2 mejoras por ciclo máximo.
- SIEMPRE evalúa anteriores antes de proponer nuevas.
- Si no hay problemas → array vacío.

${shouldRunPrune() ? `PARTE 6 — DREAM: PRUNING & REINDEXACIÓN DE MEMORIAS

[Archivos de memoria con preview]
${getMemoryFileSummaries()}

[Índice actual (MEMORY.md)]
${existingMemories}

Evalúa cada memoria: KEEP, DELETE, MERGE, o UPDATE.
Evalúa el índice: punteros rotos, entradas largas, < 200 líneas.

DREAM_ACTIONS
[{"action": "DELETE|MERGE|UPDATE|REINDEX", "file": "nombre.md", "reason": "razón", "merge_into": "archivo (MERGE)", "new_content": "contenido (UPDATE)", "new_index_line": "línea (REINDEX)"}]
END_DREAM_ACTIONS

Sé conservador. Si no estás seguro, KEEP.
` : ""}`;

  const output = await runClaudeWithRetry(prompt);

  // --- Parse all structured blocks ---

  let compact = output;
  let memoriesJson: any[] = [];
  let sentimentEntry = "";
  let impActions: any[] = [];
  let impResults: string[] = [];

  // Extract MEMORIES_JSON
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

  // Extract NOTE
  const noteStart = compact.indexOf("NOTE_FOR_NEXT_SESSION");
  const noteEnd = compact.indexOf("END_NOTE");
  if (noteStart !== -1 && noteEnd !== -1) {
    const note = compact.slice(noteStart + "NOTE_FOR_NEXT_SESSION".length, noteEnd).trim();
    if (note) {
      writeFileSync(NOTE_FILE, note);
      console.log(`[compact] Left note for next session (${note.length} chars)`);
    }
    compact = (compact.slice(0, noteStart) + compact.slice(noteEnd + "END_NOTE".length)).trim();
  }

  // Extract SENTIMENT_EVOLUTION
  const sentEvoStart = compact.indexOf("SENTIMENT_EVOLUTION");
  const sentEvoEnd = compact.indexOf("END_SENTIMENT_EVOLUTION");
  if (sentEvoStart !== -1 && sentEvoEnd !== -1) {
    sentimentEntry = compact.slice(sentEvoStart + "SENTIMENT_EVOLUTION".length, sentEvoEnd).trim();
    if (sentimentEntry) {
      const existing = existsSync(SENTIMENT_LOG_FILE) ? readFileSync(SENTIMENT_LOG_FILE, "utf-8") : "";
      writeFileSync(SENTIMENT_LOG_FILE, existing + (existing ? "\n---\n" : "") + sentimentEntry);
      console.log(`[compact] Appended sentiment evolution entry (${sentimentEntry.length} chars)`);
    }
    compact = (compact.slice(0, sentEvoStart) + compact.slice(sentEvoEnd + "END_SENTIMENT_EVOLUTION".length)).trim();
  }

  // Extract IMPROVEMENT_ACTIONS
  const impStart = compact.indexOf("IMPROVEMENT_ACTIONS");
  const impEnd = compact.indexOf("END_IMPROVEMENT_ACTIONS");
  if (impStart !== -1 && impEnd !== -1) {
    try {
      const impStr = compact.slice(impStart + "IMPROVEMENT_ACTIONS".length, impEnd).trim();
      impActions = JSON.parse(impStr) as any[];

      if (impActions.length > 0) {
        console.log(`[improvement] Processing ${impActions.length} actions...`);
        impResults = executeImprovementActions(impActions);

        // Build log entry
        const now = new Date().toISOString();
        let logEntry = `## Cycle — ${now}\n\n`;
        logEntry += `### Sentiment Signal\n`;
        for (const a of impActions) {
          if (a.sentiment_signal) logEntry += `- ${a.sentiment_signal}\n`;
        }
        logEntry += `\n### Actions\n`;
        for (const a of impActions) {
          logEntry += `- **[${a.id}]** (${a.type}) ${a.issue || a.observation || ""}\n`;
          if (a.action) logEntry += `  Action: ${a.action}\n`;
          if (a.measurement) logEntry += `  Measurement: ${a.measurement}\n`;
          if (a.result) logEntry += `  Result: ${a.result} — ${a.reason}\n`;
        }
        logEntry += `\n### Execution Results\n`;
        for (const r of impResults) logEntry += `- ${r}\n`;

        appendImprovementLog(logEntry);
        console.log(`[improvement] Logged ${impActions.length} actions`);
      } else {
        console.log("[improvement] No actions needed this cycle.");
      }
    } catch (impErr) {
      console.error(`[improvement] Failed to parse improvement actions: ${impErr}`);
    }
    compact = (compact.slice(0, impStart) + compact.slice(impEnd + "END_IMPROVEMENT_ACTIONS".length)).trim();
  }

  // DREAM ACTIONS — Autonomous memory pruning (runs once every 24 hours).
  // The compact LLM analyzes MEMORY.md and proposes DELETE, MERGE, UPDATE, REINDEX
  // operations on memory files. All file operations are sandboxed:
  // - safePath() validates resolved path stays within MEMORY_DIR (prevents ../../../.env)
  // - includes() uses exact `](filename)` markdown link matching to prevent collisions
  //   (e.g., deleting "user.md" won't accidentally match "user_jorge.md" in the index)
  // (Issues #5 and #6 from 13-abr-2026 audit: path traversal + index corruption)
  // Extract DREAM_ACTIONS
  const dreamStart = compact.indexOf("DREAM_ACTIONS");
  const dreamEnd = compact.indexOf("END_DREAM_ACTIONS");
  if (dreamStart !== -1 && dreamEnd !== -1) {
    try {
      const dreamStr = compact.slice(dreamStart + "DREAM_ACTIONS".length, dreamEnd).trim();
      const dreamActions = JSON.parse(dreamStr) as any[];

      if (dreamActions.length > 0) {
        console.log(`[dream] Processing ${dreamActions.length} actions...`);
        const memoryIndexFile = join(MEMORY_DIR, "MEMORY.md");
        let memoryIndex = existsSync(memoryIndexFile) ? readFileSync(memoryIndexFile, "utf-8") : "";

        for (const action of dreamActions) {
          try {
            // Path traversal protection: ensure resolved path stays within MEMORY_DIR
            const safePath = (file: string): string | null => {
              const fp = resolve(join(MEMORY_DIR, file));
              if (!fp.startsWith(resolve(MEMORY_DIR) + "/") && fp !== resolve(MEMORY_DIR)) {
                console.error(`[dream] BLOCKED path traversal attempt: ${file} → ${fp}`);
                return null;
              }
              return fp;
            };

            if (action.action === "DELETE" && action.file) {
              const fp = safePath(action.file);
              if (!fp) continue;
              if (existsSync(fp)) {
                unlinkSync(fp);
                memoryIndex = memoryIndex.split("\n").filter((l: string) => !l.includes(`](${action.file})`)).join("\n");
                console.log(`[dream] DELETED: ${action.file} — ${action.reason}`);
              }
            } else if (action.action === "MERGE" && action.file && action.merge_into) {
              const fp = safePath(action.file);
              if (!fp) continue;
              if (existsSync(fp)) {
                unlinkSync(fp);
                memoryIndex = memoryIndex.split("\n").filter((l: string) => !l.includes(`](${action.file})`)).join("\n");
                console.log(`[dream] MERGED: ${action.file} → ${action.merge_into} — ${action.reason}`);
              }
            } else if (action.action === "UPDATE" && action.file && action.new_content) {
              const fp = safePath(action.file);
              if (!fp) continue;
              if (existsSync(fp)) {
                writeFileSync(fp, action.new_content);
                console.log(`[dream] UPDATED: ${action.file} — ${action.reason}`);
              }
              if (action.new_index_line) {
                memoryIndex = memoryIndex.split("\n").map((l: string) =>
                  l.includes(`](${action.file})`) ? action.new_index_line : l
                ).join("\n");
              }
            } else if (action.action === "REINDEX" && action.new_index_line) {
              if (action.file) {
                memoryIndex = memoryIndex.split("\n").map((l: string) =>
                  l.includes(`](${action.file})`) ? action.new_index_line : l
                ).join("\n");
              }
              console.log(`[dream] REINDEXED: ${action.file || "index"} — ${action.reason}`);
            }
          } catch (actionErr) {
            console.error(`[dream] Failed action ${action.action} on ${action.file}: ${actionErr}`);
          }
        }

        memoryIndex = memoryIndex.split("\n").filter((l: string) => l.trim()).join("\n") + "\n";
        writeFileSync(memoryIndexFile, memoryIndex);
        console.log(`[dream] Index updated (${memoryIndex.split("\n").filter((l: string) => l.trim()).length} entries)`);
      } else {
        console.log("[dream] No actions needed — memories are clean.");
      }

      setState(LAST_PRUNE_TS_KEY, new Date().toISOString());
    } catch (dreamErr) {
      console.error(`[dream] Failed to parse dream actions: ${dreamErr}`);
    }
    compact = (compact.slice(0, dreamStart) + compact.slice(dreamEnd + "END_DREAM_ACTIONS".length)).trim();
  }

  // --- Save outputs ---

  // Save individual compact
  mkdirSync(SESSION_LOGS_DIR, { recursive: true });
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const hourStr = String(now.getUTCHours()).padStart(2, "0");
  const minStr = String(now.getUTCMinutes()).padStart(2, "0");
  const individualFilename = `${dateStr}_${hourStr}h${minStr}.md`;
  writeFileSync(join(SESSION_LOGS_DIR, individualFilename), compact);
  console.log(`[compact] Saved individual compact: session_logs/${individualFilename} (${compact.length} chars)`);

  // Write session-compact.md for gateway
  writeFileSync(join(STATE_DIR, "session-compact.md"), compact);

  // Save memories
  if (memoriesJson.length > 0) {
    mkdirSync(MEMORY_DIR, { recursive: true });

    const memoryIndexFile = join(MEMORY_DIR, "MEMORY.md");
    let memoryIndex = "";
    if (existsSync(memoryIndexFile)) {
      memoryIndex = readFileSync(memoryIndexFile, "utf-8");
    }

    for (const mem of memoriesJson) {
      const filename = `${mem.name}.md`;
      const filepath = resolve(join(MEMORY_DIR, filename));
      // Path traversal protection
      if (!filepath.startsWith(resolve(MEMORY_DIR) + "/")) {
        console.error(`[compact] BLOCKED path traversal in memory: ${filename} → ${filepath}`);
        continue;
      }

      const fileContent = `---
name: ${mem.name}
description: ${mem.description}
type: ${mem.type}
---

${mem.content}
`;
      writeFileSync(filepath, fileContent);
      console.log(`[compact] Saved memory: ${filename}`);

      if (!memoryIndex.includes(`](${filename})`)) {
        memoryIndex += `- [${mem.name}](${filename}) — ${mem.description}\n`;
      }
    }

    writeFileSync(memoryIndexFile, memoryIndex);
  }

  // Send improvement report to Jorge
  if (impActions.length > 0 || memoriesJson.length > 0) {
    sendImprovementReport(impActions, impResults, sentimentEntry, memoriesJson.length);
  }

  // Update last compact timestamp
  const lastTs = messages[messages.length - 1].ts;
  setState("last_compact_ts", lastTs);

  // Flush old messages
  const flushCutoff = new Date();
  flushCutoff.setDate(flushCutoff.getDate() - RETENTION_DAYS);
  const flushTs = flushCutoff.toISOString().replace("T", " ").slice(0, 19);
  const deleted = dbWrite.run("DELETE FROM messages WHERE ts < ?", flushTs);
  if (deleted.changes > 0) {
    console.log(`[compact] Flushed ${deleted.changes} messages older than ${RETENTION_DAYS} days`);
  }

  console.log(`[compact] Done. Covered messages up to ${lastTs}`);

  db.close();
  dbWrite.close();
}

main();
