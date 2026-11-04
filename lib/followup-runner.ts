import "server-only";
import { config } from "./config";
import { query } from "./db";
import { wapi } from "./wapi";
import * as cron from "./cron";
import * as crm from "./crm";
import * as features from "./features";

/**
 * The morning outreach follow-up digest for the founders group.
 *
 * Model-free, like the leaderboard: the list comes from the CRM and is formatted by
 * `crm.digest`, so every name and date in the message is one the CRM actually holds. A day with
 * nothing due sends nothing, and a CRM that will not answer costs that morning's message rather
 * than an apology in the group.
 */

const TICK_MS = 60 * 1000;

const g = globalThis as unknown as { wspbotFollowUps?: NodeJS.Timeout };

/** The insert is the claim: true only for the first tick to reach this chat and minute. */
const claim = async (chat: string, minuteKey: string): Promise<boolean> => {
  const rows = await query<{ chat: string }>(
    `insert into followup_digests (chat, minute_key) values ($1, $2)
     on conflict do nothing returning chat`,
    [chat, minuteKey],
  );
  return rows.length > 0;
};

const tick = async (): Promise<void> => {
  try {
    const cfg = config.followUps();
    if (!cfg) return;
    if (!(await features.enabled()).has("crm_followups")) return;

    const now = new Date();
    const tz = config.timezone();
    if (!cron.matches(cron.parse(cfg.cron), now, tz)) return;

    const key = cron.minuteKey(now, tz);
    const chats: string[] = [];
    for (const chat of cfg.chats) if (await claim(chat, key)) chats.push(chat);
    if (chats.length === 0) return;

    const text = crm.digest(await crm.followUpList());
    if (!text) {
      console.log("[followups] nothing due; nothing sent");
      return;
    }
    for (const chat of chats) {
      await wapi.sendText(chat, text);
      console.log(`[followups] digest sent to ${chat}`);
    }
  } catch (err) {
    console.error("[followups] tick failed:", err instanceof Error ? err.message : err);
  }
};

export const startFollowUps = (): void => {
  if (g.wspbotFollowUps) return;
  console.log(`[followups] checking every ${TICK_MS / 1000}s`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  g.wspbotFollowUps = timer;
};
