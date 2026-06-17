import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME ?? process.cwd();
const DATA_ROOT = process.env.MINDSTONE_PI_ROOT ?? join(HOME, ".pi", "agent", "mindstone");
const ORCHESTRATOR_DIR = join(DATA_ROOT, "orchestrator");
const MEMORY_DIR = join(ORCHESTRATOR_DIR, "memory");
const ROLES_DIR = join(ORCHESTRATOR_DIR, "roles");
const TEMPLATES_DIR = join(ORCHESTRATOR_DIR, "templates");
const TRANSCRIPTS_DIR = join(ORCHESTRATOR_DIR, "transcripts");
const ONBOARDING_DIR = join(DATA_ROOT, "onboarding");

const IDENTITY_FILE = join(ORCHESTRATOR_DIR, "IDENTITY.md");
const USER_FILE = join(ORCHESTRATOR_DIR, "USER.md");
const LOG_FILE = join(ORCHESTRATOR_DIR, "LOG.md");
const MEMORY_INDEX_FILE = join(MEMORY_DIR, "MEMORY.md");
const HANDOFF_FILE = join(TRANSCRIPTS_DIR, ".handoff.md");
const RECENT_TAIL_MARKER = "## RECENT TAIL (since rich handoff)";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ONBOARDING_DIR = join(PACKAGE_ROOT, "onboarding");
const PACKAGE_HOOKS_DIR = join(PACKAGE_ROOT, "orchestrator", "hooks");
const PACKAGE_VENV_PYTHON = join(PACKAGE_ROOT, "orchestrator", ".venv", "bin", "python");

const CONTEXT_BUDGET_CHARS = 50_000;
const LOG_TAIL_LINES = 60;

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw) ? true : /^(0|false|no|off)$/i.test(raw) ? false : fallback;
}

const COMPACTION_POLICY = {
  checkpointWarningPercent: envNumber("MS4PI_CHECKPOINT_WARNING_PERCENT", 85, 1, 99),
  compactTargetPercent: envNumber("MS4PI_COMPACT_TARGET_PERCENT", 92, 1, 99),
  keepRecentTokens: envNumber("MS4PI_KEEP_RECENT_TOKENS", 20_000, 1_000, 1_000_000),
  emergencyAutoHandoff: envBoolean("MS4PI_EMERGENCY_AUTO_HANDOFF", false),
};

type Frontmatter = Record<string, string | number | boolean | string[] | null | undefined>;
type MemoryFile = { path: string; name: string; frontmatter: Frontmatter; body: string; text: string };

let activeRoleName: string | undefined;
let activeRoleContext = "";
let activeRoleStartedAt: string | undefined;
let replayHandoffOnNextTurn = false;
let compactionWatchdogPrompted = false;

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  if (existsSync(path)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return true;
}

async function copyIfMissing(source: string, target: string): Promise<boolean> {
  if (existsSync(target) || !existsSync(source)) return false;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

function parseScalar(value: string): string | number | boolean | string[] | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""));
  }
  return trimmed.replace(/^['\"]|['\"]$/g, "");
}

function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter: Frontmatter = {};
  for (const line of match[1].split("\n")) {
    const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!parsed) continue;
    frontmatter[parsed[1]] = parseScalar(parsed[2]);
  }
  return { frontmatter, body: match[2] };
}

function hasFlag(fm: Frontmatter, flag: string): boolean {
  return fm[flag] === true || fm[flag] === "true";
}

function tailLines(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function trimToBudget(parts: string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const next = part.trim();
    if (!next) continue;
    if (used + next.length > budget) {
      const remaining = budget - used;
      if (remaining > 500) kept.push(next.slice(0, remaining) + "\n\n[MindStone context truncated to budget]");
      break;
    }
    kept.push(next);
    used += next.length;
  }
  return kept.join("\n\n---\n\n");
}

async function loadMemories(): Promise<MemoryFile[]> {
  if (!existsSync(MEMORY_DIR)) return [];
  const names = await readdir(MEMORY_DIR);
  const memories: MemoryFile[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md")) continue;
    const path = join(MEMORY_DIR, name);
    const text = await readTextIfExists(path);
    const { frontmatter, body } = parseFrontmatter(text);
    memories.push({ path, name, frontmatter, body, text });
  }
  return memories;
}

async function initializeScaffold(): Promise<string[]> {
  const created: string[] = [];
  for (const dir of [ORCHESTRATOR_DIR, MEMORY_DIR, ROLES_DIR, TEMPLATES_DIR, TRANSCRIPTS_DIR, ONBOARDING_DIR]) {
    await mkdir(dir, { recursive: true });
  }

  for (const name of ["IDENTITY.md.example", "USER.md.example", "AGENTS.md.example"]) {
    if (await copyIfMissing(join(PACKAGE_ONBOARDING_DIR, name), join(ONBOARDING_DIR, name))) {
      created.push(join(ONBOARDING_DIR, name));
    }
  }

  const packageRolesDir = join(PACKAGE_ROOT, "orchestrator", "roles");
  if (existsSync(packageRolesDir)) {
    for (const name of await readdir(packageRolesDir)) {
      if (!name.endsWith(".md")) continue;
      if (await copyIfMissing(join(packageRolesDir, name), join(ROLES_DIR, name))) {
        created.push(join(ROLES_DIR, name));
      }
    }
  }

  if (await writeIfMissing(LOG_FILE, "# MindStone for Pi Log\n\n")) created.push(LOG_FILE);
  if (
    await writeIfMissing(
      MEMORY_INDEX_FILE,
      `---\nname: MEMORY\ndescription: Index of MindStone for Pi memory files.\ntype: index\ntags: [memory, index]\nprojects: []\nhits: 0\nprevented: 0\nlast_applied: null\ncreated: ${new Date().toISOString().slice(0, 10)}\nhalf_life_days: 30\ncritical: false\nevergreen: true\n---\n\n# Memory Index\n\nAdd memory file pointers here as the memory set grows.\n`
    )
  ) {
    created.push(MEMORY_INDEX_FILE);
  }

  return created;
}

