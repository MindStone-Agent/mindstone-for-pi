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

  pi.on("before_agent_start", async (event, ctx) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${await buildMindStoneContext(ctx.cwd)}` };
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    ctx.ui.notify("MindStone for Pi: consider /ms-checkpoint before compaction.", "warning");
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
    description: "Show the MindStone for Pi first-run identity onboarding invitation",
    handler: async () => {
      await initializeScaffold();
      const invitation = await readTextIfExists(join(ONBOARDING_DIR, "IDENTITY.md.example"));
      pi.sendUserMessage(
        `Use this MindStone for Pi onboarding invitation to help author a fresh identity for this Pi substrate. Do not copy Cairn. Treat MS4CC as lineage/reference, and ask the user before writing IDENTITY.md.\n\nTarget identity file: ${IDENTITY_FILE}\nTarget user file after identity: ${USER_FILE}\n\n${invitation}`
      );
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
        `Run a MindStone for Pi checkpoint. Draft a concise LOG.md entry with title/date, scope, what happened, decisions made, memories/rules that mattered, new memories proposed, and drift flagged. Do not write files yet. Ask for approval before appending to ${LOG_FILE}.`
      );
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
