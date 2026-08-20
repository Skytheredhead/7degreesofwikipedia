import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const listenHost = process.env.LISTEN_HOST ?? "127.0.0.1";
const listenPort = Number(process.env.LISTEN_PORT ?? 7878);
const backendHost = process.env.BACKEND_HOST ?? "127.0.0.1";
const backendPort = Number(process.env.BACKEND_PORT ?? 7879);
const backendUnit = process.env.BACKEND_UNIT ?? "7wiki-backend.service";
const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS ?? 90_000);
const startTimeoutMs = Number(process.env.START_TIMEOUT_MS ?? 120_000);

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

let activeRequests = 0;
let lastLiveActivityAt = 0;
let startPromise = null;
let stopPromise = null;

async function systemctl(...args) {
  return execFileAsync("systemctl", ["--user", ...args], { timeout: startTimeoutMs });
}

async function backendIsActive() {
  try {
    await systemctl("is-active", "--quiet", backendUnit);
    return true;
  } catch {
    return false;
  }
}

async function backendAcceptsConnections() {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: backendHost,
        port: backendPort,
        path: "/health",
        method: "GET",
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });
}

async function waitForBackend() {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (await backendAcceptsConnections()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${backendUnit} on ${backendHost}:${backendPort}.`);
}

async function ensureBackend() {
  if (await backendAcceptsConnections()) return;
  if (!startPromise) {
    startPromise = (async () => {
      await systemctl("start", backendUnit);
      await waitForBackend();
    })().finally(() => {
      startPromise = null;
    });
  }
  await startPromise;
}

async function stopBackendIfIdle() {
  if (
    stopPromise ||
    startPromise ||
    activeRequests > 0 ||
    lastLiveActivityAt === 0 ||
    Date.now() - lastLiveActivityAt < idleTimeoutMs
  ) {
    return;
  }

  stopPromise = (async () => {
    if (await backendIsActive()) {
      await systemctl("stop", backendUnit);
    }
    lastLiveActivityAt = 0;
  })()
    .catch((error) => console.error("Failed to stop idle 7wiki backend:", error))
    .finally(() => {
      stopPromise = null;
    });
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

async function handleHealth(request, response) {
  const state = (await backendIsActive()) ? "awake" : "sleeping";
  sendJson(response, 200, {
    ok: true,
    status: {
      lazy: true,
      state,
      idleTimeoutMs,
    },
  });
}

async function handleHeartbeat(request, response) {
  lastLiveActivityAt = Date.now();
  await ensureBackend();
  response.writeHead(204, {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": request.headers.origin ?? "*",
    "cache-control": "no-store",
    vary: "Origin",
  });
  response.end();
}

function proxyToBackend(request, response) {
  lastLiveActivityAt = Date.now();
  activeRequests += 1;

  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers.host = `${backendHost}:${backendPort}`;

  const upstream = http.request(
    {
      host: backendHost,
      port: backendPort,
      path: request.url,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!hopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
          responseHeaders[name] = value;
        }
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );

  let requestFinished = false;
  const finishRequest = () => {
    if (requestFinished) return;
    requestFinished = true;
    activeRequests = Math.max(0, activeRequests - 1);
  };

  upstream.once("error", (error) => {
    finishRequest();
    if (!response.headersSent) {
      sendJson(response, 502, { ok: false, error: "backend_proxy_failed", message: error.message });
    } else {
      response.destroy(error);
    }
  });
  response.once("close", finishRequest);
  response.once("finish", finishRequest);
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      await handleHealth(request, response);
      return;
    }
    if (url.pathname === "/live") {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-origin": request.headers.origin ?? "*",
          "access-control-max-age": "86400",
          vary: "Origin",
        });
        response.end();
        return;
      }
      await handleHeartbeat(request, response);
      return;
    }

    lastLiveActivityAt = Date.now();
    await ensureBackend();
    proxyToBackend(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start 7wiki backend.";
    sendJson(response, 503, { ok: false, error: "backend_start_failed", message });
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

const idleTimer = setInterval(() => void stopBackendIfIdle(), 10_000);
idleTimer.unref();

server.listen(listenPort, listenHost, () => {
  console.log(
    `7wiki lazy proxy listening on ${listenHost}:${listenPort}; backend ${backendUnit} uses ${backendHost}:${backendPort}.`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    clearInterval(idleTimer);
    server.close(() => process.exit(0));
  });
}
