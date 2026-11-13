import "server-only";

/** A fixed private service. Neither endpoint nor WhatsApp identity is a model argument. */
export type Context = {
  chat: string;
  isGroup: boolean;
  userId?: string;
  messageKey?: { id?: string };
  unprompted?: boolean;
};

export const availableIn = (turn: Context): boolean =>
  process.env.GARITA_ENABLED === "true" &&
  process.env.GARITA_PROXY_URL === "http://garita-session.railway.internal:8097" &&
  Boolean(process.env.GARITA_API_KEY && process.env.GARITA_API_KEY.length >= 32) &&
  Boolean(process.env.GARITA_GROUP_ID?.match(/^[0-9-]+@g\.us$/)) &&
  turn.isGroup && !turn.unprompted &&
  turn.chat === process.env.GARITA_GROUP_ID &&
  Boolean(turn.userId && turn.messageKey?.id);

export const consult = async (
  turn: Context,
  modulo: "estado" | "reservas" | "visitas",
): Promise<unknown> => {
  if (!availableIn(turn)) return { ok: false, error: "Garita solo está disponible desde el grupo Jadai autorizado." };
  try {
    const response = await fetch(`${process.env.GARITA_PROXY_URL}/agent/consultar`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.GARITA_API_KEY! },
      body: JSON.stringify({
        chat_id: turn.chat,
        solicitante: turn.userId,
        message_id: turn.messageKey!.id,
        modulo,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    // Never return raw transport errors, headers, configuration or session material to the model.
    if (!response.ok) return { ok: false, error: response.status === 403
      ? "El proxy rechazó el grupo o solicitante."
      : "ENTER no pudo verificar la consulta. No se realizaron cambios." };
    return await response.json();
  } catch {
    return { ok: false, error: "No pude conectar con el proxy privado de ENTER. No se realizaron cambios." };
  }
};
