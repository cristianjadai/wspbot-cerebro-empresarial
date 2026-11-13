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
  text?: string;
};

export const reservationSchema = z.object({
  accion: z.enum(["listar", "disponibilidad", "crear", "cancelar", "confirmar"]),
  area_id: z.string().min(1).max(60).optional(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  duracion: z.number().int().min(1).max(1440).optional(),
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).optional(),
  fin: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/).optional(),
  invitados: z.number().int().min(0).max(10000).optional(),
  reserva_id: z.number().int().positive().optional(),
  motivo: z.string().max(300).optional(),
  observaciones: z.string().max(300).optional(),
});

export const reservations = async (turn: Context, input: z.infer<typeof reservationSchema>): Promise<unknown> => {
  if (!availableIn(turn)) return { ok: false, error: "Reservas solo está disponible desde el grupo Jadai autorizado." };
  try {
    const response = await fetch(`${process.env.GARITA_PROXY_URL}/agent/reservas`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", "x-api-key": process.env.GARITA_API_KEY! },
      body: JSON.stringify({ ...reservationSchema.parse(input), chat_id: turn.chat, solicitante: turn.userId,
        message_id: turn.messageKey!.id, texto_confirmacion: input.accion === "confirmar" ? turn.text ?? "" : "" }),
    });
    if (!response.ok) {
      const error = z.object({ detail: z.string().max(600) }).safeParse(await response.json());
      return { ok: false, error: error.success ? error.data.detail : "No se confirmó la operación. Consulta el historial antes de reintentar." };
    }
    return await response.json();
  } catch {
    return { ok: false, error: "No se confirmó la operación de reservas. Consulta el historial antes de reintentar; no asumas que se creó o canceló." };
  }
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
  let stage: "prepare" | "upload" | "activate" | "send" = "prepare";
  try {
    const prepared = preparedSchema.parse(await call("preparar"));
    jobId = prepared.job_id;
    stage = "upload";
    const imageUrl = await messaging.upload({ base64: prepared.png_base64, mimetype: "image/png", fileName: "mi-qr-enter.png" });
    stage = "activate";
    const active = activeSchema.parse(await call("activar"));
    if (active.expires_at * 1000 < Date.now() + 2000) throw new Error("miqr_expired_before_send");
    const expires = new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(active.expires_at * 1000));
    stage = "send";
    await messaging.send({ to: turn.chat, imageUrl, text: `Mi QR ENTER · ${body.placa}\nÚsalo ahora. Retiro programado a las ${expires} (Ecuador); vigencia original de 10 segundos.` });
    delivered = true;
    sent.push("Mi QR ENTER enviado; retiro automático programado");
    // El PNG, enlace y código de acceso no entran al contexto del modelo.
    return { ok: true, enviado: true, vence_a_las: expires, limpieza_programada: true,
      indicacion: "El QR ya fue enviado. No prometas otros 10 segundos desde esta respuesta ni reutilices la imagen; para otro QR pide una nueva solicitud." };
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
    console.warn("[garita_miqr] delivery_failed", { stage, http_status: status });
    if (jobId && !delivered) await call("cancelar").catch(() => {});
    const errors = {
      prepare: "ENTER no pudo preparar Mi QR. No se inició la entrega; no atribuyas el fallo a la placa sin verificarlo.",
      upload: "Falló el servicio de imágenes de WhatsApp. ENTER preparó el QR, pero no se activó ningún acceso. No es un error de la placa ni evidencia de sesión vencida.",
      activate: "No se pudo confirmar la activación de Mi QR en ENTER. Se solicitó su retirada; no lo des por vigente.",
      send: "No se pudo confirmar la entrega de la imagen a WhatsApp. Se solicitó retirar el QR; no reenvíes ni reutilices esa imagen.",
    };
    return { ok: false, fase: stage, error: errors[stage] };
  }
};
