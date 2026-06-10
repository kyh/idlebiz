import { shell } from "electron";
import { completeSimple, getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { z } from "zod";
import { piDriver } from "@/main/agents/pi-driver";
import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_AGENT_MODEL } from "@/shared/domain";

// ---------------------------------------------------------------------------
// First-run onboarding backend: in-game OpenAI OAuth + LLM-generated hires.
// ---------------------------------------------------------------------------

export type AuthFlowEvent =
  | { type: "url"; url: string; instructions: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

let pendingCode: ((code: string) => void) | null = null;
let loginRunning = false;

/**
 * Run the openai-codex OAuth flow. Opens the system browser; a local callback
 * server races against manual code paste (submitAuthCode). Events stream to the
 * renderer so the Pokémon dialog can narrate the steps.
 */
export async function startLogin(emit: (e: AuthFlowEvent) => void): Promise<void> {
  if (loginRunning) {
    emit({ type: "progress", message: "Login already in progress…" });
    return;
  }
  loginRunning = true;
  try {
    await piDriver.getAuth().login(DEFAULT_PROVIDER, {
      onAuth: (info: { url: string; instructions?: string }) => {
        emit({ type: "url", url: info.url, instructions: info.instructions ?? "Authorize in your browser, then come back." });
        void shell.openExternal(info.url);
      },
      // fallback prompt if both the callback server and manual input stall —
      // we just route it through the same manual-code promise
      onPrompt: () =>
        new Promise<string>((resolve) => {
          pendingCode = resolve;
        }),
      onProgress: (message: string) => emit({ type: "progress", message }),
      onManualCodeInput: () =>
        new Promise<string>((resolve) => {
          pendingCode = resolve;
        }),
    });
    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    pendingCode = null;
    loginRunning = false;
  }
}

/** Feed a manually pasted authorization code (or full redirect URL) into the flow. */
export function submitAuthCode(code: string): boolean {
  if (!pendingCode) return false;
  pendingCode(code.trim());
  pendingCode = null;
  return true;
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

function pickModel(): Model<Api> {
  const m = getModels(DEFAULT_PROVIDER).find((x) => x.id === DEFAULT_MODEL_ID);
  if (!m) throw new Error(`model ${DEFAULT_AGENT_MODEL} not found`);
  return m;
}

function extractText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .map((b) => ("text" in b && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .join("");
}

/** Generate a founding team tailored to the player's pitch (one cheap LLM call). */
export async function generateCandidates(input: { companyName: string; mission: string }): Promise<HireCandidate[]> {
  const apiKey = await piDriver.getAuth().getApiKey(DEFAULT_PROVIDER);
  if (!apiKey) throw new Error("not authenticated");

  const prompt = `You are casting the founding team of a startup for a business-sim game.

Company: ${input.companyName}
Pitch: ${input.mission}

Invent 5 distinct hires tailored to THIS pitch — whatever business it is. Mix the roles sensibly (a game needs gameplay + art + audio; a newsletter needs research + writing + editing; an investment firm needs sourcing + analysis + IR; a shop needs product + ops + marketing). Each person gets:
- name: a memorable first name (diverse, varied)
- role: a short lowercase role key like "engineer", "pixel-artist", "writer"
- title: their job title
- persona: 2-3 sentences of working style + personality that will be used as their AI system prompt — concrete, vivid, useful
- blurb: a fun one-line resume hook

Reply with ONLY a JSON array of 5 objects with keys name, role, title, persona, blurb. No markdown fence, no commentary.`;

  const msg = await completeSimple(
    pickModel(),
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { apiKey },
  );
  const raw = extractText(msg.content);
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const parsed: unknown = JSON.parse(jsonText);
  return CandidatesSchema.parse(parsed);
}
