import { createAnthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

/**
 * An Anthropic key that is not scoped to a workspace must name one on every request, or the API
 * refuses it outright. Scoped keys need nothing, so the header is sent only when configured.
 */
const workspace = process.env["ANTHROPIC_WORKSPACE_ID"]?.trim();
const anthropic = createAnthropic(
  workspace ? { headers: { "anthropic-workspace-id": workspace } } : {},
);

/**
 * Which provider a model id belongs to, decided by the id alone. `claude-*` goes to Anthropic,
 * everything else to OpenAI — so switching the bot's brain is an environment change, not a code
 * change, and the two can be mixed (Claude for replies, OpenAI for drawing and speech).
 */
export const isClaude = (id: string): boolean => id.startsWith("claude-");

export const languageModel = (id: string) => (isClaude(id) ? anthropic(id) : openai(id));

/**
 * Provider-executed search: whichever provider runs the turn runs the search itself. The tool
 * has to match the model — an OpenAI tool handed to Claude is simply not understood.
 */
export const webSearch = (id: string) =>
  isClaude(id)
    ? anthropic.tools.webSearch_20260209({ maxUses: 5 })
    : openai.tools.webSearch({ searchContextSize: "medium" });

/**
 * Drawing stickers and speaking voice notes exist only on OpenAI — Claude generates neither
 * images nor audio. Without a key those features are withdrawn rather than offered and failed.
 */
export const hasOpenAI = (): boolean => Boolean(process.env["OPENAI_API_KEY"]?.trim());

/** OpenAI's `minimal` has no Anthropic counterpart; `low` is the nearest. */
export const claudeEffort = (effort: string): "low" | "medium" | "high" | "xhigh" | "max" =>
  (["low", "medium", "high", "xhigh", "max"] as const).find((e) => e === effort) ?? "low";
