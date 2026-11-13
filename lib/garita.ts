import "server-only";
import { wapi } from "./wapi";
import { z } from "zod";

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

const preparedSchema = z.object({ job_id: z.string().regex(/^[a-f0-9]{64}$/), png_base64: z.string().min(1).max(200_000), active: z.literal(false) });
const activeSchema = z.object({ active: z.literal(true), expires_at: z.number(), ttl_seconds: z.literal(10) });

/** Upload while inactive; activate last so media processing does not consume the QR lifetime. */
export const sendMyQr = async (turn: Context, placa: string, sent: string[], messaging: Pick<typeof wapi, "upload" | "send"> = wapi): Promise<unknown> => {
  if (!availableIn(turn)) return { ok: false, error: "Mi QR solo está disponible desde el grupo Jadai autorizado." };
  const body = { chat_id: turn.chat, solicitante: turn.userId, message_id: turn.messageKey!.id, placa: placa.trim().toUpperCase() };
  let jobId: string | undefined;
  const call = async (action: string) => {
    const response = await fetch(`${process.env.GARITA_PROXY_URL}/agent/miqr/${action}`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.GARITA_API_KEY! },
      body: JSON.stringify({ ...body, ...(jobId ? { job_id: jobId } : {}) }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("miqr_unavailable");
    return response.json();
  };
  let delivered = false;
  try {
    const prepared = preparedSchema.parse(await call("preparar"));
    jobId = prepared.job_id;
    const imageUrl = await messaging.upload({ base64: prepared.png_base64, mimetype: "image/png", fileName: "mi-qr-enter.png" });
    const active = activeSchema.parse(await call("activar"));
    if (active.expires_at * 1000 < Date.now() + 2000) throw new Error("miqr_expired_before_send");
    const expires = new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(active.expires_at * 1000));
    await messaging.send({ to: turn.chat, imageUrl, text: `Mi QR ENTER · ${body.placa}\nÚsalo ahora. Retiro programado a las ${expires} (Ecuador); vigencia original de 10 segundos.` });
    delivered = true;
    sent.push("Mi QR ENTER enviado; retiro automático programado");
    // El PNG, enlace y código de acceso no entran al contexto del modelo.
    return { ok: true, enviado: true, vence_a_las: expires, limpieza_programada: true,
      indicacion: "El QR ya fue enviado. No prometas otros 10 segundos desde esta respuesta ni reutilices la imagen; para otro QR pide una nueva solicitud." };
  } catch {
    if (jobId && !delivered) await call("cancelar").catch(() => {});
    return { ok: false, error: "No pude entregar un Mi QR vigente. La limpieza quedó programada. Verifica placa, sesión y permiso en ENTER; vuelve a pedirlo en un mensaje nuevo." };
  }
};
