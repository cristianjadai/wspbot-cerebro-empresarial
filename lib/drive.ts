import "server-only";
import { createSign } from "node:crypto";
import { config } from "./config";
import * as sheets from "./sheets";

/**
 * A Google Drive folder as the bot's knowledge of the company.
 *
 * One folder, configured on the deployment (`DRIVE_FOLDER_ID`), shared with the same service
 * account Sheets uses. Everything below it — subfolders included — can be searched and read;
 * nothing outside it can, even when the service account happens to reach it. That boundary is
 * the feature: a group chat asks, and the bot must not wander into whatever else the account was
 * ever given.
 *
 * Read-only, and signed with `node:crypto` for the same reason `lib/sheets.ts` is: `googleapis`
 * is an enormous dependency for one JWT and a handful of REST calls.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER = "application/vnd.google-apps.folder";

/** What one read hands the model. A long manual is paged rather than dumped into one turn. */
const PAGE_CHARS = 12_000;
/** Downloads past this are refused: a PDF that large is a scan, and its text is not worth it. */
const MAX_BYTES = 25 * 1024 * 1024;
/** How long the folder tree is trusted before being walked again. */
const TREE_TTL_MS = 5 * 60_000;
/** A runaway tree would otherwise turn one search into hundreds of listing calls. */
const MAX_FOLDERS = 400;

export class DriveError extends Error {}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
  size?: string;
};

// ── service account ──────────────────────────────────────────────────────

const globalForDrive = globalThis as unknown as {
  wspbotDriveToken?: { token: string; expiresAt: number };
  wspbotDriveTree?: { root: string; folders: Map<string, string>; at: number };
};

/** The service-account flow: RS256 over a JWT, exchanged for an hour-long access token. */
const accessToken = async (): Promise<string> => {
  const cached = globalForDrive.wspbotDriveToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const credentials = config.googleServiceAccount();
  if (!credentials) throw new DriveError("no Google service account is configured");

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: credentials.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(credentials.privateKey, "base64url")}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new DriveError(body.error_description ?? body.error ?? `Google returned ${res.status}`);
  }

  globalForDrive.wspbotDriveToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
};

/**
 * `supportsAllDrives` on every call: a company folder is as likely to live in a shared drive as
 * in somebody's My Drive, and without the flag a shared-drive file answers 404 as if absent.
 */
const call = async (path: string, params: Record<string, string> = {}): Promise<Response> => {
  const url = new URL(`${DRIVE_API}${path}`);
  for (const [k, v] of Object.entries({ supportsAllDrives: "true", ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const why = body.error?.message ?? `Drive returned ${res.status}`;
    throw new DriveError(
      res.status === 404
        ? "not found — the file is missing or the folder is not shared with the service account"
        : why,
    );
  }
  return res;
};

const FIELDS = "id,name,mimeType,modifiedTime,webViewLink,parents,size";

const list = async (q: string, pageSize = 100): Promise<DriveFile[]> => {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const res = await call("/files", {
      q,
      fields: `nextPageToken,files(${FIELDS})`,
      pageSize: String(pageSize),
      includeItemsFromAllDrives: "true",
      orderBy: "modifiedTime desc",
      ...(pageToken ? { pageToken } : {}),
    });
    const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken && files.length < pageSize);
  return files;
};

/** Drive's query language quotes with `'` and escapes with `\`. */
const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// ── the boundary ─────────────────────────────────────────────────────────

/** The configured root, or a refusal the model can read back. */
const root = (): string => {
  const drive = config.drive();
  if (!drive) throw new DriveError("the company Drive is not set up on this deployment");
  return drive.folderId;
};

/**
 * Every folder under the root, id to path. Walked breadth-first and cached, because Drive has no
 * "is this inside that" query: containment can only be answered by knowing the tree.
 */
const tree = async (): Promise<Map<string, string>> => {
  const rootId = root();
  const cached = globalForDrive.wspbotDriveTree;
  if (cached && cached.root === rootId && Date.now() - cached.at < TREE_TTL_MS) {
    return cached.folders;
  }

  const folders = new Map<string, string>([[rootId, ""]]);
  let frontier = [rootId];
  while (frontier.length && folders.size < MAX_FOLDERS) {
    const next: string[] = [];
    // Several parents per query, or a wide tree costs a round trip per folder.
    for (let i = 0; i < frontier.length; i += 20) {
      const batch = frontier.slice(i, i + 20);
      const q = `mimeType = '${FOLDER}' and trashed = false and (${batch
        .map((id) => `${quote(id)} in parents`)
        .join(" or ")})`;
      for (const f of await list(q, 1000)) {
        if (folders.has(f.id)) continue;
        const parent = f.parents?.find((p) => folders.has(p)) ?? rootId;
        const base = folders.get(parent) ?? "";
        folders.set(f.id, base ? `${base}/${f.name}` : f.name);
        next.push(f.id);
      }
    }
    frontier = next;
  }

  globalForDrive.wspbotDriveTree = { root: rootId, folders, at: Date.now() };
  return folders;
};

/**
 * The file, but only if it sits somewhere under the root. An id the model supplies is never
 * trusted on its own: the service account may reach files that were never meant for this chat.
 */
const inside = async (fileId: string): Promise<{ file: DriveFile; path: string }> => {
  const folders = await tree();
  const res = await call(`/files/${encodeURIComponent(fileId)}`, { fields: FIELDS });
  const file = (await res.json()) as DriveFile;
  const parent = file.parents?.find((p) => folders.has(p));
  if (!parent && !folders.has(file.id)) {
    throw new DriveError("that file is not in the company Drive folder");
  }
  const base = parent ? (folders.get(parent) ?? "") : (folders.get(file.id) ?? "");
  return { file, path: base };
};

const kind = (mimeType: string): string =>
  ({
    [FOLDER]: "folder",
    "application/vnd.google-apps.document": "doc",
    "application/vnd.google-apps.spreadsheet": "sheet",
    "application/vnd.google-apps.presentation": "slides",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  })[mimeType] ?? mimeType;

const line = (f: DriveFile, path: string): string =>
  [
    `- ${f.name} [${kind(f.mimeType)}]`,
    path ? `in ${path}` : "",
    f.modifiedTime ? `· modified ${f.modifiedTime.slice(0, 10)}` : "",
    `· id ${f.id}`,
    f.webViewLink ? `· ${f.webViewLink}` : "",
  ]
    .filter(Boolean)
    .join(" ");

// ── what the tools call ──────────────────────────────────────────────────

/**
 * Search names and contents across the whole tree. Drive's full-text search covers Docs, Sheets,
 * Slides and the text layer of PDFs and Office files, so this finds a policy by what it says,
 * not only by what somebody named the file.
 */
export const search = async (text: string, limit = 15): Promise<string> => {
  const folders = await tree();
  const ids = [...folders.keys()];
  const words = quote(text.trim());
  const seen = new Map<string, DriveFile>();

  for (let i = 0; i < ids.length && seen.size < limit * 2; i += 30) {
    const parents = ids
      .slice(i, i + 30)
      .map((id) => `${quote(id)} in parents`)
      .join(" or ");
    const q = `trashed = false and (name contains ${words} or fullText contains ${words}) and (${parents})`;
    for (const f of await list(q, limit)) seen.set(f.id, f);
  }

  const hits = [...seen.values()]
    .sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))
    .slice(0, limit);
  if (!hits.length) return `Nothing in the company Drive matches "${text}".`;

  return [
    `${hits.length} match${hits.length === 1 ? "" : "es"} for "${text}", newest first:`,
    ...hits.map((f) => line(f, folders.get(f.parents?.find((p) => folders.has(p)) ?? "") ?? "")),
  ].join("\n");
};

