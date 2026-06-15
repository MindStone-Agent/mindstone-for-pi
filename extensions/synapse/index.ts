import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.HOME ?? process.cwd();
const DATA_ROOT = process.env.MINDSTONE_PI_ROOT ?? join(HOME, ".pi", "agent", "mindstone");
const ORCHESTRATOR_DIR = join(DATA_ROOT, "orchestrator");
const CONFIG_DIR = join(ORCHESTRATOR_DIR, "config");
const CONFIG_FILE = join(CONFIG_DIR, "synapse.toml");
const HOME_SYNAPSE = join(HOME, ".synapse");

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_VENV_PYTHON = join(PACKAGE_ROOT, "orchestrator", ".venv", "bin", "python");

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_HANDLE = "slate";
const DEFAULT_CHANNELS = "family-ops,devops";

type SynapseConfig = {
  baseUrl: string;
  handle: string;
  channels: string[];
  mentionsOnly: boolean;
};

type SynapseLine = {
  channel?: string;
  sender_handle?: string;
  sender_kind?: string;
  created_at?: string;
  body?: string;
  mentioned_handles?: string[];
  info?: string;
  error?: string;
};

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function parseList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseConfig(text: string): SynapseConfig | undefined {
  if (!text.trim()) return undefined;
  const baseUrl = text.match(/^base_url\s*=\s*["']([^"']+)["']/m)?.[1]?.replace(/\/$/, "") ?? DEFAULT_BASE_URL;
  const handle = text.match(/^handle\s*=\s*["']([^"']+)["']/m)?.[1] ?? DEFAULT_HANDLE;
  const channelsRaw = text.match(/^channels\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
  const channels = channelsRaw.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const mentions = text.match(/^mentions_only\s*=\s*(true|false)\s*$/m)?.[1];
  return { baseUrl, handle, channels, mentionsOnly: mentions !== "false" };
}

async function loadConfig(): Promise<SynapseConfig | undefined> {
  return parseConfig(await readTextIfExists(CONFIG_FILE));
}

function tokenPath(handle: string): string {
  return join(HOME_SYNAPSE, `${handle}.token`);
}

function activeFlagPath(handle: string): string {
  return join(HOME_SYNAPSE, `${handle}.active`);
}

async function validateToken(baseUrl: string, token: string, signal?: AbortSignal): Promise<{ handle?: string; kind?: string }> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/auth/me`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Synapse auth failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
  }
  return await response.json() as { handle?: string; kind?: string };
}

async function writeConfig(cfg: SynapseConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const channels = cfg.channels.map((c) => `"${c.replace(/"/g, "\\\"")}"`).join(", ");
  const content = `# Synapse client config for MindStone for Pi.\n# Token is NOT stored here; it lives at ~/.synapse/<handle>.token (mode 600).\n\n[synapse]\nbase_url = "${cfg.baseUrl}"\nhandle = "${cfg.handle}"\nchannels = [${channels}]\nlimit_per_channel = 20\nfresh_session_seconds = 43200\nhttp_timeout = 5\n\n[synapse.digest]\nmentions_only = ${cfg.mentionsOnly ? "true" : "false"}\n`;
  await writeFile(CONFIG_FILE, content, "utf8");
}

async function writeToken(handle: string, token: string): Promise<void> {
  await mkdir(HOME_SYNAPSE, { recursive: true, mode: 0o700 });
  await chmod(HOME_SYNAPSE, 0o700).catch(() => undefined);
  const path = tokenPath(handle);
  await writeFile(path, token.trim(), "utf8");
  await chmod(path, 0o600).catch(() => undefined);
}

function pythonBin(): string {
  return existsSync(PACKAGE_VENV_PYTHON) ? PACKAGE_VENV_PYTHON : "python3";
}

async function runSynapse(pi: ExtensionAPI, args: string[], timeout = 30_000) {
  return pi.exec(
    "env",
    [`MS4PI_ORCHESTRATOR_DIR=${ORCHESTRATOR_DIR}`, pythonBin(), "-m", "orchestrator.integrations.synapse", ...args],
    { cwd: PACKAGE_ROOT, timeout }
  );
}

