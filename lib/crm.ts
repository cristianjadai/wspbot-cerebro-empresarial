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

/** Outreach stages as people say them in the chat, for the digest. */
const STAGE_LABELS: Record<string, string> = {
  Target: "Target",
  ConexionEnviada: "Conexión enviada",
  Conectado: "Conectado",
  Engaged: "Engaged",
  DMEnviado: "DM enviado",
  Respondio: "Respondió",
  EnConversacion: "En conversación",
};

export const STAGES = Object.keys(STAGE_LABELS) as [string, ...string[]];

type FollowUpRow = {
  id: string;
  nombre: string | null;
  empresa: string | null;
  cuenta: string;
  etapa: string;
  fecha?: string;
  diasVencido?: number;
  proximaAccion: string | null;
};

export type FollowUpList = {
  hoy: string;
  vencidos: FollowUpRow[];
  paraHoy: FollowUpRow[];
  proximos: FollowUpRow[];
  sinFollowUp: FollowUpRow[];
};

/** The raw list, for the digest runner. Throws; the runner decides what a failure means. */
export const followUpList = async (): Promise<FollowUpList> => (await call("followups")) as FollowUpList;

export const followUps = async (): Promise<string> => {
  if (!config.crm()) return NOT_CONFIGURED;
  try {
    return `Outreach follow-ups from the CRM (JSON; dates are yyyy-MM-dd in Ecuador, "hoy" is today):\n${JSON.stringify(await followUpList())}`;
  } catch (err) {
    console.error("[crm] reading follow-ups failed", err);
    return "Could not read the follow-ups right now. Say so — do not answer from memory.";
  }
};

export type FollowUpUpdate = {
  id?: string;
  nombre?: string;
  empresa?: string;
  /** yyyy-MM-dd, or null to clear it. */
  fecha: string | null;
  accion?: string;
  nota?: string;
  etapa?: string;
};

export const setFollowUp = async (update: FollowUpUpdate, author: string): Promise<string> => {
  if (!config.crm()) return NOT_CONFIGURED;
  const target = endpoint("followups");
  if (!target) return NOT_CONFIGURED;
  try {
    // Not through `call`: a 404 or 409 here is an answer for the model, not a failure.
    const res = await fetch(target.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${target.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...update, autor: author }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409) {
      return `Several people match; nothing was saved. Ask which one, then call again with their id. Candidates (JSON): ${JSON.stringify(body["candidatos"])}`;
    }
    if (!res.ok) return `Nothing was saved: ${String(body["error"] ?? res.status)}. Say so plainly.`;

    const p = body["persona"] as { nombre: string; empresa: string | null; etapa: string };
    const who = `${p.nombre}${p.empresa ? ` (${p.empresa})` : ""}`;
    const when = body["proximoFollowUp"]
      ? `next follow-up ${String(body["proximoFollowUp"])}${body["proximaAccion"] ? `: ${String(body["proximaAccion"])}` : ""}`
      : "follow-up cleared";
    const moved = body["etapaAnterior"] ? `, moved from ${String(body["etapaAnterior"])} to ${p.etapa}` : "";
    return `Saved for ${who} — ${when}${moved}. Confirm in one short line.`;
  } catch (err) {
    console.error("[crm] saving the follow-up failed", err);
    return "Could not save the follow-up, so nothing changed. Say so plainly.";
  }
};

/**
 * The morning digest, written here rather than by the model: it is a list of names and dates,
 * and a model in that path could only add the one failure that matters — a name or a day that
 * is almost right. `null` when there is nothing to say, so a quiet day sends nothing.
 */
export const digest = (list: FollowUpList): string | null => {
  const { hoy, vencidos, paraHoy, proximos, sinFollowUp } = list;
  if (vencidos.length + paraHoy.length + proximos.length + sinFollowUp.length === 0) return null;

  const who = (r: FollowUpRow) =>
    `${r.nombre ?? "Sin nombre"}${r.empresa ? ` (${r.empresa})` : ""} · ${r.cuenta}`;
  const next = (r: FollowUpRow) => (r.proximaAccion?.trim() ? `\n  ↳ ${r.proximaAccion.trim()}` : "");
  const day = (iso: string) =>
    new Intl.DateTimeFormat("es-EC", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T12:00:00Z`),
    );

  const lines = [`🔔 *Follow-ups de outreach — ${day(hoy)}*`];
  if (vencidos.length) {
    lines.push("", `*🔴 Vencidos (${vencidos.length})*`);
    for (const r of vencidos) lines.push(`• ${who(r)} — hace ${r.diasVencido}d${next(r)}`);
  }
  if (paraHoy.length) {
    lines.push("", `*🟡 Para hoy (${paraHoy.length})*`);
    for (const r of paraHoy) lines.push(`• ${who(r)}${next(r)}`);
  }
  if (proximos.length) {
    lines.push("", `*📅 Próximos 7 días (${proximos.length})*`);
    for (const r of proximos) lines.push(`• ${day(r.fecha!)} — ${who(r)}`);
  }
  if (sinFollowUp.length) {
    lines.push("", `*⚠️ Sin próximo paso (${sinFollowUp.length})*`);
    for (const r of sinFollowUp) lines.push(`• ${who(r)} — ${STAGE_LABELS[r.etapa] ?? r.etapa}`);
  }
  lines.push("", "_Etiquétame para guardar uno: “follow-up con Ana el viernes, mandarle el caso”._");
  return lines.join("\n");
};
