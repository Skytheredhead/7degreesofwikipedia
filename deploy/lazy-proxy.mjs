import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
const minAvailableMemoryBytes = Number(
  process.env.MIN_AVAILABLE_MEMORY_BYTES ?? 12 * 1024 ** 3,
);

if (!Number.isFinite(minAvailableMemoryBytes) || minAvailableMemoryBytes <= 0) {
  throw new Error("MIN_AVAILABLE_MEMORY_BYTES must be a positive number.");
}

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

class InsufficientMemoryError extends Error {
  constructor(availableBytes, requiredBytes) {
    super(
      `7wiki needs at least ${formatGiB(requiredBytes)} GiB of available memory to start, ` +
        `but only ${formatGiB(availableBytes)} GiB is available. ` +
        "Try again after other server workloads stop.",
    );
    this.name = "InsufficientMemoryError";
    this.availableBytes = availableBytes;
    this.requiredBytes = requiredBytes;
  }
}

function formatGiB(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

async function readMemoryStatus() {
  const meminfo = await readFile("/proc/meminfo", "utf8");
  const availableMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  const totalMatch = meminfo.match(/^MemTotal:\s+(\d+)\s+kB$/m);
  if (!availableMatch || !totalMatch) {
    throw new Error("Unable to determine available server memory from /proc/meminfo.");
  }

  return {
    availableBytes: Number(availableMatch[1]) * 1024,
    totalBytes: Number(totalMatch[1]) * 1024,
  };
}

async function assertEnoughMemoryToStart() {
  const memory = await readMemoryStatus();
  if (memory.availableBytes < minAvailableMemoryBytes) {
    throw new InsufficientMemoryError(memory.availableBytes, minAvailableMemoryBytes);
  }
}

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
      if (!(await backendIsActive())) {
        await assertEnoughMemoryToStart();
        await systemctl("start", backendUnit);
      }
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

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function corsHeaders(request) {
  return {
    "access-control-allow-origin": request.headers.origin ?? "*",
    vary: "Origin",
  };
}

function sendStartFailure(request, response, error) {
  if (error instanceof InsufficientMemoryError) {
    sendJson(
      response,
      503,
      {
        ok: false,
        error: "insufficient_memory",
        message: error.message,
        memory: {
          availableBytes: error.availableBytes,
          requiredBytes: error.requiredBytes,
        },
      },
      corsHeaders(request),
    );
    return;
  }

  const message = error instanceof Error ? error.message : "Unable to start 7wiki backend.";
  sendJson(
    response,
    503,
    { ok: false, error: "backend_start_failed", message },
    corsHeaders(request),
  );
}

async function handleHealth(request, response) {
  const state = (await backendIsActive()) ? "awake" : "sleeping";
  let memory;
  try {
    const currentMemory = await readMemoryStatus();
    memory = {
      ...currentMemory,
      requiredBytes: minAvailableMemoryBytes,
      canStart: state === "awake" || currentMemory.availableBytes >= minAvailableMemoryBytes,
    };
  } catch (error) {
    memory = {
      availableBytes: null,
      requiredBytes: minAvailableMemoryBytes,
      canStart: state === "awake",
      error: error instanceof Error ? error.message : "Unable to read server memory.",
    };
  }
  sendJson(response, 200, {
    ok: true,
    status: {
      lazy: true,
      state,
      idleTimeoutMs,
      memory,
    },
  });
}

async function handleHeartbeat(request, response) {
  await ensureBackend();
  lastLiveActivityAt = Date.now();
  response.writeHead(204, {
    "access-control-allow-methods": "POST, OPTIONS",
    "cache-control": "no-store",
    ...corsHeaders(request),
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

    await ensureBackend();
    lastLiveActivityAt = Date.now();
    proxyToBackend(request, response);
  } catch (error) {
    sendStartFailure(request, response, error);
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
