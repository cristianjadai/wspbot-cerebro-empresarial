import assert from "node:assert/strict";
import { availableIn, consult } from "../lib/garita";

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