async function buildMindStoneContext(cwd: string): Promise<string> {
  const parts: string[] = [];
  const identity = await readTextIfExists(IDENTITY_FILE);
  const user = await readTextIfExists(USER_FILE);
  const log = await readTextIfExists(LOG_FILE);
  const memories = await loadMemories();

  parts.push(`# MindStone for Pi\n\nData root: ${DATA_ROOT}\nCurrent working directory: ${cwd}`);

  if (identity) {
    parts.push(`## IDENTITY\n${identity}`);
  } else {
    parts.push(
      `## FIRST-RUN / STATELESS MODE\nNo MindStone identity exists yet at ${IDENTITY_FILE}. Run /ms-init, then /ms-onboard if the user wants persistent identity. Until then, do not claim persistent identity or memory continuity.`
    );
  }

  if (user) parts.push(`## USER\n${user}`);

  const critical = memories.filter((m) => hasFlag(m.frontmatter, "critical") && m.name !== "MEMORY.md");
  if (critical.length > 0) {
    parts.push(["## CRITICAL MEMORIES", ...critical.map((m) => `### ${m.name}\n${m.body.trim()}`)].join("\n\n"));
  }

  const evergreen = memories.filter((m) => !hasFlag(m.frontmatter, "critical") && hasFlag(m.frontmatter, "evergreen"));
  if (evergreen.length > 0) {
    parts.push(
      ["## EVERGREEN MEMORY POINTERS", ...evergreen.map((m) => `- ${m.name}${m.frontmatter.description ? ` — ${m.frontmatter.description}` : ""}`)].join("\n")
    );
  }

  if (activeRoleName && activeRoleContext) {
    parts.push(`## ACTIVE ROLE ADOPTION: ${activeRoleName}\nStarted: ${activeRoleStartedAt}\n\n${activeRoleContext}`);
  }

  if (log) parts.push(`## RECENT LOG TAIL\n${tailLines(log, LOG_TAIL_LINES)}`);

  return `<mindstone-context>\n${trimToBudget(parts, CONTEXT_BUDGET_CHARS)}\n</mindstone-context>`;
}

async function listRoleNames(): Promise<string[]> {
  if (!existsSync(ROLES_DIR)) return [];
  const names = await readdir(ROLES_DIR);
  return names.filter((name) => name.endsWith(".md")).map((name) => name.replace(/\.md$/, "")).sort();
}

async function findRoleFile(roleName: string, cwd: string): Promise<string> {
  const safeName = basename(roleName).replace(/\.md$/, "");
  const candidates = [
    join(cwd, ".pi", "mindstone", "roles", `${safeName}.md`),
    join(cwd, "roles", `${safeName}.md`),
    join(ROLES_DIR, `${safeName}.md`),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

function searchScore(queryTerms: string[], memory: MemoryFile): number {
  const haystack = `${memory.name}\n${JSON.stringify(memory.frontmatter)}\n${memory.body}`.toLowerCase();
  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text.trim());
    else if (block.type === "toolCall") parts.push(`[tool-call: ${String(block.name ?? "?")}]`);
    else if (block.type === "toolResult") parts.push(`[tool-result: ${String(block.toolName ?? "?")}]`);
  }
  return parts.filter(Boolean).join("\n").trim();
}

const NOISE_PREFIXES = [
  "<semantic-recall",
  "<mindstone-context",
  "<post-compaction-handoff",
  "<context-capacity-handoff",
  "<precompact",
];

async function archiveSessionFile(sessionFile: string | undefined): Promise<{ archivedPath?: string; message: string }> {
  if (!sessionFile) return { message: "No Pi session file resolved; archive skipped." };
  if (!existsSync(sessionFile)) return { message: `Pi session file not found: ${sessionFile}` };

  await mkdir(TRANSCRIPTS_DIR, { recursive: true });
  const archivedPath = join(TRANSCRIPTS_DIR, basename(sessionFile));
  if (existsSync(archivedPath)) {
    const sourceStat = await stat(sessionFile);
    const archiveStat = await stat(archivedPath);
    if (archiveStat.mtimeMs >= sourceStat.mtimeMs) {
      return { archivedPath, message: `Transcript archive already current: ${archivedPath}` };
    }
  }

  await copyFile(sessionFile, archivedPath);
  return { archivedPath, message: `Transcript archived: ${archivedPath}` };
}