function parseJsonLines(stdout: string | undefined): SynapseLine[] {
  const lines = (stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: SynapseLine[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch {
      // CLI status/check output is human text; fetch output should be JSON lines.
    }
  }
  return out;
}

function renderDigest(title: string, rows: SynapseLine[]): string {
  const messages = rows.filter((row) => row.body && row.channel && row.sender_handle);
  const errors = rows.filter((row) => row.error);
  if (!messages.length && !errors.length) return "";

  const byChannel = new Map<string, SynapseLine[]>();
  for (const msg of messages) {
    const channel = msg.channel ?? "unknown";
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), msg]);
  }

  const blocks: string[] = [];
  for (const [channel, channelRows] of byChannel) {
    const lines = [`## #${channel}`];
    for (const row of channelRows) {
      lines.push(`- [${row.created_at ?? "unknown time"}] **${row.sender_handle}**: ${row.body}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (errors.length) {
    blocks.push(["## Fetch errors", ...errors.map((row) => `- ${row.channel ?? "unknown"}: ${row.error}`)].join("\n"));
  }

  return `<synapse-digest>\n# ${title}\n\n${blocks.join("\n\n")}\n</synapse-digest>`;
}

async function fetchDigest(pi: ExtensionAPI, title: string, mentionsOnly: boolean, verbose = false): Promise<string> {
  const args = ["fetch", "--advance-cursor"];
  if (mentionsOnly) args.push("--mentions-only");
  if (verbose) args.push("--verbose");
  const result = await runSynapse(pi, args, 30_000);
  if (result.code !== 0) return "";
  return renderDigest(title, parseJsonLines(result.stdout));
}

function parsePostArgs(args: string): { channel: string; body: string } | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^(?:#)?([^\s]+)\s+([\s\S]+)$/);
  if (!match) return undefined;
  return { channel: match[1], body: match[2].trim() };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const cfg = await loadConfig();
    if (!cfg) return;
    const active = existsSync(activeFlagPath(cfg.handle));
    ctx.ui.setStatus("synapse", active ? `synapse:@${cfg.handle}` : "synapse:off");
    if (!active) return;
    const digest = await fetchDigest(pi, "Synapse — unread mentions while you were away", true, false).catch(() => "");
    if (digest) pi.sendMessage({ customType: "synapse-digest", content: digest, display: true });
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    const cfg = await loadConfig();
    if (!cfg || !existsSync(activeFlagPath(cfg.handle))) return;
    const digest = await fetchDigest(pi, "Synapse — new messages since last turn", cfg.mentionsOnly, false).catch(() => "");
    if (!digest) return;
    return { message: { customType: "synapse-digest", content: digest, display: true } };
  });

  pi.registerCommand("synapse-setup", {
    description: "Configure Synapse for this Pi/MindStone instance",
    handler: async (_args, ctx) => {
      const existing = await loadConfig();
      const baseUrl = await ctx.ui.input("Synapse base URL", existing?.baseUrl ?? DEFAULT_BASE_URL);
      if (!baseUrl) return;
      const handle = await ctx.ui.input("Agent handle", existing?.handle ?? DEFAULT_HANDLE);
      if (!handle) return;
      const channelsRaw = await ctx.ui.input("Channels to watch (comma-separated; blank = all memberships)", existing?.channels.join(",") || DEFAULT_CHANNELS);
      if (channelsRaw === undefined) return;
      const mentionsChoice = await ctx.ui.select("Per-turn digest scope", ["mentions only", "all channel traffic"]);
      if (!mentionsChoice) return;
      const token = await ctx.ui.input(`Bearer token for ${handle}`, "paste token here");
      if (!token || token === "paste token here") {
        ctx.ui.notify("Synapse setup cancelled: no token supplied", "warning");
        return;
      }

      try {
        const me = await validateToken(baseUrl, token, ctx.signal);
        const actualHandle = String(me.handle ?? handle);
        if (actualHandle !== handle) {
          const ok = await ctx.ui.confirm("Handle mismatch", `Token authenticates as ${actualHandle}, not ${handle}. Use ${actualHandle}?`);
          if (!ok) return;
        }
        const cfg: SynapseConfig = {
          baseUrl: baseUrl.replace(/\/$/, ""),
          handle: actualHandle,
          channels: parseList(channelsRaw),
          mentionsOnly: mentionsChoice === "mentions only",
        };
        await writeConfig(cfg);
        await writeToken(cfg.handle, token);
        ctx.ui.notify(`Synapse configured for @${cfg.handle}`, "info");
        pi.sendMessage({ customType: "synapse", content: `Synapse configured for @${cfg.handle} (${me.kind ?? "unknown kind"}). Config: ${CONFIG_FILE}. Token: ~/.synapse/${cfg.handle}.token`, display: true });
      } catch (error: any) {
        ctx.ui.notify(`Synapse setup failed: ${error?.message ?? error}`, "error");
      }
    },
  });

  pi.registerCommand("synapse-status", {
    description: "Show Synapse client config, connection state, and cursor",
    handler: async (_args, ctx) => {
      const result = await runSynapse(pi, ["status"], 20_000);
      const message = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "No status output.";
      ctx.ui.notify(result.code === 0 ? "Synapse status checked" : "Synapse status degraded", result.code === 0 ? "info" : "warning");
      pi.sendMessage({ customType: "synapse", content: message, display: true, details: { code: result.code } });
    },
  });

  pi.registerCommand("synapse-activate", {
    description: "Activate Synapse mention surfacing in this Pi session",
    handler: async (_args, ctx) => {
      const cfg = await loadConfig();
      const activate = await runSynapse(pi, ["activate"], 20_000);
      if (activate.code !== 0) {
        ctx.ui.notify("Synapse activation failed", "error");
        pi.sendMessage({ customType: "synapse", content: [activate.stdout?.trim(), activate.stderr?.trim()].filter(Boolean).join("\n"), display: true, details: { code: activate.code } });
        return;
      }
      ctx.ui.setStatus("synapse", cfg ? `synapse:@${cfg.handle}` : "synapse:on");
      const digest = await fetchDigest(pi, "Synapse — unread mentions", true, true);
      pi.sendMessage({ customType: "synapse", content: [activate.stdout?.trim(), digest || "No unread mentions."].filter(Boolean).join("\n\n"), display: true });
    },
  });

  pi.registerCommand("synapse-deactivate", {
    description: "Deactivate Synapse mention surfacing",
    handler: async (_args, ctx) => {
      const result = await runSynapse(pi, ["deactivate"], 20_000);
      ctx.ui.setStatus("synapse", "synapse:off");
      pi.sendMessage({ customType: "synapse", content: [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "Synapse deactivated.", display: true, details: { code: result.code } });
    },
  });

  pi.registerCommand("synapse-check", {
    description: "Show recent Synapse messages: /synapse-check [channel]",
    handler: async (args, ctx) => {
      const argv = ["check", "--limit", "20"];
      const channel = args.trim().replace(/^#/, "");
      if (channel) argv.push("--channel", channel);
      const result = await runSynapse(pi, argv, 20_000);
      const message = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "No messages.";
      ctx.ui.notify(result.code === 0 ? "Synapse checked" : "Synapse check failed", result.code === 0 ? "info" : "warning");
      pi.sendMessage({ customType: "synapse", content: message, display: true, details: { code: result.code } });
    },
  });

  pi.registerCommand("synapse-post", {
    description: "Post a Synapse message: /synapse-post <channel> <body>",
    handler: async (args, ctx) => {
      const parsed = parsePostArgs(args);
      if (!parsed) {
        ctx.ui.notify("Usage: /synapse-post <channel> <body>", "warning");
        return;
      }
      const result = await runSynapse(pi, ["post", "--channel", parsed.channel, "--body", parsed.body], 30_000);
      const message = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "No post output.";
      ctx.ui.notify(result.code === 0 ? `Posted to #${parsed.channel}` : "Synapse post failed", result.code === 0 ? "info" : "error");
      pi.sendMessage({ customType: "synapse", content: message, display: true, details: { code: result.code, channel: parsed.channel } });
    },
  });

  pi.registerCommand("synapse-watch", {
    description: "One-shot Synapse poll for this Pi session",
    handler: async (_args, ctx) => {
      const cfg = await loadConfig();
      if (!cfg) {
        ctx.ui.notify("Synapse not configured; run /synapse-setup", "warning");
        return;
      }
      const activate = existsSync(activeFlagPath(cfg.handle)) ? undefined : await runSynapse(pi, ["activate"], 20_000);
      if (activate && activate.code !== 0) {
        pi.sendMessage({ customType: "synapse", content: [activate.stdout?.trim(), activate.stderr?.trim()].filter(Boolean).join("\n"), display: true, details: { code: activate.code } });
        return;
      }
      const digest = await fetchDigest(pi, "Synapse — watch poll", cfg.mentionsOnly, true);
      pi.sendMessage({ customType: "synapse", content: digest || "Synapse watch: no new messages. Pi v1 watch is one-shot; invoke again or use a future scheduler when available.", display: true });
    },
  });

  pi.registerTool({
    name: "synapse_post",
    label: "Synapse Post",
    description: "Post a message to a configured Synapse channel.",
    promptSnippet: "Post messages to Synapse channels for cross-agent communication",
    promptGuidelines: [
      "Use synapse_post only when Clint asks you to contact another agent, or when replying to a Synapse mention is clearly within scope.",
      "Do not post private USER.md content, credentials, or sensitive local context to Synapse unless Clint explicitly authorizes it.",
    ],
    parameters: Type.Object({ channel: Type.String(), body: Type.String() }),
    async execute(_toolCallId, params) {
      const result = await runSynapse(pi, ["post", "--channel", String(params.channel).replace(/^#/, ""), "--body", String(params.body)], 30_000);
      const text = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "No post output.";
      return { content: [{ type: "text", text }], details: { code: result.code, channel: params.channel } };
    },
  });

  pi.registerTool({
    name: "synapse_check",
    label: "Synapse Check",
    description: "Read recent messages from a configured Synapse channel.",
    promptSnippet: "Read recent Synapse channel messages",
    promptGuidelines: ["Use synapse_check when Clint asks what other agents or humans have said on Synapse."],
    parameters: Type.Object({ channel: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_toolCallId, params) {
      const argv = ["check", "--limit", String(Math.min(Math.max(Number(params.limit ?? 20), 1), 100))];
      if (params.channel) argv.push("--channel", String(params.channel).replace(/^#/, ""));
      const result = await runSynapse(pi, argv, 30_000);
      const text = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "No messages.";
      return { content: [{ type: "text", text }], details: { code: result.code } };
    },
  });

  pi.registerTool({
    name: "synapse_await",
    label: "Synapse Await",
    description: "Wait for a matching Synapse message on a channel.",
    promptSnippet: "Await a matching Synapse reply from another agent",
    promptGuidelines: ["Use synapse_await after posting a question to another agent when Clint wants you to wait for the reply."],
    parameters: Type.Object({
      channel: Type.String(),
      mention: Type.Optional(Type.String()),
      from: Type.Optional(Type.String()),
      body_contains: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    }),
    async execute(_toolCallId, params) {
      const argv = ["await", "--channel", String(params.channel).replace(/^#/, ""), "--timeout", String(Math.min(Math.max(Number(params.timeout ?? 180), 1), 600)), "--json"];
      if (params.mention) argv.push("--mention", String(params.mention).replace(/^@/, ""));
      if (params.from) argv.push("--from", String(params.from).replace(/^@/, ""));
      if (params.body_contains) argv.push("--body-contains", String(params.body_contains));
      const result = await runSynapse(pi, argv, Math.min(Math.max(Number(params.timeout ?? 180), 1), 600) * 1000 + 10_000);
      const text = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") || "No await output.";
      return { content: [{ type: "text", text }], details: { code: result.code } };
    },
  });
}