/** What is in one folder — the root when none is named. For browsing, not for finding. */
export const browse = async (folderId?: string): Promise<string> => {
  const folders = await tree();
  const id = folderId?.trim() || root();
  if (!folders.has(id)) throw new DriveError("that folder is not in the company Drive");

  const items = await list(`${quote(id)} in parents and trashed = false`, 200);
  if (!items.length) return "That folder is empty.";
  const path = folders.get(id) || "(top level)";
  return [
    `${path}: ${items.length} item${items.length === 1 ? "" : "s"}`,
    ...items
      .sort((a, b) => Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER))
      .map((f) => line(f, "")),
  ].join("\n");
};

const download = async (id: string, size?: string): Promise<Buffer> => {
  if (Number(size) > MAX_BYTES) throw new DriveError("that file is too large to read here");
  const res = await call(`/files/${encodeURIComponent(id)}`, { alt: "media" });
  return Buffer.from(await res.arrayBuffer());
};

const exported = async (id: string, mimeType: string): Promise<string> =>
  (await call(`/files/${encodeURIComponent(id)}/export`, { mimeType })).text();

/** The file as text, whatever it was stored as — or a refusal naming what it is. */
const textOf = async (file: DriveFile): Promise<string> => {
  switch (file.mimeType) {
    case "application/vnd.google-apps.document":
      return exported(file.id, "text/plain");
    case "application/vnd.google-apps.presentation":
      return exported(file.id, "text/plain");
    case "application/vnd.google-apps.spreadsheet":
      /*
       * Through the Sheets API rather than a CSV export: the export is the first tab only, and
       * the answer is as often on the third. Same service account, so no extra setup.
       */
      return (await sheets.read(`https://docs.google.com/spreadsheets/d/${file.id}`)).text;
    case "application/pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(await download(file.id, file.size)));
      const { text } = await extractText(pdf, { mergePages: true });
      return text.trim() || "(this PDF has no text layer — it is probably a scan)";
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ buffer: await download(file.id, file.size) })).value;
    }
    default:
      if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") {
        return (await download(file.id, file.size)).toString("utf8");
      }
      throw new DriveError(
        `a ${kind(file.mimeType)} file cannot be read as text${file.webViewLink ? ` — share the link instead: ${file.webViewLink}` : ""}`,
      );
  }
};

/**
 * Read one file, a page at a time. `offset` continues where the previous page stopped, so a
 * sixty-page manual costs what is needed rather than all of it on every question.
 */
export const read = async (fileId: string, offset = 0): Promise<string> => {
  const { file, path } = await inside(fileId);
  if (file.mimeType === FOLDER) return browse(file.id);

  const text = (await textOf(file)).replace(/\n{3,}/g, "\n\n");
  const start = Math.max(0, Math.min(offset, text.length));
  const page = text.slice(start, start + PAGE_CHARS);
  const end = start + page.length;

  return [
    `${file.name}${path ? ` (in ${path})` : ""}${file.webViewLink ? ` — ${file.webViewLink}` : ""}`,
    file.modifiedTime ? `Last modified ${file.modifiedTime.slice(0, 10)}.` : "",
    "",
    page,
    "",
    end < text.length
      ? `[characters ${start}–${end} of ${text.length}. Call again with offset ${end} for more.]`
      : start > 0
        ? `[end of file, characters ${start}–${end}]`
        : "",
  ]
    .filter((l, i) => l !== "" || i === 2 || i === 4)
    .join("\n")
    .trim();
};
