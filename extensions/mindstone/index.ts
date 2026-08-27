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
const AUTONOMOUS_CHECKPOINT_FILE = join(ORCHESTRATOR_DIR, "config", "autonomous-checkpoint.enabled");
const RECENT_TAIL_MARKER = "## RECENT TAIL (since rich handoff)";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ONBOARDING_DIR = join(PACKAGE_ROOT, "onboarding");
const PACKAGE_HOOKS_DIR = join(PACKAGE_ROOT, "orchestrator", "hooks");
const PACKAGE_VENV_PYTHON = join(PACKAGE_ROOT, "orchestrator", ".venv", "bin", "python");

// 80,000 (~20k tokens). Chosen by measurement on the MS4CC reference store, not by
// feel: with the invariant split the always-inject block lands around 58k, which
// overflows 50k and fits 80k with headroom — and headroom matters because this
// degrades FASTER than it grows (a bigger store means more rules competing for a
// fixed budget, so coverage falls as the store rises).
//
// Override per install with MS4PI_CONTEXT_BUDGET_CHARS. Any store materially larger
// than the reference should set its own from measured utilisation rather than
// inheriting this number.
const CONTEXT_BUDGET_CHARS = 80_000;
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
  emergencyAutoHandoff: envBoolean("MS4PI_EMERGENCY_AUTO_HANDOFF", existsSync(AUTONOMOUS_CHECKPOINT_FILE)),
};

type Frontmatter = Record<string, string | number | boolean | string[] | null | undefined>;
type MemoryFile = { path: string; name: string; frontmatter: Frontmatter; body: string; text: string };

type HandoffSource = "compact" | "startup" | "resume";

let activeRoleName: string | undefined;
let activeRoleContext = "";
let activeRoleStartedAt: string | undefined;
let pendingHandoffSource: HandoffSource | undefined;
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

// Keys whose indented children are lifted into the flat namespace.
// Two frontmatter schemas are in circulation: flat (`critical: true` at column 0)
// and nested (`metadata:` / `  critical: true`). A parser anchored at column 0
// skips every indented line, so a nested `critical: true` was silently discarded
// and the memory never injected — while the index still listed it as always-loaded.
// MS4CC measured 63 of 291 files using the nested schema, FOUR of them critical.
const LIFTED_NESTED_KEYS = ["metadata"];

// `>` folds newlines to spaces, `|` keeps them; trailing `-`/`+` control chomping.
// Without this, `invariant: >` parses to the literal string ">" — a value that
// reports as PRESENT while carrying no rule, which is the exact false positive the
// invariant tier exists to eliminate.
const BLOCK_STYLES = [">", "|", ">-", "|-", ">+", "|+"];

