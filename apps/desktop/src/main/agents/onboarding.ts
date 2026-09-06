import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { z } from "zod";
import { RUNNERS } from "@repo/agent-driver/registry";
import { isReady, type RunnerProbe } from "@repo/agent-driver/detect";
import { acpAgentFor, agentDriver } from "@/main/agents/agent-driver";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { foundingTeamPrompt } from "@/main/prompts/onboarding";
import { errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import type { AgentRunner, BusinessTypeId } from "@/shared/domain";
import { HireCandidateSchema, type AuthFlowEvent, type HireCandidate } from "@/shared/ipc-registry";

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
    const ready = probes.filter(isReady);
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
    emit({ type: "error", message: errorMessage(err) });
  } finally {
    setupRunning = false;
  }
}

const CandidatesSchema = z.array(HireCandidateSchema).min(3).max(8);

async function completeOneShot(prompt: string): Promise<string> {
  const runner: AgentRunner = agentDriver.pickRunner(0);
  const res = await runAcpTurn({
    agent: acpAgentFor(runner),
    prompt,
    systemPrompt: "",
    cwd: tmpdir(),
    idleTimeoutMs: 3 * 60_000,
    maxSessionMs: 5 * 60_000,
    // Roster generation needs no tools or filesystem access.
    onPermission: () => Promise.resolve({ allow: false }),
    onEvent: () => {},
  });
  if (res.end.kind === "failed") throw new Error(res.end.error);
  return res.summary;
}

export async function generateCandidates(input: {
  companyName: string;
  mission: string;
  businessType: BusinessTypeId;
}): Promise<HireCandidate[]> {
  const prompt = foundingTeamPrompt(input.companyName, input.mission, input.businessType);
  const raw = await completeOneShot(prompt);
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  return CandidatesSchema.parse(parseJson(jsonText));
}
