/**
 * JIT (Just-In-Time) credential collection via a local browser form.
 *
 * Flow:
 *   1. Start an HTTP server on 127.0.0.1:<random-port>
 *   2. Generate a random token; embed it in the URL and as a CSRF field
 *   3. Open the user's default browser to that URL
 *   4. Serve a form built from the connector's credentials spec
 *   5. On POST, validate the token, store each field in the OS keychain
 *   6. Respond with a success page; shut down the server
 *
 * Security properties:
 *   - Listens only on 127.0.0.1 (never on external interfaces)
 *   - Random 64-hex-char token required in URL and form (CSRF defense)
 *   - Single-use: server auto-closes after a successful POST
 *   - 5-minute timeout if the user never submits
 *   - Credentials flow from browser → keychain; never through Claude, MCP
 *     messages, chat transcripts, or disk (beyond the OS-encrypted keystore)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { platform } from "node:os";
import { CredentialVault } from "./vault.js";
import type { Connector, ConnectorCredential } from "./connector-schema.js";

export type PromptStatus = "completed" | "timeout" | "error";

export interface PromptResult {
  status: PromptStatus;
  storedKeys: string[];
  /** Present only when status is "error". */
  error?: string;
}

export interface PromptOptions {
  /** Maximum time to wait for user submission. Default: 5 minutes. */
  timeoutMs?: number;
  /** If true, overwrite credentials that are already stored. */
  force?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function promptForCredentials(
  connector: Connector,
  options: PromptOptions = {}
): Promise<PromptResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const force = options.force ?? false;
  const vault = new CredentialVault();
  const token = randomBytes(32).toString("hex");

  // Determine which credentials need to be collected.
  const fieldsToCollect: ConnectorCredential[] = [];
  for (const cred of connector.credentials) {
    if (force) {
      fieldsToCollect.push(cred);
      continue;
    }
    const existing = await vault.get(connector.id, cred.key);
    if (!existing) {
      fieldsToCollect.push(cred);
    }
  }

  if (fieldsToCollect.length === 0) {
    return { status: "completed", storedKeys: [] };
  }

  return new Promise<PromptResult>((resolve) => {
    let resolved = false;
    let server: Server | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: PromptResult) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      server?.close();
      resolve(result);
    };

    timer = setTimeout(
      () => finish({ status: "timeout", storedKeys: [] }),
      timeoutMs
    );

    server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res, {
          connector,
          fieldsToCollect,
          token,
          vault,
          onSubmit: (storedKeys) =>
            finish({ status: "completed", storedKeys }),
        });
      } catch (err) {
        finish({
          status: "error",
          storedKeys: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    server.on("error", (err) => {
      finish({ status: "error", storedKeys: [], error: err.message });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (!addr || typeof addr === "string") {
        finish({
          status: "error",
          storedKeys: [],
          error: "Failed to determine server address",
        });
        return;
      }
      const url = `http://127.0.0.1:${addr.port}/?token=${token}`;
      openBrowser(url);
      // Also log to stderr so it's visible if the browser fails to open.
      console.error(`\nOpenConnectors: awaiting credentials at ${url}\n`);
    });
  });
}

