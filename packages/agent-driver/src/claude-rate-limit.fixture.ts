/**
 * The line claude-agent-acp 0.85.1 writes when claude's five-hour limit refuses a request
 * mid-turn: its `rate_limit_event` case, which forwards the CLI's `rate_limit_info` on a usage
 * update once the turn has had a model response (`used`, and the `_claude/model` that response
 * named). The info is what the bundled CLI (claude-agent-sdk 0.3.286) builds from a refusal's
 * `anthropic-ratelimit-unified-*` headers with no extra usage: `resetsAt` straight off the reset
 * header, in epoch seconds. Assembled from those two sources, since no test reaches a real
 * account; recheck it whenever either is bumped.
 */
export const CLAUDE_RATE_LIMITED_UPDATE = {
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: "s1",
    update: {
      _meta: {
        "_claude/model": "claude-sonnet-5",
        "_claude/rateLimit": {
          isUsingOverage: false,
          rateLimitType: "five_hour",
          resetsAt: 1_791_669_600,
          status: "rejected",
        },
      },
      sessionUpdate: "usage_update",
      size: 200_000,
      used: 48_213,
    },
  },
} as const;

/** When the fixture's limit lifts: 2026-10-10 22:00 UTC. */
export const CLAUDE_RATE_LIMIT_LIFTS_AT = Date.UTC(2026, 9, 10, 22);
