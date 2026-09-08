import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { z } from "zod";
import { RUNNERS } from "@repo/agent-driver/registry";
import { isReady } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { acpAgentFor, agentDriver } from "@/main/agents/agent-driver";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { foundingTeamPrompt } from "@/main/prompts/onboarding";
import { errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import type { AgentRunner, BusinessTypeId } from "@/shared/domain";
import { HireCandidateSchema } from "@/shared/ipc-registry";
import type { AuthFlowEvent, HireCandidate } from "@/shared/ipc-registry";

let setupRunning = false;

const CLAUDE_INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";

/** Spawn a command, streaming its output lines as progress (URLs get their own event). */
const streamCommand = (
  cmd: string,
  args: string[],
  emit: (e: AuthFlowEvent) => void,
): Promise<number | null> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onLine = (line: string): void => {
      const text = line.trim();
      if (!text) {
        return;
      }
      const url = /https?:\/\/\S+/u.exec(text)?.[0];
      if (url) {
        emit({ type: "url", url });
      } else {
        emit({ message: text.slice(0, 200), type: "progress" });
      }
    };
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", onLine);
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", onLine);
    }
    child.on("error", (err) => {
      emit({ message: err.message, type: "error" });
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });

const label = (p: RunnerProbe): string => RUNNERS[p.id].displayName;

export const startLogin = async (emit: (e: AuthFlowEvent) => void): Promise<void> => {
  if (setupRunning) {
    emit({ message: "Setup already in progress…", type: "progress" });
    return;
  }
  setupRunning = true;
  try {
    let probes = await agentDriver.refresh();
    for (const p of probes) {
      emit({
        message: p.installed
          ? `Found ${label(p)} (${p.version ?? "unknown version"})${p.authed ? " — signed in ✓" : " — not signed in"}`
          : `${label(p)} not installed`,
        type: "progress",
      });
    }

    if (probes.every((p) => !p.installed)) {
      emit({ message: "No coding CLI found — installing Claude Code…", type: "progress" });
      const code = await streamCommand("bash", ["-lc", CLAUDE_INSTALL_CMD], emit);
      if (code !== 0) {
        emit({
          message: "Install failed — install Claude Code or Codex manually, then retry.",
          type: "error",
        });
        return;
      }
      emit({ message: "Claude Code installed.", type: "progress" });
      probes = await agentDriver.refresh();
    }

    for (const p of probes) {
      if (!p.installed || p.authed) {
        continue;
      }
      emit({ message: `Signing in to ${label(p)} — your browser will open…`, type: "progress" });
      const code = await streamCommand(p.bin, RUNNERS[p.id].loginArgs, emit);
      if (code !== 0) {
        emit({
          message: `Couldn't finish automatically. In a terminal, run: ${p.bin} ${RUNNERS[p.id].loginArgs.join(" ")} — then come back and retry.`,
          type: "progress",
        });
      }
    }

    probes = await agentDriver.refresh();
    const ready = probes.filter(isReady);
    if (ready.length > 0) {
      emit({ message: `Workforce ready: ${ready.map(label).join(" + ")}.`, type: "progress" });
      emit({ type: "done" });
    } else {
      emit({
        message: "No signed-in coding CLI yet. Sign in to Claude Code or Codex, then retry.",
        type: "error",
      });
    }
  } catch (error) {
    emit({ message: errorMessage(error), type: "error" });
  } finally {
    setupRunning = false;
  }
};

const CandidatesSchema = z.array(HireCandidateSchema).min(3).max(8);

const completeOneShot = async (prompt: string): Promise<string> => {
  const runner: AgentRunner = agentDriver.pickRunner(0);
  const res = await runAcpTurn({
    agent: acpAgentFor(runner),
    cwd: tmpdir(),
    idleTimeoutMs: 3 * 60_000,
    maxSessionMs: 5 * 60_000,
    onEvent: () => {
      /* empty */
    },
    // Roster generation needs no tools or filesystem access.
    onPermission: () => Promise.resolve({ allow: false }),
    prompt,
    systemPrompt: "",
  });
  if (res.end.kind === "failed") {
    throw new Error(res.end.error);
  }
  return res.summary;
};

export const generateCandidates = async (input: {
  companyName: string;
  mission: string;
  businessType: BusinessTypeId;
}): Promise<HireCandidate[]> => {
  const prompt = foundingTeamPrompt(input.companyName, input.mission, input.businessType);
  const raw = await completeOneShot(prompt);
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  return CandidatesSchema.parse(parseJson(jsonText));
};