interface HandleRequestContext {
  connector: Connector;
  fieldsToCollect: ConnectorCredential[];
  token: string;
  vault: CredentialVault;
  onSubmit: (storedKeys: string[]) => void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleRequestContext
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  // Security: ban any non-localhost access. Node binds only to 127.0.0.1
  // already, but double-check in case of proxies/oddities.
  const clientIp = req.socket.remoteAddress;
  if (clientIp !== "127.0.0.1" && clientIp !== "::ffff:127.0.0.1" && clientIp !== "::1") {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // GET / → render the form
  if (req.method === "GET" && url.pathname === "/") {
    const tokenParam = url.searchParams.get("token");
    if (tokenParam !== ctx.token) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Invalid or missing token");
      return;
    }
    const html = renderFormPage(ctx.connector, ctx.fieldsToCollect, ctx.token);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    });
    res.end(html);
    return;
  }

  // POST / → accept the form
  if (req.method === "POST" && url.pathname === "/") {
    const body = await readBody(req, 64 * 1024); // 64 KB cap
    const params = new URLSearchParams(body);

    if (params.get("token") !== ctx.token) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Invalid token");
      return;
    }

    const storedKeys: string[] = [];
    for (const cred of ctx.fieldsToCollect) {
      const value = params.get(cred.key);
      if (!value) continue; // skip empty fields — optional creds allowed
      await ctx.vault.set(ctx.connector.id, cred.key, value);
      storedKeys.push(cred.key);
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderSuccessPage());
    ctx.onSubmit(storedKeys);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function renderFormPage(
  connector: Connector,
  fields: ConnectorCredential[],
  token: string
): string {
  const isRtl = connector.institution.locale.toLowerCase().startsWith("he");
  const dir = isRtl ? "rtl" : "ltr";
  const lang = connector.institution.locale;

  const fieldHtml = fields
    .map((cred) => {
      const inputType =
        cred.type === "password" ? "password" :
        cred.type === "totp_secret" ? "password" :
        "text";
      const autocomplete =
        cred.type === "password" ? "current-password" :
        cred.type === "totp_secret" ? "one-time-code" :
        "username";
      const required = cred.optional ? "" : "required";
      const optionalTag = cred.optional
        ? ` <span class="optional">(optional)</span>`
        : "";
      return `
    <div class="field">
      <label for="${escapeHtml(cred.key)}">${escapeHtml(cred.label)}${optionalTag}</label>
      <input
        type="${inputType}"
        name="${escapeHtml(cred.key)}"
        id="${escapeHtml(cred.key)}"
        autocomplete="${autocomplete}"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        ${required}
      />
    </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>OpenConnectors — ${escapeHtml(connector.name)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 440px;
      margin: 40px auto;
      padding: 0 24px;
      line-height: 1.5;
    }
    h1 { font-size: 1.25rem; margin: 0 0 4px; }
    .subtitle {
      color: #666;
      font-size: 0.9rem;
      margin: 0 0 2em;
      word-break: break-all;
    }
    @media (prefers-color-scheme: dark) {
      .subtitle { color: #aaa; }
    }
    .field { margin-bottom: 1em; }
    label {
      display: block;
      font-weight: 500;
      margin-bottom: 6px;
      font-size: 0.95rem;
    }
    .optional { color: #888; font-weight: 400; font-size: 0.85rem; }
    input {
      width: 100%;
      padding: 10px 12px;
      font-size: 1rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      background: Canvas;
      color: CanvasText;
    }
    input:focus {
      outline: 2px solid #0066ff;
      outline-offset: 1px;
      border-color: transparent;
    }
    button {
      width: 100%;
      padding: 12px;
      font-size: 1rem;
      font-weight: 500;
      background: #000;
      color: #fff;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      margin-top: 8px;
    }
    button:hover { background: #333; }
    .security-note {
      font-size: 0.8rem;
      color: #666;
      margin-top: 2em;
      padding-top: 1em;
      border-top: 1px solid #eee;
    }
    @media (prefers-color-scheme: dark) {
      .security-note { color: #999; border-color: #333; }
      input { border-color: #444; }
    }
    code { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  </style>
</head>
<body>
  <h1>${escapeHtml(connector.name)}</h1>
  <p class="subtitle">${escapeHtml(connector.institution.url)}</p>
  <form method="POST" action="/">
    <input type="hidden" name="token" value="${escapeHtml(token)}" />
    ${fieldHtml}
    <button type="submit">Save to keychain</button>
  </form>
  <p class="security-note">
    Stored in your OS keychain via <code>@napi-rs/keyring</code> —
    never sent to Anthropic, never written to disk, never shown in chat.
    This form is served locally on <code>127.0.0.1</code>.
  </p>
</body>
</html>`;
}

function renderSuccessPage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Credentials saved</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 400px;
      margin: 120px auto;
      padding: 0 24px;
      text-align: center;
    }
    h1 { font-size: 1.4rem; }
    p { color: #666; }
    @media (prefers-color-scheme: dark) {
      body { color: #eee; background: #111; }
      p { color: #999; }
    }
  </style>
</head>
<body>
  <h1>Credentials saved</h1>
  <p>You can close this window.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function openBrowser(url: string): void {
  let command: string;
  switch (platform()) {
    case "darwin":
      command = `open "${url}"`;
      break;
    case "win32":
      // `start` is a cmd builtin; needs an empty title arg so it doesn't
      // interpret the URL as the title
      command = `cmd /c start "" "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
      break;
  }
  exec(command, (err) => {
    if (err) {
      console.error(
        `Could not auto-open browser — open this URL manually: ${url}`
      );
    }
  });
}
