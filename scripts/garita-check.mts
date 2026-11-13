import assert from "node:assert/strict";
import { availableIn, consult, sendMyQr } from "../lib/garita";

process.env.GARITA_ENABLED = "true";
process.env.GARITA_PROXY_URL = "http://garita-session.railway.internal:8097";
process.env.GARITA_API_KEY = "test-key-".repeat(6);
process.env.GARITA_GROUP_ID = "10000@g.us";
const turn = { chat: "10000@g.us", isGroup: true, userId: "member@lid", messageKey: { id: "MSG1" } };
assert.equal(availableIn(turn), true);
for (const wrong of [
  { ...turn, chat: "99999@g.us" }, { ...turn, isGroup: false },
  { ...turn, unprompted: true }, { ...turn, messageKey: undefined },
  { ...turn, userId: undefined },
]) assert.equal(availableIn(wrong), false);

const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  assert.equal(url, "http://garita-session.railway.internal:8097/agent/consultar");
  assert.deepEqual(JSON.parse(init!.body as string), {
    chat_id: "10000@g.us", solicitante: "member@lid", message_id: "MSG1", modulo: "reservas",
  });
  assert.equal(init!.redirect, "error");
  return Response.json({ ok: true, areas: [], creacion_habilitada: false });
};
try {
  assert.deepEqual(await consult(turn, "reservas"), { ok: true, areas: [], creacion_habilitada: false });
  await consult({ ...turn, chat: "99999@g.us" }, "reservas");
  assert.equal(calls, 1);
  globalThis.fetch = async () => { throw new Error("https://secret.invalid/?auth=private-token"); };
  assert.equal(JSON.stringify(await consult(turn, "reservas")).includes("private-token"), false);
  process.env.GARITA_PROXY_URL = "http://localhost:8097";
  assert.equal(availableIn(turn), false);
  process.env.GARITA_PROXY_URL = "http://garita-session.railway.internal:8097";
  process.env.GARITA_GROUP_ID = "";
  assert.equal(availableIn(turn), false);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("PASS: garita uses trusted message context, exact group/private origin, no DMs/chimes, and safe errors");

process.env.GARITA_GROUP_ID = "10000@g.us";
const events: string[] = [];
const job = "a".repeat(64);
globalThis.fetch = async (url, init) => {
  const action = String(url).split("/").at(-1)!;
  events.push(action);
  const input = JSON.parse(init!.body as string);
  assert.equal(input.chat_id, turn.chat);
  assert.equal(input.message_id, "MSG1");
  if (action === "preparar") return Response.json({ job_id: job, png_base64: "fake-png", active: false });
  assert.equal(input.job_id, job);
  return Response.json({ active: true, expires_at: Date.now() / 1000 + 9, ttl_seconds: 10 });
};
const messaging = { upload: async () => { events.push("upload"); return "https://media.example/qr.png"; }, send: async (input: { to: string }) => {
  events.push("send");
  assert.equal(input.to, turn.chat);
  return { msgId: 1, jid: turn.chat, status: "sent" };
} };
try {
  const sent: string[] = [];
  const result = await sendMyQr(turn, "abc-1234", sent, messaging);
  assert.deepEqual(events, ["preparar", "upload", "activar", "send"]);
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(result).includes("fake-png"), false);
  assert.equal(JSON.stringify(result).includes("media.example"), false);
  events.length = 0;
  messaging.upload = async () => { throw new Error("upload rejected"); };
  const failed = await sendMyQr(turn, "ABC-1234", [], messaging);
  assert.deepEqual(events, ["preparar", "cancelar"]);
  assert.equal((failed as { ok: boolean }).ok, false);
  events.length = 0;
  await sendMyQr({ ...turn, isGroup: false }, "ABC-1234", [], messaging);
  assert.deepEqual(events, []);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("PASS: Mi QR uploads before activation, sends to the trusted chat, cleans up on failure, and keeps the QR out of model output");
