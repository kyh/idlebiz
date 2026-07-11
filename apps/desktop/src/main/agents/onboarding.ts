import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { z } from "zod";
import { RUNNERS } from "@repo/agent-driver/registry";
import { runnerBin } from "@repo/agent-driver/runner";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { agentDriver } from "@/main/agents/agent-driver";
import { businessTypeById } from "@/shared/domain";
import type { AgentRunner, BusinessTypeId } from "@/shared/domain";

// ---------------------------------------------------------------------------
// First-run onboarding backend. The workforce runs on the player's own coding
// CLIs (claude / codex): detect them, install one if none exist, walk their
// login flows, and cast the founding team with a one-shot CLI call.
// ---------------------------------------------------------------------------

export type AuthFlowEvent =
  | { type: "url"; url: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

let setupRunning = false;

const CLAUDE_INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";

/** Spawn a command, streaming its output lines as progress (URLs get their own event). */
function streamCommand(
  cmd: string,
  args: string[],
  emit: (e: AuthFlowEvent) => void,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onLine = (line: string): void => {
      const text = line.trim();
      if (!text) return;
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      if (url) emit({ type: "url", url });
      else emit({ type: "progress", message: text.slice(0, 200) });
    };
    if (child.stdout) createInterface({ input: child.stdout }).on("line", onLine);
    if (child.stderr) createInterface({ input: child.stderr }).on("line", onLine);
    child.on("error", (err) => {
      emit({ type: "error", message: err.message });
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
}

const label = (p: RunnerProbe): string => RUNNERS[p.id].displayName;

/**
 * The guided workforce setup: probe CLIs → install one if none → log in the
 * ones that need it → re-probe. Events stream to the onboarding dialog.
 */
export async function startLogin(emit: (e: AuthFlowEvent) => void): Promise<void> {
  if (setupRunning) {
    emit({ type: "progress", message: "Setup already in progress…" });
    return;
  }
  setupRunning = true;
  try {
    let probes = await agentDriver.refresh();
    for (const p of probes) {
      emit({
        type: "progress",
        message: p.installed
          ? `Found ${label(p)} (${p.version ?? "unknown version"})${p.authed ? " — signed in ✓" : " — not signed in"}`
          : `${label(p)} not installed`,
      });
    }

    if (probes.every((p) => !p.installed)) {
      emit({ type: "progress", message: "No coding CLI found — installing Claude Code…" });
      const code = await streamCommand("bash", ["-lc", CLAUDE_INSTALL_CMD], emit);
      if (code !== 0) {
        emit({
          type: "error",
          message: "Install failed — install Claude Code or Codex manually, then retry.",
        });
        return;
      }
      emit({ type: "progress", message: "Claude Code installed." });
      probes = await agentDriver.refresh();
    }

    for (const p of probes) {
      if (!p.installed || p.authed) continue;
      emit({ type: "progress", message: `Signing in to ${label(p)} — your browser will open…` });
      const code = await streamCommand(p.bin, RUNNERS[p.id].loginArgs, emit);
      if (code !== 0) {
        emit({
          type: "progress",
          message: `Couldn't finish automatically. In a terminal, run: ${p.bin} ${RUNNERS[p.id].loginArgs.join(" ")} — then come back and retry.`,
        });
      }
    }

    probes = await agentDriver.refresh();
    const ready = probes.filter((p) => p.installed && p.authed);
    if (ready.length > 0) {
      emit({ type: "progress", message: `Workforce ready: ${ready.map(label).join(" + ")}.` });
      emit({ type: "done" });
    } else {
      emit({
        type: "error",
        message: "No signed-in coding CLI yet. Sign in to Claude Code or Codex, then retry.",
      });
    }
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    setupRunning = false;
  }
}

// ---- LLM-generated founding team -------------------------------------------

interface HireCandidate {
  name: string;
  role: string;
  title: string;
  persona: string;
  blurb: string;
}

const CandidateSchema = z.object({
  name: z.string().min(1).max(40),
  role: z
    .string()
    .min(2)
    .max(32)
    .transform((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
  title: z.string().min(2).max(60),
  persona: z.string().min(10).max(600),
  blurb: z.string().min(2).max(120),
});
const CandidatesSchema = z.array(CandidateSchema).min(3).max(8);

/** One-shot completion on whichever CLI is available (no tools, no session). */
async function completeOneShot(prompt: string): Promise<string> {
  const runner: AgentRunner = agentDriver.pickRunner(0);
  const res = await RUNNERS[runner].run({
    prompt,
    systemPrompt: "",
    cwd: tmpdir(),
    bin: runnerBin(runner),
    maxTurns: 4,
    idleTimeoutMs: 3 * 60_000,
    maxSessionMs: 5 * 60_000,
    onEvent: () => {},
  });
  if (!res.ok) throw new Error(res.error ?? "generation failed");
  return res.summary;
}

/** Generate a founding team tailored to the player's pitch (one cheap LLM call). */
export async function generateCandidates(input: {
  companyName: string;
  mission: string;
  businessType: BusinessTypeId;
}): Promise<HireCandidate[]> {
  const biz = businessTypeById(input.businessType);
  const typeHint =
    input.businessType === "custom" ? "" : `\nBusiness type: ${biz.label}. ${biz.hireHint}`;
  const prompt = `You are casting the founding team of a startup for a business-sim game.

Company: ${input.companyName}
Pitch: ${input.mission}${typeHint}

Invent 5 distinct hires tailored to THIS pitch — whatever business it is. Mix the roles sensibly (a game needs gameplay + art + audio; a newsletter needs research + writing + editing; an investment firm needs sourcing + analysis + IR; a shop needs product + ops + marketing). Each person gets:
- name: a memorable first name (diverse, varied)
- role: a short lowercase role key like "engineer", "pixel-artist", "writer"
- title: their job title
- persona: 2-3 sentences of working style + personality that will be used as their AI system prompt — concrete, vivid, useful
- blurb: a fun one-line resume hook

Reply with ONLY a JSON array of 5 objects with keys name, role, title, persona, blurb. No markdown fence, no commentary.`;

  const raw = await completeOneShot(prompt);
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const parsed: unknown = JSON.parse(jsonText);
  return CandidatesSchema.parse(parsed);
}
