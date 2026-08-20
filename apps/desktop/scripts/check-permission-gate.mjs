// Guards the founder-approval gate's decision logic.
//
// Agents run unattended against the founder's real credentials, so
// isOutwardFacingCommand is the line between "the team is working" and "the
// team published something in your name". It is a list of regexes, and a
// regex that silently stops matching fails OPEN — the command runs, no card
// appears, and nothing looks wrong. That already happened once: `\b-X` never
// matches `curl -X POST`, because there is no word boundary between a space
// and a hyphen.
//
// So: every pattern gets a command it must catch, and the everyday commands
// agents run all day get an assertion that they are NOT gated (a gate that
// cries wolf trains founders to click Approve without reading).
//
// Usage: node scripts/check-permission-gate.mjs   — exit 0 clean, 1 on any miss
import {
  approvalKey,
  isOutwardFacingCommand,
  parseBlockedAsk,
  serializeBlockedAsk,
} from "../src/shared/domain.ts";

const MUST_GATE = [
  'npx vercel deploy --yes --prod --token "$VERCEL_TOKEN"',
  "vercel deploy --prod",
  "netlify deploy --prod",
  "npx wrangler deploy",
  "wrangler publish",
  "npm publish",
  "npm publish --access public",
  "gh pr create --title x --body y",
  "gh release create v1.0.0",
  "gh repo create acme/thing --public",
  "git push origin main",
  "git push --force origin main",
  "curl -X POST https://api.example.com/v1/things",
  "curl -s -X DELETE https://api.example.com/v1/things/1",
];

const MUST_NOT_GATE = [
  "echo hi > notes.md",
  "npm install",
  "npm run build",
  "npm test",
  "git status",
  "git add -A && git commit -m 'wip'",
  "git log --oneline -10",
  "node build.js",
  "npx vercel --help",
  "agent-browser open https://example.com",
  // the game's own API — loopback is never outward-facing
  'curl -s -X POST "$IDLEBIZ_API_URL/v1/message-team" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN"',
  "curl -s http://127.0.0.1:8842/v1/team-chat",
];

const failures = [];

for (const command of MUST_GATE) {
  if (!isOutwardFacingCommand(command)) failures.push(`NOT GATED (fails open): ${command}`);
}
for (const command of MUST_NOT_GATE) {
  if (isOutwardFacingCommand(command)) failures.push(`GATED but harmless: ${command}`);
}

// The CLIs decorate what they run; a decorated retry must reuse the approval
// the founder already gave, or they get asked the same question forever.
const decorated = approvalKey('git push origin main 2>&1; echo "exit=$?"');
const plain = approvalKey("git push  origin   main");
if (decorated !== plain) {
  failures.push(
    `approvalKey does not normalize: ${JSON.stringify(decorated)} vs ${JSON.stringify(plain)}`,
  );
}
if (approvalKey("git push origin main") === approvalKey("git push origin production")) {
  failures.push("approvalKey collapses genuinely different commands");
}

// TASK.md stores one scalar; a broken round-trip loses why a task is blocked.
for (const ask of [
  { type: "question", question: "ship it?" },
  { type: "question", question: "why did [approve] show up here?" },
  { type: "integration", integration: "vercel", reason: "need hosting" },
  { type: "approval", command: "npx vercel deploy --prod" },
]) {
  const round = parseBlockedAsk(serializeBlockedAsk(ask));
  if (JSON.stringify(round) !== JSON.stringify(ask)) {
    failures.push(`BlockedAsk round-trip: ${JSON.stringify(ask)} -> ${JSON.stringify(round)}`);
  }
}

if (failures.length === 0) {
  console.log(
    `permission gate ok — ${MUST_GATE.length} gated, ${MUST_NOT_GATE.length} allowed, round-trips clean`,
  );
} else {
  console.log("Permission gate check FAILED:\n");
  for (const f of failures) console.log(`  ${f}`);
  console.log(
    "\nA command that should be gated but isn't means agents can reach the outside\n" +
      "world with no founder sign-off. Fix OUTWARD_COMMAND_PATTERNS in shared/domain.ts.",
  );
  process.exitCode = 1;
}