async function refreshHandoffTail(sessionFile: string | undefined): Promise<string> {
  if (!sessionFile || !existsSync(sessionFile)) return "No session file resolved; .handoff.md recent tail not refreshed.";
  const text = await readTextIfExists(sessionFile);
  if (!text) return "Session file empty; .handoff.md recent tail not refreshed.";

  const messages: Array<{ role: string; text: string }> = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw) as Record<string, any>;
      if (entry.type !== "message" || !entry.message) continue;
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const body = extractMessageText(entry.message.content);
      if (!body || NOISE_PREFIXES.some((prefix) => body.startsWith(prefix))) continue;
      messages.push({ role, text: body });
    } catch {
      // Ignore malformed JSONL lines.
    }
  }

  const tail = messages.slice(-16);
  if (!tail.length) return "No user/assistant text found for .handoff.md recent tail.";

  const stamp = new Date().toISOString();
  const tailBlock = [
    RECENT_TAIL_MARKER,
    `_Mechanical capture by MS4PI at ${stamp} — raw recent exchange after the rich handoff. Authoritative for anything the rich handoff predates._`,
    "",
    ...tail.map((message) => {
      const snippet = message.text.replace(/\s+/g, " ").slice(0, 500);
      return `- **${message.role}:** ${snippet}${message.text.length > 500 ? "…" : ""}`;
    }),
    "",
  ].join("\n");

  const existing = await readTextIfExists(HANDOFF_FILE);
  const body = existing.includes(RECENT_TAIL_MARKER)
    ? existing.split(RECENT_TAIL_MARKER, 1)[0].trimEnd()
    : existing.trimEnd() || "# HANDOFF\n\nNo rich handoff has been written yet. Mechanical recent tail follows.";
  await mkdir(TRANSCRIPTS_DIR, { recursive: true });
  await writeFile(HANDOFF_FILE, `${body}\n\n${tailBlock}`, "utf8");
  return `.handoff.md recent tail refreshed: ${HANDOFF_FILE}`;
}

async function readHandoffBlock(): Promise<string> {
  const handoff = await readTextIfExists(HANDOFF_FILE);
  if (!handoff.trim()) return "";
  return `<post-compaction-handoff priority="CRITICAL">\nYou just compacted or requested a handoff replay. Use this handoff before relying on the lossy compaction summary. Full file: ${HANDOFF_FILE}\n\n${handoff.trim()}\n</post-compaction-handoff>`;
}

function sessionFileFromContext(ctx: any): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionFile?.() ?? ctx?.sessionFile;
  } catch {
    return undefined;
  }
}

function reserveTokensForTarget(contextWindow: number | undefined, targetPercent = COMPACTION_POLICY.compactTargetPercent): number | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined;
  return Math.ceil(contextWindow * (1 - targetPercent / 100));
}

function describeCompactionPolicy(ctx: any): string[] {
  const usage = ctx?.getContextUsage?.();
  const contextWindow = usage?.contextWindow ?? ctx?.model?.contextWindow;
  const reserveTokens = reserveTokensForTarget(contextWindow);
  return [
    `Policy: checkpoint/handoff prompt at ${COMPACTION_POLICY.checkpointWarningPercent}%; native Pi auto-compact target ${COMPACTION_POLICY.compactTargetPercent}%.`,
    `Emergency auto-write: ${COMPACTION_POLICY.emergencyAutoHandoff ? "enabled" : "disabled; approval remains required for LOG.md and .handoff.md writes"}.`,
    `Current usage: ${usage?.percent === null || usage?.percent === undefined ? "unknown" : `${usage.percent.toFixed(1)}%`} (${usage?.tokens ?? "unknown"}/${contextWindow ?? "unknown"} tokens).`,
    reserveTokens
      ? `Suggested Pi settings: compaction.enabled=true, reserveTokens=${reserveTokens}, keepRecentTokens=${COMPACTION_POLICY.keepRecentTokens}.`
      : `Suggested Pi settings: compaction.enabled=true, reserveTokens=contextWindow*(1-${COMPACTION_POLICY.compactTargetPercent}/100), keepRecentTokens=${COMPACTION_POLICY.keepRecentTokens}.`,
  ];
}

function validateMemoryMarkdown(filename: string, body: string): void {
  if (!filename.endsWith(".md")) throw new Error("Memory filename must end with .md");
  if (basename(filename) !== filename) throw new Error("Memory filename must not include path separators");
  if (filename === "MEMORY.md") throw new Error("Use indexEntry to update MEMORY.md; memory filename cannot be MEMORY.md");
  const required = ["name:", "description:", "type:", "tags:", "projects:", "hits:", "prevented:", "last_applied:", "created:", "half_life_days:", "critical:", "evergreen:"];
  if (!body.startsWith("---\n")) throw new Error("Memory body must start with YAML frontmatter");
  for (const key of required) {
    if (!body.includes(`\n${key}`) && !body.startsWith(`${key}`)) throw new Error(`Memory frontmatter missing required key: ${key}`);
  }
}

