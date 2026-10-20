import "server-only";
import { config } from "./config";

/**
 * The Jadai CRM's outreach and deals, read and added to from WhatsApp.
 *
 * Same service and secret as the content board (`lib/content-intake.ts`): the CRM routes are
 * siblings of CONTENT_INGEST_URL under /api/bot. The snapshot comes back as JSON and is handed to
 * the model as is — it filters and draws insights from a flat list better than it drives an API
 * of filters. Every call returns a sentence for the model rather than throwing.
 */

/** Whether this chat may see the CRM. CRM_CHATS when set, the content group otherwise. */
export const isCrmChat = (chat: string): boolean => config.crm()?.chats.has(chat) ?? false;

const endpoint = (path: string): { url: URL; secret: string } | null => {
  const crm = config.crm();
  if (!crm) return null;
  // …/api/content/ingest → …/api/bot/<path>
  return { url: new URL(`../bot/${path}`, crm.url), secret: crm.secret };
};

const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
  const target = endpoint(path);
  if (!target) throw new Error("not configured");
  const res = await fetch(target.url, {
    ...init,
    headers: {
      Authorization: `Bearer ${target.secret}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`CRM answered ${res.status}: ${await res.text()}`);
  return res.json();
};

const NOT_CONFIGURED = "The CRM is not configured on this deployment. Say so.";

export const overview = async (): Promise<string> => {
  if (!config.crm()) return NOT_CONFIGURED;
  try {
    return `Live CRM snapshot (JSON):\n${JSON.stringify(await call("crm"))}`;
  } catch (err) {
    console.error("[crm] reading the overview failed", err);
    return "Could not read the CRM right now. Say so — do not answer from memory.";
  }
};

export const find = async (query: string): Promise<string> => {
  if (!config.crm()) return NOT_CONFIGURED;
  try {
    const { personas } = (await call(`personas?q=${encodeURIComponent(query)}`)) as {
      personas: unknown[];
    };
    return personas.length === 0
      ? `Nobody in the CRM matches "${query}". Say so; offer to add them if that is what they want.`
      : `CRM matches for "${query}" (JSON):\n${JSON.stringify(personas)}`;
  } catch (err) {
    console.error("[crm] search failed", err);
    return "Could not search the CRM right now. Say so — do not answer from memory.";
  }
};

export type NewPerson = {
  nombre: string;
  empresa?: string;
  cargo?: string;
  linkedinUrl?: string;
  correo?: string;
  telefono?: string;
  notas?: string;
  cuenta?: string;
};

export const add = async (person: NewPerson, author: string): Promise<string> => {
  if (!config.crm()) return NOT_CONFIGURED;
  try {
    const result = (await call("personas", {
      method: "POST",
      body: JSON.stringify({ ...person, autor: author }),
    })) as { creado: boolean; persona: { nombre: string; empresa: string | null; cuenta: string; etapa: string } };
    const p = result.persona;
    const who = `${p.nombre}${p.empresa ? ` (${p.empresa})` : ""}`;
    return result.creado
      ? `Added ${who} to outreach as Target, assigned to ${p.cuenta}. Confirm in one short line.`
      : `${who} was already in the CRM (stage ${p.etapa}, ${p.cuenta}). Nothing new was added; say so.`;
  } catch (err) {
    console.error("[crm] adding failed", err);
    return "Could not add the person to the CRM, so nothing was saved. Say so plainly.";
  }
};
