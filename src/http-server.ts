import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SuggestedAction } from "./contracts.ts";
import { DomainError } from "./errors.ts";
import { TriageService } from "./triage-service.ts";

interface RouteContext {
  service: TriageService;
  params: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const patternText = path.replace(/:([\w-]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${patternText}$`), paramNames, handler };
}

const ROUTES: Route[] = [
  route("GET", "/rules", ({ service }) => service.ruleVersions()),
  route("POST", "/devices", ({ service, body }) => {
    service.registerDevice(body);
    return { registered: true };
  }),
  route("POST", "/sessions", ({ service, body }) => {
    if (typeof body !== "object" || body === null) {
      return reject(400, "validation", "请求体必须是 JSON 对象");
    }
    const { submissionId, session } = body as Record<string, unknown>;
    if (typeof submissionId !== "string") {
      return reject(400, "validation", "submissionId 必须是字符串");
    }
    return service.submit(session, submissionId);
  }),
  route("GET", "/sessions/:id", ({ service, params }) =>
    service.record(params.id!),
  ),
  route("GET", "/queue", ({ service }) => ({ items: service.urgentQueue() })),
  route("POST", "/sessions/:id/claim", ({ service, params, body }) => {
    const { staffId } = staffBody(body);
    return service.claim(params.id!, staffId);
  }),
  route("POST", "/sessions/:id/confirm", ({ service, params, body }) => {
    const { staffId, note } = staffBody(body);
    return service.confirm(params.id!, staffId, note);
  }),
  route("POST", "/sessions/:id/correct", ({ service, params, body }) => {
    if (typeof body !== "object" || body === null) {
      return reject(400, "validation", "请求体必须是 JSON 对象");
    }
    const obj = body as Record<string, unknown>;
    if (typeof obj.staffId !== "string" || obj.staffId.trim() === "") {
      return reject(400, "validation", "staffId 必须是非空字符串");
    }
    const action = obj.action;
    if (
      action !== "remeasure" &&
      action !== "contact-soon" &&
      action !== "seek-care-now"
    ) {
      return reject(400, "validation", "action 必须是三种分诊行动之一");
    }
    const note = typeof obj.note === "string" ? obj.note : undefined;
    return service.correct(params.id!, obj.staffId, action as SuggestedAction, {
      ...(note !== undefined ? { note } : {}),
    });
  }),
];

function staffBody(body: unknown): { staffId: string; note?: string } {
  if (typeof body !== "object" || body === null) {
    return reject(400, "validation", "请求体必须是 JSON 对象");
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.staffId !== "string" || obj.staffId.trim() === "") {
    return reject(400, "validation", "staffId 必须是非空字符串");
  }
  return {
    staffId: obj.staffId,
    ...(typeof obj.note === "string" ? { note: obj.note } : {}),
  };
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reject(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

const DOMAIN_STATUS: Record<string, number> = {
  validation: 400,
  "device-conflict": 409,
  "not-found": 404,
  "not-in-queue": 409,
  "already-claimed": 409,
  "invalid-review-state": 409,
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).length > 1_048_576) {
      return reject(413, "payload-too-large", "请求体超过 1 MiB");
    }
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reject(400, "invalid-json", "请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function createTriageServer(service: TriageService): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = ROUTES.find(
          (r) =>
            r.method === req.method &&
            r.pattern.test(url.pathname),
        );
        if (!match) {
          sendJson(res, 404, { error: { code: "not-found", message: "接口不存在" } });
          return;
        }
        const parts = match.pattern.exec(url.pathname)!;
        const params: Record<string, string> = {};
        match.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(parts[i + 1]!);
        });
        const body = await readJson(req);
        const result = await match.handler({ service, params, body });
        sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { error: { code: err.code, message: err.message } });
          return;
        }
        if (err instanceof DomainError) {
          const status = DOMAIN_STATUS[err.code] ?? 500;
          sendJson(res, status, { error: { code: err.code, message: err.message } });
          return;
        }
        const message = err instanceof Error ? err.message : "未知错误";
        sendJson(res, 500, { error: { code: "internal", message } });
      }
    })();
  });
}