async function appendMemoryIndexEntry(indexEntry: string): Promise<void> {
  const entry = indexEntry.trim();
  if (!entry) return;
  await mkdir(dirname(MEMORY_INDEX_FILE), { recursive: true });
  const existing = await readTextIfExists(MEMORY_INDEX_FILE);
  if (existing.includes(entry)) return;
  const base = existing.trimEnd() || "# Memory Index";
  const needsSection = !/^## Memory Files/m.test(base);
  const next = needsSection ? `${base}\n\n## Memory Files\n\n${entry}\n` : `${base}\n${entry}\n`;
  await writeFile(MEMORY_INDEX_FILE, next, "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const initialized = existsSync(ORCHESTRATOR_DIR);
    const hasIdentity = existsSync(IDENTITY_FILE);
    if (!initialized) ctx.ui.notify("MindStone for Pi: run /ms-init to initialize.", "info");
    else if (!hasIdentity) ctx.ui.notify("MindStone for Pi: initialized but no identity. Run /ms-onboard for fresh onboarding.", "info");
    else ctx.ui.notify("MindStone for Pi identity loaded.", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const input = (event.input ?? {}) as Record<string, any>;

    if (toolName === "bash") {
      const command = String(input.command ?? "");
      const dangerous = /\b(git\s+(reset|rebase)|git\s+checkout\b|git\s+clean\b|git\s+push\s+.*--force|rm\s+-rf|rm\s+-fr|drop\s+database|truncate\s+table)\b/i.test(command);
      if (dangerous) {
        const ok = await ctx.ui.confirm("MindStone safety check", `Allow potentially destructive command?\n\n${command}`);
        if (!ok) return { block: true, reason: "Blocked by MindStone safety check" };
      }
    }

    if (toolName === "write" || toolName === "edit") {
      const target = String(input.path ?? "");
      const protectedPath = target.includes(ORCHESTRATOR_DIR) && /(IDENTITY\.md|USER\.md|LOG\.md|\/memory\/|\\memory\\)/.test(target);
      if (protectedPath) {
        const ok = await ctx.ui.confirm("MindStone protected file", `Allow ${toolName} on protected MindStone file?\n\n${target}`);
        if (!ok) return { block: true, reason: "Protected MindStone file blocked by user" };
      }
    }
  });

  async function runRecallScript(scriptName: string, args: string[] = [], timeout = 30_000) {
    const python = existsSync(PACKAGE_VENV_PYTHON) ? PACKAGE_VENV_PYTHON : "python3";
    return pi.exec("env", [`MS4PI_ORCHESTRATOR_DIR=${ORCHESTRATOR_DIR}`, python, join(PACKAGE_HOOKS_DIR, scriptName), ...args], { timeout });
  }

  async function semanticRecallBlock(prompt: string): Promise<string> {
    if (!prompt || prompt.trim().length < 8) return "";
    if (!existsSync(join(ORCHESTRATOR_DIR, "vectors.db"))) return "";
    try {
      const result = await runRecallScript("recall.py", [prompt, "--k", "6"], 20_000);
      if (result.code !== 0 || !result.stdout || result.stdout.includes("(no matches)")) return "";
      return `<semantic-recall>\n# Semantic recall for this prompt\n\nUse if relevant; ignore if not. Recall is probabilistic, not authoritative.\n\n${result.stdout.trim()}\n</semantic-recall>`;
    } catch {
      return "";
    }
  }

  async function maybePromptCompactionCheckpoint(ctx: any): Promise<void> {
    const usage = ctx?.getContextUsage?.();
    if (!usage || usage.percent === null || usage.percent === undefined) return;

    if (usage.percent < COMPACTION_POLICY.checkpointWarningPercent - 5) {
      compactionWatchdogPrompted = false;
      return;
    }

    if (usage.percent < COMPACTION_POLICY.checkpointWarningPercent || compactionWatchdogPrompted) return;
    compactionWatchdogPrompted = true;

    const sessionFile = sessionFileFromContext(ctx);
    const archive = await archiveSessionFile(sessionFile);
    const tail = await refreshHandoffTail(sessionFile);
    const policyLines = describeCompactionPolicy(ctx);
    const nearCompactTarget = usage.percent >= COMPACTION_POLICY.compactTargetPercent;

    ctx.ui.notify(
      `MindStone context watchdog: ${usage.percent.toFixed(1)}% used; checkpoint/handoff draft needed before compaction danger zone.`,
      nearCompactTarget ? "error" : "warning"
    );

    pi.sendUserMessage(
      `MindStone context watchdog fired.\n\n${policyLines.join("\n")}\n\nMechanical safety work already attempted:\n- ${archive.message}\n- ${tail}\n\nDraft a combined MindStone checkpoint and rich compaction handoff now. Preserve MS4CC structure. Do not write files until Clint approves.\n\nRequired draft outputs:\n1. A LOG.md checkpoint with title/date, scope, what happened, decisions made, memories cited, prevented confirmations, new memories proposed, drift flagged, and lint.\n2. A rich .handoff.md body with current objective, open threads, files/projects touched, decisions made, active role state, immediate next actions, and anything post-compaction Slate would regret losing.\n\nAfter approval, use mindstone_log_append and mindstone_handoff_write, then run /ms-recall-backfill or /ms-end-session so archive/embed is verified. A checkpoint without archive/embed verification is not complete.${nearCompactTarget ? "\n\nContext is already at or past the configured compaction target. After approved writes and archive/embed verification, recommend immediate compaction or allow Pi auto-compaction to proceed." : ""}`
    );
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const mindstone = await buildMindStoneContext(ctx.cwd);
    const recall = await semanticRecallBlock(event.prompt ?? "");
    const handoff = replayHandoffOnNextTurn ? await readHandoffBlock() : "";
    replayHandoffOnNextTurn = false;
    return { systemPrompt: `${event.systemPrompt}\n\n${handoff ? `${handoff}\n\n` : ""}${mindstone}${recall ? `\n\n${recall}` : ""}` };
  });

  pi.on("turn_end", async (_event, ctx) => {
    await maybePromptCompactionCheckpoint(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const sessionFile = sessionFileFromContext(ctx);
    const archive = await archiveSessionFile(sessionFile);
    const tail = await refreshHandoffTail(sessionFile);
    ctx.ui.notify(`MindStone PreCompact: ${archive.message}; ${tail}`, "warning");
  });

  pi.on("session_compact", async (_event, ctx) => {
    replayHandoffOnNextTurn = true;
    compactionWatchdogPrompted = false;
    ctx.ui.notify("MindStone: compaction finished; .handoff.md will replay on the next model turn. Running deferred recall backfill.", "info");
    try {
      await runRecallScript("indexer.py", ["backfill"], 120_000);
    } catch {
      ctx.ui.notify("MindStone: deferred recall backfill failed/degraded; run /ms-recall-status.", "warning");
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Best-effort only. /ms-end-session remains the explicit, verified path.
  });

  pi.registerCommand("ms4pi-install", {
    description: "Install/wire up MindStone for Pi by running the package bootstrapper",
    handler: async (_args, ctx) => {
      const bootstrap = join(PACKAGE_ROOT, "orchestrator", "bootstrap.sh");
      if (!existsSync(bootstrap)) {
        ctx.ui.notify(`Bootstrap script not found: ${bootstrap}`, "error");
        return;
      }
      const ok = await ctx.ui.confirm("Install MS4PI", `Run ${bootstrap}? This installs the Pi package and prepares the recall venv.`);
      if (!ok) return;
      const result = await pi.exec("bash", [bootstrap], { timeout: 180_000 });
      const message = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
      ctx.ui.notify(result.code === 0 ? "MS4PI install finished" : "MS4PI install failed", result.code === 0 ? "info" : "error");
      pi.sendMessage({ customType: "mindstone-install", content: message || "No installer output.", display: true, details: { code: result.code } });
    },
  });

  pi.registerCommand("ms4pi-update", {
    description: "Update MindStone for Pi, then rerun bootstrap",
    handler: async (_args, ctx) => {
      const gitDirCheck = await pi.exec("git", ["-C", PACKAGE_ROOT, "rev-parse", "--is-inside-work-tree"], { timeout: 10_000 });
      if (gitDirCheck.code !== 0) {
        ctx.ui.notify(`MS4PI package root is not a git checkout: ${PACKAGE_ROOT}`, "error");
        return;
      }

      const dirty = await pi.exec("git", ["-C", PACKAGE_ROOT, "status", "--porcelain"], { timeout: 10_000 });
      if (dirty.stdout.trim()) {
        pi.sendMessage({
          customType: "mindstone-install",
          content: `MS4PI update blocked: package checkout has uncommitted changes.\n\n${dirty.stdout.trim()}\n\nCommit/stash intentionally, then rerun /ms4pi-update.`,
          display: true,
        });
        ctx.ui.notify("MS4PI update blocked by dirty checkout", "warning");
        return;
      }

      const before = await pi.exec("git", ["-C", PACKAGE_ROOT, "rev-parse", "--short", "HEAD"], { timeout: 10_000 });
      const ok = await ctx.ui.confirm("Update MS4PI", `Run git pull --ff-only in ${PACKAGE_ROOT}, then rerun bootstrap?`);
      if (!ok) return;

      const pull = await pi.exec("git", ["-C", PACKAGE_ROOT, "pull", "--ff-only"], { timeout: 60_000 });
      const bootstrap = await pi.exec("bash", [join(PACKAGE_ROOT, "orchestrator", "bootstrap.sh")], { timeout: 180_000 });
      const after = await pi.exec("git", ["-C", PACKAGE_ROOT, "rev-parse", "--short", "HEAD"], { timeout: 10_000 });
      const message = [
        `Before: ${before.stdout.trim()}`,
        `After: ${after.stdout.trim()}`,
        "",
        "## git pull",
        pull.stdout?.trim(),
        pull.stderr?.trim(),
        "",
        "## bootstrap",
        bootstrap.stdout?.trim(),
        bootstrap.stderr?.trim(),
      ].filter(Boolean).join("\n");
      const success = pull.code === 0 && bootstrap.code === 0;
      ctx.ui.notify(success ? "MS4PI update finished" : "MS4PI update failed/degraded", success ? "info" : "error");
      pi.sendMessage({ customType: "mindstone-install", content: message, display: true, details: { pullCode: pull.code, bootstrapCode: bootstrap.code } });
    },
  });

  pi.registerCommand("ms-init", {
    description: "Initialize MindStone for Pi directories and onboarding templates",
    handler: async (_args, ctx) => {
      const created = await initializeScaffold();
      const message = created.length
        ? `MindStone for Pi initialized. Created:\n${created.map((p) => `- ${p}`).join("\n")}`
        : `MindStone for Pi already initialized at ${DATA_ROOT}`;
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "mindstone", content: message, display: true });
    },
  });

  pi.registerCommand("ms-onboard", {
    description: "Continue MindStone for Pi onboarding based on current identity/user state",
    handler: async () => {
      await initializeScaffold();

      if (!existsSync(IDENTITY_FILE)) {
        const invitation = await readTextIfExists(join(ONBOARDING_DIR, "IDENTITY.md.example"));
        pi.sendUserMessage(
          `Use this MindStone for Pi onboarding invitation to help author a fresh identity for this Pi substrate. Do not copy Cairn. Treat MS4CC as lineage/reference, and ask the user before writing IDENTITY.md.\n\nTarget identity file: ${IDENTITY_FILE}\nTarget user file after identity: ${USER_FILE}\n\n${invitation}`
        );
        return;
      }

      if (!existsSync(USER_FILE)) {
        const userSchema = await readTextIfExists(join(ONBOARDING_DIR, "USER.md.example"));
        pi.sendUserMessage(
          `Continue MindStone for Pi onboarding. IDENTITY.md already exists, so proceed naturally to the USER.md interview. Do not dump a questionnaire. Ask conversationally, in small groups, and build a concise USER.md draft for approval before writing it.\n\nTarget user file: ${USER_FILE}\n\nUse this interview schema as guidance, not as a rigid form:\n\n${userSchema}`
        );
        return;
      }

      const result = await runRecallScript("recall_status.py", [], 20_000);
      pi.sendMessage({
        customType: "mindstone",
        content: `MindStone identity/user onboarding files already exist:\n- ${IDENTITY_FILE}\n- ${USER_FILE}\n\nRecall setup is the next onboarding check. Current recall status:\n\n${result.stdout?.trim() || result.stderr?.trim() || "No recall status output."}\n\nIf chunks are empty or stale, run /ms-recall-backfill. Use /ms-status or /ms-context to inspect current state.`,
        display: true,
      });
    },
  });

  pi.registerCommand("ms-status", {
    description: "Show MindStone for Pi status",
    handler: async (_args, ctx) => {
      const memories = await loadMemories();
      const roles = await listRoleNames();
      let recallSummary = "Recall: not checked";
      try {
        const result = await runRecallScript("recall_status.py", [], 20_000);
        if (result.stdout?.trim()) {
          const status = JSON.parse(result.stdout);
          recallSummary = `Recall: ${status.mode}; chunks total=${status.chunks_total}, memory=${status.chunks_memory}, transcript=${status.chunks_transcript}; model=${status.embedding_model}`;
        }
      } catch {
        recallSummary = "Recall: status check failed/degraded";
      }
      const lines = [
        `Data root: ${DATA_ROOT}`,
        `Orchestrator dir: ${ORCHESTRATOR_DIR}`,
        `Identity: ${existsSync(IDENTITY_FILE) ? "present" : "missing"}`,
        `User: ${existsSync(USER_FILE) ? "present" : "missing"}`,
        `Log: ${existsSync(LOG_FILE) ? "present" : "missing"}`,
        `Memory files: ${memories.length}`,
        `Roles: ${roles.length}${roles.length ? ` (${roles.join(", ")})` : ""}`,
        `Active role: ${activeRoleName ?? "none"}`,
        `Handoff: ${existsSync(HANDOFF_FILE) ? "present" : "missing"}`,
        ...describeCompactionPolicy(ctx),
        recallSummary,
      ];
      const message = lines.join("\n");
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "mindstone", content: message, display: true });
    },
  });

  pi.registerCommand("ms-context", {
    description: "Display the MindStone context injected into model calls",
    handler: async (_args, ctx) => {
      pi.sendMessage({ customType: "mindstone", content: await buildMindStoneContext(ctx.cwd), display: true });
    },
  });

  pi.registerCommand("ms-compaction-status", {
    description: "Show MindStone compaction/checkpoint policy and suggested Pi settings",
    handler: async (_args, ctx) => {
      const message = ["# MindStone compaction policy", "", ...describeCompactionPolicy(ctx)].join("\n");
      ctx.ui.notify("MindStone compaction policy checked", "info");
      pi.sendMessage({ customType: "mindstone", content: message, display: true, details: { policy: COMPACTION_POLICY } });
    },
  });

  pi.registerCommand("ms-checkpoint", {
    description: "Draft a MindStone checkpoint entry, memory docs, and index updates for approval",
    handler: async () => {
      pi.sendUserMessage(
        `Run a MindStone for Pi checkpoint using the MS4CC checkpoint structure.\n\nRequired protocol:\n1. Draft a concise LOG.md entry with title/date, scope, what happened, decisions made, memories cited, prevented confirmations, new memories proposed, drift flagged, and lint.\n2. For each durable new lesson/fact/design decision, first search existing memory with /ms-recall-search or mindstone_memory_search to avoid duplicates.\n3. If no suitable memory exists, draft a full memory file using the MS4CC frontmatter schema and a proposed MEMORY.md pointer/index entry. If a suitable memory exists, draft an update instead of a duplicate.\n4. Do not write files yet. Show Clint the checkpoint bundle: exact LOG entry, each warranted memory file body/update, and each MEMORY.md index entry. Ask for approval.\n5. In checkpoint flow, Clint's \"approved\" means the whole checkpoint bundle is approved: LOG entry plus warranted memory docs/updates and MEMORY.md index pointers, unless he explicitly narrows the approval.\n6. After approval, use judgment for final memory wording/placement if needed, use mindstone_memory_write for every approved new/updated memory and index pointer, then use mindstone_log_append to append the approved LOG entry.\n7. Run /ms-recall-backfill or /ms-end-session so archive/embed reindexes the transcript and changed memory files.\n\nA checkpoint is not complete unless approved memory docs/index updates are written when warranted, LOG.md is appended, and archive/embed verification succeeds. Do not require a second approval round for memory writes after checkpoint-bundle approval. Target files: ${LOG_FILE} and ${MEMORY_DIR}.`
      );
    },
  });

  pi.registerCommand("ms-handoff", {
    description: "Draft a rich compaction handoff for .handoff.md",
    handler: async () => {
      pi.sendUserMessage(
        `Create a rich MindStone handoff for possible compaction. Capture current objective, open threads, files/projects touched, decisions made, active role state, immediate next actions, and anything post-compaction Slate would regret losing. Do not write files until approved. After approval, use mindstone_handoff_write to write ${HANDOFF_FILE}. Preserve the MS4CC .handoff.md structure; PreCompact will manage the ${RECENT_TAIL_MARKER} section.`
      );
    },
  });

  pi.registerCommand("ms-end-session", {
    description: "Archive the current Pi session and refresh recall before exit",
    handler: async (_args, ctx) => {
      const sessionFile = sessionFileFromContext(ctx);
      const archive = await archiveSessionFile(sessionFile);
      const tail = await refreshHandoffTail(sessionFile);
      const backfill = await runRecallScript("indexer.py", ["backfill"], 120_000);
      const status = await runRecallScript("recall_status.py", [], 20_000);
      const message = [
        "# MindStone end-session",
        archive.message,
        tail,
        "",
        "## Backfill",
        backfill.stdout?.trim(),
        backfill.stderr?.trim(),
        "",
        "## Recall status",
        status.stdout?.trim(),
        status.stderr?.trim(),
      ].filter(Boolean).join("\n");
      const success = backfill.code === 0 && status.code === 0;
      ctx.ui.notify(success ? "MindStone end-session archive/backfill finished" : "MindStone end-session degraded", success ? "info" : "warning");
      pi.sendMessage({ customType: "mindstone", content: message, display: true, details: { sessionFile, archive, backfillCode: backfill.code, statusCode: status.code } });
    },
  });

  pi.registerCommand("ms-recall-status", {
    description: "Show MindStone semantic recall/vector status",
    handler: async (_args, ctx) => {
      try {
        const result = await runRecallScript("recall_status.py", [], 20_000);
        const message = result.stdout?.trim() || result.stderr?.trim() || "No recall status output.";
        ctx.ui.notify(result.code === 0 ? "Recall status checked" : "Recall status degraded", result.code === 0 ? "info" : "warning");
        pi.sendMessage({ customType: "mindstone-recall", content: message, display: true, details: { code: result.code } });
      } catch (error: any) {
        ctx.ui.notify(`Recall status failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("ms-recall-backfill", {
    description: "Archive current Pi session, then backfill MindStone memory/transcript embeddings into vectors.db",
    handler: async (_args, ctx) => {
      try {
        const archive = await archiveSessionFile(sessionFileFromContext(ctx));
        const result = await runRecallScript("indexer.py", ["backfill"], 120_000);
        const message = [archive.message, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
        ctx.ui.notify(result.code === 0 ? "Recall backfill finished" : "Recall backfill failed/degraded", result.code === 0 ? "info" : "warning");
        pi.sendMessage({ customType: "mindstone-recall", content: message || "No backfill output.", display: true, details: { code: result.code, archive } });
      } catch (error: any) {
        ctx.ui.notify(`Recall backfill failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("ms-recall-search", {
    description: "Search MindStone semantic recall: /ms-recall-search <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /ms-recall-search <query>", "warning");
        return;
      }
      try {
        const result = await runRecallScript("recall.py", [query, "--k", "8"], 30_000);
        const message = result.stdout?.trim() || result.stderr?.trim() || "No recall output.";
        pi.sendMessage({ customType: "mindstone-recall", content: message, display: true, details: { code: result.code } });
      } catch (error: any) {
        ctx.ui.notify(`Recall search failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("act-as", {
    description: "Adopt a MindStone role structurally: /act-as <role>",
    getArgumentCompletions: (prefix) => {
      void prefix;
      return null;
    },
    handler: async (args, ctx) => {
      const roleName = args.trim().replace(/\.md$/, "");
      if (!roleName) {
        ctx.ui.notify("Usage: /act-as <role>", "warning");
        return;
      }
      const roleFile = await findRoleFile(roleName, ctx.cwd);
      if (!roleFile) {
        ctx.ui.notify(`Role not found: ${roleName}. Add ${join(ROLES_DIR, `${roleName}.md`)}`, "error");
        return;
      }
      activeRoleName = roleName;
      activeRoleStartedAt = new Date().toISOString();
      activeRoleContext = await readTextIfExists(roleFile);
      const message = `Acting as ${roleName}. Loaded role directive from ${roleFile}. Role adoption is structural, not theatrical; the active role will be included in MindStone context until /end-role.`;
      ctx.ui.notify(message, "info");
      pi.sendMessage({ customType: "mindstone-role", content: message, display: true, details: { roleName, roleFile } });
    },
  });

  pi.registerCommand("end-role", {
    description: "End the active MindStone role adoption and draft an attribution audit",
    handler: async () => {
      if (!activeRoleName) {
        pi.sendMessage({ customType: "mindstone-role", content: "No active role adoption.", display: true });
        return;
      }
      const roleName = activeRoleName;
      activeRoleName = undefined;
      activeRoleContext = "";
      const started = activeRoleStartedAt;
      activeRoleStartedAt = undefined;
      pi.sendUserMessage(
        `End role adoption for ${roleName}. Started at: ${started}. Draft an attribution audit with canonicals cited, artifacts produced, deviations/drift, and self-assessment. Do not write files unless the user approves appending the role span to ${LOG_FILE}.`
      );
    },
  });

  pi.registerTool({
    name: "mindstone_memory_read",
    label: "MindStone Memory Read",
    description: "Read a MindStone for Pi identity, user, log, role, or memory file by filename.",
    promptSnippet: "Read MindStone identity, user, log, role, or memory files",
    parameters: Type.Object({ name: Type.String({ description: "IDENTITY.md, USER.md, LOG.md, a memory filename, or roles/<role>.md" }) }),
    async execute(_toolCallId, params) {
      const requested = String(params.name);
      const safe = basename(requested);
      let target = "";
      if (safe === "IDENTITY.md") target = IDENTITY_FILE;
      else if (safe === "USER.md") target = USER_FILE;
      else if (safe === "LOG.md") target = LOG_FILE;
      else if (requested.startsWith("roles/")) target = join(ROLES_DIR, basename(requested));
      else target = join(MEMORY_DIR, safe);
      const text = await readTextIfExists(target);
      if (!text) throw new Error(`MindStone file not found or empty: ${requested}`);
      return { content: [{ type: "text", text: `# ${requested}\n\n${text}` }], details: { path: target } };
    },
  });

  pi.registerTool({
    name: "mindstone_log_append",
    label: "MindStone Log Append",
    description: "Append an approved MindStone checkpoint or role-span entry to LOG.md. Use only after explicit user approval.",
    promptSnippet: "Append approved MindStone checkpoint or role-span entries to LOG.md",
    promptGuidelines: [
      "Use mindstone_log_append only after the user explicitly approves the exact LOG.md entry to append.",
      "Do not use mindstone_log_append for drafts or unapproved memory edits.",
    ],
    parameters: Type.Object({ entry: Type.String({ description: "Approved Markdown entry to append to LOG.md" }) }),
    async execute(_toolCallId, params) {
      await mkdir(dirname(LOG_FILE), { recursive: true });
      const entry = String(params.entry).trimEnd();
      await appendFile(LOG_FILE, `${entry}\n\n`, "utf8");
      return { content: [{ type: "text", text: `Appended approved entry to ${LOG_FILE}` }], details: { path: LOG_FILE } };
    },
  });

  pi.registerTool({
    name: "mindstone_handoff_write",
    label: "MindStone Handoff Write",
    description: "Write an approved rich compaction handoff to transcripts/.handoff.md. Use only after explicit user approval.",
    promptSnippet: "Write approved MindStone rich handoff to .handoff.md",
    promptGuidelines: [
      "Use mindstone_handoff_write only after the user explicitly approves the handoff body.",
      "Preserve the MS4CC handoff structure. PreCompact manages the RECENT TAIL section.",
    ],
    parameters: Type.Object({ body: Type.String({ description: "Approved rich handoff Markdown body" }) }),
    async execute(_toolCallId, params) {
      await mkdir(TRANSCRIPTS_DIR, { recursive: true });
      const existing = await readTextIfExists(HANDOFF_FILE);
      const recentTail = existing.includes(RECENT_TAIL_MARKER) ? `\n\n${RECENT_TAIL_MARKER}${existing.split(RECENT_TAIL_MARKER, 2)[1]}` : "";
      const body = String(params.body).trimEnd();
      await writeFile(HANDOFF_FILE, `${body}${recentTail}\n`, "utf8");
      return { content: [{ type: "text", text: `Wrote approved handoff to ${HANDOFF_FILE}` }], details: { path: HANDOFF_FILE } };
    },
  });

  pi.registerTool({
    name: "mindstone_memory_write",
    label: "MindStone Memory Write",
    description: "Write an approved MindStone memory file and optionally update MEMORY.md. Use after explicit user approval or checkpoint-bundle approval.",
    promptSnippet: "Write approved MindStone memory files and MEMORY.md index pointers",
    promptGuidelines: [
      "Use mindstone_memory_write only after the user explicitly approves the memory body/update and index entry, or after a checkpoint-bundle approval that includes warranted memories.",
      "For /ms-checkpoint, one approval covers the approved LOG plus warranted memory/index writes unless the user explicitly narrows the approval.",
      "Do not use mindstone_memory_write for drafts or speculative memories.",
      "Before creating a new memory, search existing memories for duplicates and prefer updates when appropriate.",
      "Checkpoint is incomplete if warranted memory docs/index updates are skipped.",
    ],
    parameters: Type.Object({
      filename: Type.String({ description: "Memory markdown filename, e.g. project_example.md. Path separators are not allowed." }),
      body: Type.String({ description: "Approved full Markdown memory body with MS4CC frontmatter." }),
      indexEntry: Type.Optional(Type.String({ description: "Approved MEMORY.md bullet/pointer for this memory." })),
      overwrite: Type.Optional(Type.Boolean({ description: "Allow replacing an existing memory file. Default false." })),
    }),
    async execute(_toolCallId, params) {
      const filename = basename(String(params.filename));
      const body = String(params.body).trimEnd();
      validateMemoryMarkdown(filename, body);
      const target = join(MEMORY_DIR, filename);
      if (existsSync(target) && params.overwrite !== true) throw new Error(`Memory file already exists; set overwrite=true only with explicit approval: ${filename}`);
      await mkdir(MEMORY_DIR, { recursive: true });
      await writeFile(target, `${body}\n`, "utf8");
      if (params.indexEntry) await appendMemoryIndexEntry(String(params.indexEntry));
      return { content: [{ type: "text", text: `Wrote approved memory to ${target}${params.indexEntry ? ` and updated ${MEMORY_INDEX_FILE}` : ""}` }], details: { path: target, indexPath: params.indexEntry ? MEMORY_INDEX_FILE : undefined } };
    },
  });

  pi.registerTool({
    name: "mindstone_memory_search",
    label: "MindStone Memory Search",
    description: "Search MindStone for Pi memory files with simple text matching. Vector recall is planned for a later version.",
    promptSnippet: "Search MindStone memory files with simple text matching",
    parameters: Type.Object({ query: Type.String(), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(_toolCallId, params) {
      const query = String(params.query).toLowerCase();
      const terms = query.split(/\s+/).filter(Boolean);
      const count = Math.min(Math.max(Number(params.count ?? 5), 1), 20);
      const memories = await loadMemories();
      const ranked = memories
        .map((memory) => ({ memory, score: searchScore(terms, memory) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, count);
      if (!ranked.length) return { content: [{ type: "text", text: `No MindStone memories matched: ${params.query}` }], details: {} };
      const text = ranked
        .map(({ memory, score }, index) => `${index + 1}. ${memory.name} (score=${score})\n${memory.frontmatter.description ?? ""}\n${memory.body.slice(0, 800)}`)
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }], details: { results: ranked.map((r) => ({ path: r.memory.path, score: r.score })) } };
    },
  });
}
