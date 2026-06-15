import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ONBOARDING_DIR = join(PACKAGE_ROOT, "onboarding");
const PACKAGE_HOOKS_DIR = join(PACKAGE_ROOT, "orchestrator", "hooks");
const PACKAGE_VENV_PYTHON = join(PACKAGE_ROOT, "orchestrator", ".venv", "bin", "python");

const CONTEXT_BUDGET_CHARS = 50_000;
const LOG_TAIL_LINES = 60;

type Frontmatter = Record<string, string | number | boolean | string[] | null | undefined>;
type MemoryFile = { path: string; name: string; frontmatter: Frontmatter; body: string; text: string };

let activeRoleName: string | undefined;
let activeRoleContext = "";
let activeRoleStartedAt: string | undefined;

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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const initialized = existsSync(ORCHESTRATOR_DIR);
    const hasIdentity = existsSync(IDENTITY_FILE);
    if (!initialized) ctx.ui.notify("MindStone for Pi: run /ms-init to initialize.", "info");
    else if (!hasIdentity) ctx.ui.notify("MindStone for Pi: initialized but no identity. Run /ms-onboard for fresh onboarding.", "info");
    else ctx.ui.notify("MindStone for Pi identity loaded.", "info");
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

  pi.on("before_agent_start", async (event, ctx) => {
    const mindstone = await buildMindStoneContext(ctx.cwd);
    const recall = await semanticRecallBlock(event.prompt ?? "");
    return { systemPrompt: `${event.systemPrompt}\n\n${mindstone}${recall ? `\n\n${recall}` : ""}` };
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    ctx.ui.notify("MindStone for Pi: consider /ms-checkpoint before compaction.", "warning");
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

      pi.sendMessage({
        customType: "mindstone",
        content: `MindStone onboarding files already exist:\n- ${IDENTITY_FILE}\n- ${USER_FILE}\n\nUse /ms-status or /ms-context to inspect current state.`,
        display: true,
      });
    },
  });

  pi.registerCommand("ms-status", {
    description: "Show MindStone for Pi status",
    handler: async (_args, ctx) => {
      const memories = await loadMemories();
      const roles = await listRoleNames();
      const lines = [
        `Data root: ${DATA_ROOT}`,
        `Orchestrator dir: ${ORCHESTRATOR_DIR}`,
        `Identity: ${existsSync(IDENTITY_FILE) ? "present" : "missing"}`,
        `User: ${existsSync(USER_FILE) ? "present" : "missing"}`,
        `Log: ${existsSync(LOG_FILE) ? "present" : "missing"}`,
        `Memory files: ${memories.length}`,
        `Roles: ${roles.length}${roles.length ? ` (${roles.join(", ")})` : ""}`,
        `Active role: ${activeRoleName ?? "none"}`,
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

  pi.registerCommand("ms-checkpoint", {
    description: "Draft a MindStone checkpoint entry for approval",
    handler: async () => {
      pi.sendUserMessage(
        `Run a MindStone for Pi checkpoint using the MS4CC checkpoint structure. Draft a concise LOG.md entry with title/date, scope, what happened, decisions made, memories cited, prevented confirmations, new memories proposed, drift flagged, and lint. Do not write files yet. Ask for approval before appending to ${LOG_FILE}. After approval, run /ms-recall-backfill so memory/transcript embeddings are refreshed. A checkpoint without archive/embed verification is not complete.`
      );
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
    description: "Backfill MindStone memory/transcript embeddings into vectors.db",
    handler: async (_args, ctx) => {
      try {
        const result = await runRecallScript("indexer.py", ["backfill"], 120_000);
        const message = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
        ctx.ui.notify(result.code === 0 ? "Recall backfill finished" : "Recall backfill failed/degraded", result.code === 0 ? "info" : "warning");
        pi.sendMessage({ customType: "mindstone-recall", content: message || "No backfill output.", display: true, details: { code: result.code } });
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