function parseFrontmatter(text: string): { frontmatter: Frontmatter; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };

  const frontmatter: Frontmatter = {};
  const nested: Record<string, Frontmatter> = {};
  let currentNested: string | null = null;
  let block: { key: string; style: string; lines: string[] } | null = null;

  const closeBlock = () => {
    if (!block) return;
    const trimmed = block.lines.map((l) => l.trim());
    while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
    frontmatter[block.key] = block.style.startsWith("|")
      ? trimmed.join("\n").trim()
      : trimmed.filter(Boolean).join(" ").trim();
    block = null;
  };

  for (const line of match[1].split("\n")) {
    const indented = /^\s/.test(line);

    if (block) {
      if (indented || !line.trim()) { block.lines.push(line); continue; }
      closeBlock();
    }
    if (!line.trim()) continue;

    if (indented) {
      if (!currentNested) continue;
      const child = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!child) continue;
      nested[currentNested][child[1]] = parseScalar(child[2]);
      continue;
    }

    const parsed = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!parsed) { currentNested = null; continue; }
    const key = parsed[1];
    const raw = parsed[2].trim();

    if (BLOCK_STYLES.includes(raw)) {
      block = { key, style: raw, lines: [] };
      currentNested = null;
      continue;
    }

    frontmatter[key] = parseScalar(raw);
    if (raw === "") {
      currentNested = key;
      nested[key] = nested[key] ?? {};
    } else {
      currentNested = null;
    }
  }
  closeBlock();

  // Lift nested children. A top-level key always wins: an explicit `critical: false`
  // at column 0 is not overridden by a nested `critical: true`.
  for (const container of LIFTED_NESTED_KEYS) {
    const children = nested[container];
    if (!children) continue;
    for (const [k, v] of Object.entries(children)) {
      if (frontmatter[k] === undefined || frontmatter[k] === null) frontmatter[k] = v;
    }
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

// ---------------------------------------------------------------------------
// Admission — per item, by declared precedence, whole-or-not-at-all
// ---------------------------------------------------------------------------
// This replaces a positional trim that sliced the first overflowing part mid-text
// and then `break`-ed, dropping everything after it regardless of importance.
// Worse here than in MS4CC: every critical memory was concatenated into ONE part,
// so a single overflow lost the entire constitution at once.
//
// Tier numbers are a POLICY, stated here. The invariants outrank the index, and
// the index outranks full narrative bodies: knowing WHAT EXISTS is what makes a
// partial constitution recoverable, because an agent that can see a rule's name
// can go read the file. An agent missing the index does not know to look.
const TIER_HEADER = 5;
const TIER_IDENTITY = 10;   // required — an agent without identity is a different agent
const TIER_USER = 20;       // required
const TIER_INVARIANT = 25;  // the constitution: the binding rule of every critical
const TIER_INDEX = 30;      // what exists at all
const TIER_ROLE = 35;
const TIER_CRITICAL = 40;   // full narrative bodies — only if budget remains
const TIER_EVERGREEN = 50;  // pointers
const TIER_LOG = 70;

interface ContextItem {
  tier: number;
  text: string;
  label: string;
  required?: boolean;
  bullet?: boolean;
}

interface AssemblyReport {
  budget: number;
  used: number;
  invariantsTotal: number;
  invariantsAdmitted: number;
  missingInvariants: string[];
  indexPresent: boolean;
  bodiesTotal: number;
  bodiesAdmitted: number;
  deferred: number;
  constitutionComplete: boolean;
}

const SEP = "\n\n---\n\n";

function admit(items: ContextItem[], budget: number): { text: string; report: AssemblyReport } {
  const sorted = [...items].sort((a, b) => a.tier - b.tier);
  const admitted: ContextItem[] = [];
  const omitted: ContextItem[] = [];
  let used = 0;

  for (const item of sorted) {
    const cost = item.text.length + (admitted.length ? SEP.length : 0);
    if (item.required || used + cost <= budget) {
      admitted.push(item);
      used += cost;
    } else {
      omitted.push(item);
    }
  }

  const invTotal = items.filter((i) => i.tier === TIER_INVARIANT).length;
  const invOk = admitted.filter((i) => i.tier === TIER_INVARIANT).length;
  const missingInvariants = omitted.filter((i) => i.tier === TIER_INVARIANT).map((i) => i.label);
  const indexPresent = !omitted.some((i) => i.tier === TIER_INDEX);

  const report: AssemblyReport = {
    budget,
    used,
    invariantsTotal: invTotal,
    invariantsAdmitted: invOk,
    missingInvariants,
    indexPresent,
    bodiesTotal: items.filter((i) => i.tier === TIER_CRITICAL).length,
    bodiesAdmitted: admitted.filter((i) => i.tier === TIER_CRITICAL).length,
    deferred: omitted.length,
    constitutionComplete: missingInvariants.length === 0 && indexPresent,
  };

  const HEADINGS: Record<number, string> = {
    [TIER_INVARIANT]:
      "## CONSTITUTION (binding rules — always applied)\n" +
      "_Each line is the rule itself. The incident that earned it lives in the named file and is retrievable._",
    [TIER_CRITICAL]:
      "## CRITICAL MEMORIES (full text — the narrative behind the rules above)\n" +
      "_Present only as budget allowed. Absence here is not absence of the rule._",
  };

  // Bullets accumulate into one block so the constitution reads as a single list
  // rather than N sections separated by horizontal rules.
  const parts: string[] = [];
  let group: string[] = [];
  const seen = new Set<number>();
  const flush = () => { if (group.length) { parts.push(group.join("\n")); group = []; } };

  for (const item of admitted) {
    if (HEADINGS[item.tier] && !seen.has(item.tier)) { flush(); parts.push(HEADINGS[item.tier]); }
    seen.add(item.tier);
    if (item.bullet) group.push(item.text);
    else { flush(); parts.push(item.text); }
  }
  flush();

  let text = parts.join(SEP);

  // Loud only where it can act. Assembly NEVER aborts: a session that boots with a
  // partial constitution can compensate; one that boots empty cannot, and cannot
  // even read the error, because the error is in the thing that failed to load.
  if (missingInvariants.length || !indexPresent) {
    const names = missingInvariants.slice(0, 12).map((n) => `\`${n}\``).join(", ");
    const more = missingInvariants.length > 12 ? ` (+${missingInvariants.length - 12} more)` : "";
    const lines = [`## ⚠ INCOMPLETE CONSTITUTION — ${missingInvariants.length} binding rule(s) did not fit the ${budget.toLocaleString()}-char budget`];
    if (missingInvariants.length) {
      lines.push(`**RULES NOT LOADED:** ${names}${more}`);
      lines.push("Read them from the memory directory before acting on anything they cover, and say so rather than guessing.");
    }
    if (!indexPresent) lines.push("**The memory index did not load** — I cannot see what else exists.");
    text = lines.join("\n") + "\n" + SEP + text;
  } else if (omitted.length) {
    text =
      `## Context note — constitution complete, ${omitted.length} narrative item(s) deferred\n` +
      `All ${invTotal} binding rules are loaded above. ${report.bodiesAdmitted} of ${report.bodiesTotal} full narratives fit; ` +
      `the rest remain on disk and retrievable. Nothing was cut mid-file.\n` +
      SEP + text;
  }

  return { text, report };
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

export let lastAssembly: AssemblyReport | null = null;

async function buildMindStoneContext(cwd: string): Promise<string> {
  const items: ContextItem[] = [];
  const identity = await readTextIfExists(IDENTITY_FILE);
  const user = await readTextIfExists(USER_FILE);
  const log = await readTextIfExists(LOG_FILE);
  const memories = await loadMemories();

  const add = (tier: number, text: string, label: string, opts: { required?: boolean; bullet?: boolean } = {}) => {
    if (text && text.trim()) items.push({ tier, text: text.trim(), label, ...opts });
  };

  add(TIER_HEADER, `# MindStone for Pi\n\nData root: ${DATA_ROOT}\nCurrent working directory: ${cwd}`, "header", { required: true });

  // Identity and user are REQUIRED — admitted even if they exceed the budget on
  // their own. An agent without its identity is not a degraded agent, it is a
  // different one. The overage is reported rather than silently absorbed.
  if (identity) {
    add(TIER_IDENTITY, `## IDENTITY\n${identity}`, "IDENTITY", { required: true });
  } else {
    add(TIER_IDENTITY,
      `## FIRST-RUN / STATELESS MODE\nNo MindStone identity exists yet at ${IDENTITY_FILE}. Run /ms-init, then /ms-onboard if the user wants persistent identity. Until then, do not claim persistent identity or memory continuity.`,
      "FIRST-RUN", { required: true });
  }
  if (user) add(TIER_USER, `## USER\n${user}`, "USER", { required: true });

  // Critical memories inject in TWO tiers: the binding rule always, the narrative
  // only if room remains. A file with no invariant falls back to full body AT the
  // invariant tier — it is unmigrated, not exempt, and dropping it silently would
  // be the failure this design exists to prevent.
  const critical = memories.filter((m) => hasFlag(m.frontmatter, "critical") && m.name !== "MEMORY.md");
  for (const m of critical) {
    const invariant = typeof m.frontmatter.invariant === "string" ? m.frontmatter.invariant.trim() : "";
    const desc = typeof m.frontmatter.description === "string" ? m.frontmatter.description : m.name;
    if (invariant) {
      add(TIER_INVARIANT, `- **\`${m.name}\`** — ${invariant}`, m.name, { bullet: true });
      add(TIER_CRITICAL, `### ${m.name} — ${desc}\n${m.body.trim()}`, m.name);
    } else {
      add(TIER_INVARIANT, `### ${m.name} — ${desc}\n${m.body.trim()}`, m.name);
    }
  }

  // The memory index — previously not injected at ALL on this branch, so the agent
  // had no map of its own store and could not tell "I have no memory of that" from
  // "I cannot see my memory".
  const indexText = await readTextIfExists(join(MEMORY_DIR, "MEMORY.md"));
  if (indexText) add(TIER_INDEX, `## MEMORY INDEX (all available memories)\n${indexText}`, "MEMORY INDEX");

  const evergreen = memories.filter((m) => !hasFlag(m.frontmatter, "critical") && hasFlag(m.frontmatter, "evergreen"));
  if (evergreen.length > 0) {
    add(TIER_EVERGREEN,
      ["## EVERGREEN MEMORY POINTERS", ...evergreen.map((m) => `- ${m.name}${m.frontmatter.description ? ` — ${m.frontmatter.description}` : ""}`)].join("\n"),
      "EVERGREEN");
  }

  if (activeRoleName && activeRoleContext) {
    add(TIER_ROLE, `## ACTIVE ROLE ADOPTION: ${activeRoleName}\nStarted: ${activeRoleStartedAt}\n\n${activeRoleContext}`, "ROLE");
  }
  if (log) add(TIER_LOG, `## RECENT LOG TAIL\n${tailLines(log, LOG_TAIL_LINES)}`, "LOG");

  const budget = envNumber("MS4PI_CONTEXT_BUDGET_CHARS", CONTEXT_BUDGET_CHARS, 1_000, 500_000);
  const { text, report } = admit(items, budget);
  lastAssembly = report;

  if (!report.constitutionComplete) {
    console.error(
      `[mindstone] CONSTITUTION INCOMPLETE: ${report.missingInvariants.length} invariant(s) omitted at ` +
      `${budget} chars (${report.used} used)${report.indexPresent ? "" : "; index dropped"}.`
    );
  }

  return `<mindstone-context>\n${text}\n</mindstone-context>`;
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
  "<session-handoff",
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

async function handoffBlock(source: HandoffSource): Promise<string> {
  const handoff = await readTextIfExists(HANDOFF_FILE);
  if (!handoff.trim()) return "";

  const framing =
    source === "compact"
      ? "You just compacted or requested a handoff replay. Read this handoff first before relying on the lossy compaction summary."
      : "This session started with an existing MindStone handoff. If you are continuing the prior work, use this handoff as the first-action/resume pointer. If the current request is unrelated, note the handoff briefly and proceed with the user's current task.";

  return `<session-handoff source="${source}" priority="CRITICAL">\n${framing}\nFull file: ${HANDOFF_FILE}\n\n${handoff.trim()}\n</session-handoff>`;
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
  pi.on("session_start", async (event, ctx) => {
    const initialized = existsSync(ORCHESTRATOR_DIR);
    const hasIdentity = existsSync(IDENTITY_FILE);
    if (event.reason === "startup" || event.reason === "resume") {
      pendingHandoffSource = event.reason;
    }
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

    const approvalMode = COMPACTION_POLICY.emergencyAutoHandoff
      ? "Autonomous checkpoint/handoff mode is enabled by local config or MS4PI_EMERGENCY_AUTO_HANDOFF. Clint has delegated standing authority for continuity-preserving checkpoint, memory, handoff, archive, and backfill writes when context pressure requires them. Do not wait for a separate approval before writing the continuity bundle; report what was written afterward."
      : "Approval-gated mode is enabled. Do not write LOG.md, memory files, MEMORY.md, or .handoff.md until Clint approves the checkpoint/handoff bundle.";

    pi.sendUserMessage(
      `MindStone context watchdog fired.\n\n${policyLines.join("\n")}\n\nMechanical safety work already attempted:\n- ${archive.message}\n- ${tail}\n\nCreate a combined MindStone checkpoint and rich compaction handoff now. Preserve MS4CC structure. ${approvalMode}\n\nRequired outputs:\n1. A LOG.md checkpoint with title/date, scope, what happened, decisions made, memories cited, prevented confirmations, new memories proposed, drift flagged, and lint.\n2. Warranted memory docs/updates and MEMORY.md pointers when durable facts/design decisions would otherwise be lost.\n3. A rich .handoff.md body with current objective, open threads, files/projects touched, decisions made, active role state, immediate next actions, and anything post-compaction Slate would regret losing.\n4. Archive/embed verification via /ms-recall-backfill, /ms-end-session, or equivalent indexer/status commands.\n\nA checkpoint without warranted memory/index updates, LOG append, handoff write, and archive/embed verification is not complete.${nearCompactTarget ? "\n\nContext is already at or past the configured compaction target. After continuity writes and archive/embed verification, recommend immediate compaction or allow Pi auto-compaction to proceed." : ""}`
    );
  }

  pi.on("before_agent_start", async (event, ctx) => {
    const mindstone = await buildMindStoneContext(ctx.cwd);
    const recall = await semanticRecallBlock(event.prompt ?? "");
    const handoffSource = pendingHandoffSource;
    const handoff = handoffSource ? await handoffBlock(handoffSource) : "";
    pendingHandoffSource = undefined;
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
    pendingHandoffSource = "compact";
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
