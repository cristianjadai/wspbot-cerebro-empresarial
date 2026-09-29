import "server-only";
import { config } from "./config";
import { wapi, type MessageKey } from "./wapi";

/**
 * The Jadai CRM's content board, from the content group.
 *
 * The bot never reads the group on its own: it files an idea or task only when somebody tags it
 * with one (or tags it in a reply pointing at one), through the `save_content` tool, and reads the
 * board through `content_board`. Whether the text is an idea, a task or neither — and which
 * account, format and date it belongs to — is decided in the CRM, next to the board the card
 * lands on.
 */

type IngestResult =
  | { tipo: "ignorar" }
  | { tipo: "Idea" | "Tarea"; postId: string; titulo: string; duplicado: boolean };

const REACTION: Record<"Idea" | "Tarea", string> = { Idea: "💡", Tarea: "✅" };

/** Whether this chat is the content group. Cheap: config only, no database. */
export const isContentChat = (chat: string): boolean =>
  config.contentIntake()?.chats.has(chat) ?? false;

/**
 * File one idea or task. `id` must be stable per idea — a retried delivery of the same message
 * must not create a second card — so callers derive it from the WhatsApp message id. Returns a
 * sentence for the model rather than throwing.
 */
export const save = async (input: {
  id: string;
  author: string;
  text: string;
  messageKey?: MessageKey;
}): Promise<string> => {
  const intake = config.contentIntake();
  if (!intake) return "The content board is not configured on this deployment.";

  try {
    const res = await fetch(intake.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${intake.secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messageId: input.id, author: input.author, text: input.text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`CRM answered ${res.status}: ${await res.text()}`);

    const result = (await res.json()) as IngestResult;
    if (result.tipo === "ignorar") {
      return "The CRM did not see an idea or a task in that text, so nothing was filed. Say so and ask what they want saved.";
    }
    if (input.messageKey) {
      try {
        await wapi.react(input.messageKey, REACTION[result.tipo]);
      } catch {}
    }
    return result.duplicado
      ? `Already on the board as ${result.tipo === "Idea" ? "an idea" : "a task"}: "${result.titulo}". Nothing new was filed.`
      : `Filed on the content board as ${result.tipo === "Idea" ? "an idea" : "a task"}: "${result.titulo}". Confirm in one short line.`;
  } catch (err) {
    console.error("[content-intake] saving failed", err);
    return "Could not reach the content board, so nothing was saved. Say so plainly.";
  }
};

type BoardCard = {
  titulo: string;
  tipo: string;
  estado: string;
  formato: string | null;
  cuenta: string;
  fechaPublicacion: string | null;
  fechaLimite: string | null;
  publicadoEl: string | null;
  autor: string | null;
  linkedinUrl: string | null;
};

/**
 * The board as text for the model: one line per card, everything still in the pipeline plus
 * what went out in the last month. Filtering ("videos in planning", "what goes out this week")
 * is left to the model, which reads a list like this better than it drives an API of filters.
 * Returns a sentence rather than throwing, like every other tool result.
 */
export const readBoard = async (): Promise<string> => {
  const intake = config.contentIntake();
  if (!intake) return "The content board is not configured on this deployment.";

  try {
    // Same service, sibling route: …/api/content/ingest → …/api/content/board.
    const res = await fetch(new URL("board", intake.url), {
      headers: { Authorization: `Bearer ${intake.secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`CRM answered ${res.status}`);
    const { hoy, tarjetas } = (await res.json()) as { hoy: string; tarjetas: BoardCard[] };

    if (tarjetas.length === 0) return `Today is ${hoy}. The content board is empty.`;

    const lines = tarjetas.map((c) =>
      [
        `- [${c.estado}] ${c.tipo === "Tarea" ? "TAREA: " : ""}${c.titulo}`,
        c.formato ? `formato ${c.formato}` : null,
        `cuenta ${c.cuenta}`,
        c.fechaPublicacion ? `publicar ${c.fechaPublicacion}` : null,
        c.fechaLimite ? `vence ${c.fechaLimite}` : null,
        c.publicadoEl ? `publicado ${c.publicadoEl}` : null,
        c.autor ? `propuesto por ${c.autor}` : null,
        c.linkedinUrl,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    return [
      `Today is ${hoy}. Content board (${tarjetas.length} cards; estados in pipeline order: Idea, Aprobada, EnProduccion, Revision, Programado, Publicado — published ones only from the last 30 days):`,
      ...lines,
    ].join("\n");
  } catch (err) {
    console.error("[content-intake] reading the board failed", err);
    return "Could not read the content board right now. Say so — do not answer from memory.";
  }
};
