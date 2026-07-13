#!/usr/bin/env node

import { GatefileEngine } from "./engine";
import type { GatefileEngineOptions } from "./engine";
import {
  assertConfinedRelativePath,
  readConfinedUtf8,
  writeConfinedUtf8Atomic
} from "./confined-io";
import type {
  ApprovePlanOptions,
  PlanDraft
} from "./planner";
import type { PlanFile } from "./types";
import { validatePlanFile } from "./validation";

type JsonRpcId = string | number;

export interface McpServerCapabilities {
  approve?: boolean;
  apply?: boolean;
  rollback?: boolean;
}

export interface McpApprovalOptions extends ApprovePlanOptions {
  approvedBy: string;
}

export interface McpServerOptions extends GatefileEngineOptions {
  capabilities?: McpServerCapabilities;
  approval?: McpApprovalOptions;
  maxMessageBytes?: number;
}

export interface McpServerHandle {
  close(): void;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly notification: boolean;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

type DecodedLine =
  | { readonly kind: "request"; readonly request: JsonRpcRequest }
  | { readonly kind: "error"; readonly response: JsonRpcResponse }
  | { readonly kind: "notification" };

interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError: boolean;
}

type ArgumentKind = "string" | "boolean" | "object";

interface ToolArgumentContract {
  readonly kind: ArgumentKind;
  readonly required?: boolean;
  readonly path?: boolean;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly arguments: Readonly<Record<string, ToolArgumentContract>>;
  readonly handler: (args: Record<string, unknown>) => ToolResult;
}

interface PublicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, {
      readonly type: ArgumentKind;
      readonly description: string;
    }>>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export interface McpDispatcher {
  readonly tools: readonly PublicToolDefinition[];
  dispatch(request: JsonRpcRequest): JsonRpcResponse | undefined;
}

const PACKAGE_VERSION = (require("../package.json") as { version: string }).version;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_MESSAGE_BYTES = 16 * 1024 * 1024;
const MCP_COMMAND_CAPTURE_BYTES = 8192;
const JSON_RPC_KEYS = new Set(["jsonrpc", "id", "method", "params"]);
const STARTUP_OPTION_KEYS = new Set([
  "repoRoot",
  "repositoryId",
  "stateHome",
  "config",
  "capabilities",
  "approval",
  "maxMessageBytes"
]);
const CAPABILITY_KEYS = new Set(["approve", "apply", "rollback"]);
const APPROVAL_KEYS = new Set([
  "approvedBy",
  "signingPrivateKeyPem",
  "signingKeyId"
]);

const SERVER_INFO = Object.freeze({
  name: "gatefile",
  version: PACKAGE_VERSION
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function respond(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function respondError(
  id: JsonRpcId | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function invalidRequest(): DecodedLine {
  return {
    kind: "error",
    response: respondError(null, -32600, "Invalid Request")
  };
}

export function decodeJsonRpcLine(line: string): DecodedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return {
      kind: "error",
      response: respondError(null, -32700, "Parse error")
    };
  }

  if (!isPlainObject(parsed)) return invalidRequest();
  const idPresent = own(parsed, "id");
  const envelopeCouldBeNotification =
    !idPresent && parsed.jsonrpc === "2.0" &&
    typeof parsed.method === "string" && parsed.method.length > 0;

  if (!hasOnlyKeys(parsed, JSON_RPC_KEYS)) {
    return envelopeCouldBeNotification ? { kind: "notification" } : invalidRequest();
  }
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string" || parsed.method.length === 0) {
    return invalidRequest();
  }

  if (idPresent) {
    const id = parsed.id;
    if (
      !(
        typeof id === "string" ||
        (typeof id === "number" && Number.isSafeInteger(id))
      )
    ) {
      return invalidRequest();
    }
  }

  if (own(parsed, "params") && !isPlainObject(parsed.params)) {
    if (!idPresent) return { kind: "notification" };
    return {
      kind: "error",
      response: respondError(parsed.id as JsonRpcId, -32602, "Invalid params")
    };
  }

  if (!idPresent) return { kind: "notification" };
  return {
    kind: "request",
    request: {
      jsonrpc: "2.0",
      id: parsed.id as JsonRpcId,
      method: parsed.method,
      ...(own(parsed, "params") ? { params: parsed.params as Record<string, unknown> } : {}),
      notification: false
    }
  };
}

function toolResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function parsePlan(engine: GatefileEngine, requestedPath: string): {
  readonly absolutePath: string;
  readonly plan: PlanFile;
  readonly revision: ReturnType<typeof readConfinedUtf8>["revision"];
} {
  const confined = readConfinedUtf8(engine.context.repoRoot, requestedPath);
  let value: unknown;
  try {
    value = JSON.parse(confined.contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid plan JSON at ${requestedPath}: ${(error as Error).message}`);
  }
  return {
    absolutePath: confined.absolutePath,
    plan: validatePlanFile(value as PlanFile),
    revision: confined.revision
  };
}

function serializePlan(plan: PlanFile): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function assertStartupOptions(options: McpServerOptions): void {
  if (!isPlainObject(options) || !hasOnlyKeys(options as Record<string, unknown>, STARTUP_OPTION_KEYS)) {
    throw new TypeError("MCP startup options contain unsupported fields");
  }
  if (options.capabilities !== undefined) {
    if (
      !isPlainObject(options.capabilities) ||
      !hasOnlyKeys(options.capabilities as Record<string, unknown>, CAPABILITY_KEYS) ||
      Object.values(options.capabilities).some((value) => typeof value !== "boolean")
    ) {
      throw new TypeError("MCP capabilities must contain only boolean approve/apply/rollback fields");
    }
  }
  if (options.approval !== undefined) {
    if (
      !isPlainObject(options.approval) ||
      !hasOnlyKeys(options.approval as unknown as Record<string, unknown>, APPROVAL_KEYS) ||
      typeof options.approval.approvedBy !== "string" ||
      options.approval.approvedBy.trim().length === 0 ||
      (options.approval.signingPrivateKeyPem !== undefined &&
        typeof options.approval.signingPrivateKeyPem !== "string") ||
      (options.approval.signingKeyId !== undefined &&
        typeof options.approval.signingKeyId !== "string") ||
      (options.approval.signingKeyId !== undefined &&
        options.approval.signingPrivateKeyPem === undefined)
    ) {
      throw new TypeError(
        "MCP approval startup configuration requires a non-empty approvedBy and valid in-memory signing options"
      );
    }
  }
  const maxMessageBytes = options.maxMessageBytes;
  if (
    maxMessageBytes !== undefined &&
    (typeof maxMessageBytes !== "number" ||
      !Number.isSafeInteger(maxMessageBytes) ||
      maxMessageBytes < 64 ||
      maxMessageBytes > MAX_CONFIGURED_MESSAGE_BYTES)
  ) {
    throw new TypeError(
      `MCP maxMessageBytes must be an integer between 64 and ${MAX_CONFIGURED_MESSAGE_BYTES}`
    );
  }
}

function argumentDescription(name: string): string {
  switch (name) {
    case "path":
      return "Repository-relative path to a plan JSON file";
    case "out":
      return "Repository-relative output path for the new plan JSON file";
    case "draft":
      return "Gatefile plan draft object";
    case "json":
      return "Return machine-readable JSON instead of a human summary";
    case "receipt_id":
      return "Receipt ID from an apply report in the pinned state namespace";
    default:
      return name;
  }
}

function publicTool(tool: ToolDefinition): PublicToolDefinition {
  const properties: Record<string, {
    type: ArgumentKind;
    description: string;
  }> = {};
  const required: string[] = [];
  for (const [name, contract] of Object.entries(tool.arguments)) {
    properties[name] = {
      type: contract.kind,
      description: argumentDescription(name)
    };
    if (contract.required) required.push(name);
  }
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: Object.freeze({
      type: "object" as const,
      properties: Object.freeze(properties),
      required: Object.freeze(required),
      additionalProperties: false as const
    })
  });
}

function validateToolArguments(
  tool: ToolDefinition,
  args: unknown
): args is Record<string, unknown> {
  if (!isPlainObject(args)) return false;
  const allowed = new Set(Object.keys(tool.arguments));
  if (!hasOnlyKeys(args, allowed)) return false;
  for (const [name, contract] of Object.entries(tool.arguments)) {
    if (!own(args, name)) {
      if (contract.required) return false;
      continue;
    }
    const value = args[name];
    if (contract.kind === "object") {
      if (!isPlainObject(value)) return false;
    } else if (typeof value !== contract.kind) {
      return false;
    }
    if (contract.kind === "string" && (value as string).length === 0) return false;
    if (contract.path) {
      try {
        assertConfinedRelativePath(value as string);
      } catch {
        return false;
      }
    }
  }
  return true;
}

function emptyParams(params: Record<string, unknown> | undefined): boolean {
  return params === undefined || Object.keys(params).length === 0;
}

export function createMcpDispatcher(options: McpServerOptions = {}): McpDispatcher {
  assertStartupOptions(options);
  const capabilities = Object.freeze({
    approve: options.capabilities?.approve === true,
    apply: options.capabilities?.apply === true,
    rollback: options.capabilities?.rollback === true
  });
  const approval = options.approval === undefined
    ? undefined
    : Object.freeze({ ...options.approval });
  const engine = new GatefileEngine({
    repoRoot: options.repoRoot,
    repositoryId: options.repositoryId,
    stateHome: options.stateHome,
    config: options.config
  });

  const tools: ToolDefinition[] = [
    {
      name: "inspect_plan",
      description: "Inspect a plan using the server's pinned repository and policy context.",
      arguments: {
        path: { kind: "string", required: true, path: true },
        json: { kind: "boolean" }
      },
      handler(args) {
        const { plan } = parsePlan(engine, args.path as string);
        const report = engine.inspectPlan(plan);
        return args.json === true
          ? toolResult(JSON.stringify(report, null, 2))
          : toolResult(engine.formatInspectPlan(plan, report));
      }
    },
    {
      name: "create_plan",
      description: "Create a plan bound to the server's pinned repository authority.",
      arguments: {
        draft: { kind: "object", required: true },
        out: { kind: "string", required: true, path: true }
      },
      handler(args) {
        const plan = engine.createPlan(args.draft as unknown as PlanDraft);
        const out = args.out as string;
        writeConfinedUtf8Atomic(engine.context.repoRoot, out, serializePlan(plan));
        return toolResult(
          `Plan created: ${out}\nID: ${plan.id}\nRisk: ${plan.risk.level} (score ${plan.risk.score})\nOperations: ${plan.operations.length}\nStatus: ${plan.approval.status}`
        );
      }
    },
    {
      name: "verify_plan",
      description: "Verify a plan using the server's pinned repository identity and policy.",
      arguments: {
        path: { kind: "string", required: true, path: true }
      },
      handler(args) {
        const { plan } = parsePlan(engine, args.path as string);
        return toolResult(JSON.stringify(engine.verifyPlan(plan), null, 2));
      }
    },
    {
      name: "dry_run_plan",
      description: "Preview a plan without executing operations.",
      arguments: {
        path: { kind: "string", required: true, path: true }
      },
      handler(args) {
        const { absolutePath, plan } = parsePlan(engine, args.path as string);
        return toolResult(
          JSON.stringify(engine.previewPlan(plan, { planPath: absolutePath }), null, 2)
        );
      }
    }
  ];

  if (capabilities.approve && approval !== undefined) {
    tools.splice(2, 0, {
      name: "approve_plan",
      description: "Approve a plan using startup-configured approver and signing authority.",
      arguments: {
        path: { kind: "string", required: true, path: true }
      },
      handler(args) {
        const requestedPath = args.path as string;
        const { absolutePath, plan, revision } = parsePlan(engine, requestedPath);
        const { approvedBy, ...approvalOptions } = approval;
        const approved = engine.approvePlan(plan, approvedBy, {
          ...approvalOptions,
          planPath: absolutePath
        });
        writeConfinedUtf8Atomic(
          engine.context.repoRoot,
          requestedPath,
          serializePlan(approved),
          { expectedRevision: revision }
        );
        return toolResult(`Plan approved by ${approvedBy}: ${requestedPath}`);
      }
    });
  }

  if (capabilities.apply) {
    tools.push({
      name: "apply_plan",
      description: "Apply a verified plan using explicitly enabled startup authority.",
      arguments: {
        path: { kind: "string", required: true, path: true }
      },
      handler(args) {
        const { absolutePath, plan } = parsePlan(engine, args.path as string);
        const report = engine.applyPlan(plan, {
          planPath: absolutePath,
          commandOutput: { mode: "capture", maxBytes: MCP_COMMAND_CAPTURE_BYTES }
        });
        return toolResult(JSON.stringify(report, null, 2), !report.success);
      }
    });
  }

  if (capabilities.rollback) {
    tools.push({
      name: "rollback_apply",
      description: "Rollback an apply receipt using explicitly enabled startup authority.",
      arguments: {
        receipt_id: { kind: "string", required: true }
      },
      handler(args) {
        const report = engine.rollbackApply(args.receipt_id as string);
        return toolResult(JSON.stringify(report, null, 2), !report.success);
      }
    });
  }

  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  const publicTools = Object.freeze(tools.map(publicTool));

  return Object.freeze({
    tools: publicTools,
    dispatch(request: JsonRpcRequest): JsonRpcResponse | undefined {
      if (request.notification) return undefined;
      const id = request.id as JsonRpcId;
      switch (request.method) {
        case "initialize":
          return respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          });
        case "ping":
          return emptyParams(request.params)
            ? respond(id, {})
            : respondError(id, -32602, "Invalid params");
        case "tools/list":
          return emptyParams(request.params)
            ? respond(id, { tools: publicTools })
            : respondError(id, -32602, "Invalid params");
        case "tools/call": {
          if (
            !isPlainObject(request.params) ||
            !hasOnlyKeys(request.params, new Set(["name", "arguments"])) ||
            typeof request.params.name !== "string" ||
            request.params.name.length === 0 ||
            !own(request.params, "arguments")
          ) {
            return respondError(id, -32602, "Invalid params");
          }
          const tool = toolByName.get(request.params.name);
          if (tool === undefined) {
            return respondError(id, -32601, "Method not found");
          }
          if (!validateToolArguments(tool, request.params.arguments)) {
            return respondError(id, -32602, "Invalid params");
          }
          try {
            return respond(id, tool.handler(request.params.arguments));
          } catch (error) {
            return respond(id, toolResult(`Error: ${(error as Error).message}`, true));
          }
        }
        default:
          return respondError(id, -32601, "Method not found");
      }
    }
  });
}

function maximumMessageBytes(options: McpServerOptions): number {
  return options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
}

export function startMcpServer(options: McpServerOptions = {}): McpServerHandle {
  const dispatcher = createMcpDispatcher(options);
  const maxMessageBytes = maximumMessageBytes(options);
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;
  const originalError = console.error;
  const redirectConsole = (...args: unknown[]): void => {
    originalError("[gatefile-mcp]", ...args);
  };
  console.log = redirectConsole;
  console.info = redirectConsole;
  console.debug = redirectConsole;

  let closed = false;
  let oversized = false;
  let lineBytes = 0;
  let lineChunks: Buffer[] = [];

  const send = (response: JsonRpcResponse): void => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  };

  const resetLine = (): void => {
    oversized = false;
    lineBytes = 0;
    lineChunks = [];
  };

  const append = (segment: Buffer): void => {
    if (oversized || segment.length === 0) return;
    if (lineBytes + segment.length > maxMessageBytes) {
      oversized = true;
      lineBytes = 0;
      lineChunks = [];
      return;
    }
    lineBytes += segment.length;
    lineChunks.push(segment);
  };

  const finishLine = (): void => {
    if (oversized) {
      send(
        respondError(
          null,
          -32600,
          `Request line exceeds ${maxMessageBytes} bytes`
        )
      );
      resetLine();
      return;
    }
    if (lineBytes === 0) {
      resetLine();
      return;
    }
    let bytes = Buffer.concat(lineChunks, lineBytes);
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
      bytes = bytes.subarray(0, -1);
    }
    const line = bytes.toString("utf8");
    resetLine();
    if (line.trim().length === 0) return;
    const decoded = decodeJsonRpcLine(line);
    if (decoded.kind === "error") {
      send(decoded.response);
      return;
    }
    if (decoded.kind === "notification") return;
    const response = dispatcher.dispatch(decoded.request);
    if (response !== undefined) send(response);
  };

  const onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        append(bytes.subarray(offset));
        return;
      }
      append(bytes.subarray(offset, newline));
      finishLine();
      offset = newline + 1;
    }
  };

  const restore = (): void => {
    console.log = originalLog;
    console.info = originalInfo;
    console.debug = originalDebug;
    console.error = originalError;
  };

  const detach = (): void => {
    if (closed) return;
    closed = true;
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("close", onClose);
    process.stdin.pause();
    restore();
  };

  const onEnd = (): void => {
    if (closed) return;
    if (oversized || lineBytes > 0) finishLine();
    detach();
  };

  const onClose = (): void => {
    if (closed) return;
    if (oversized || lineBytes > 0) finishLine();
    detach();
  };

  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onClose);
  process.stdin.resume();

  return Object.freeze({ close: detach });
}
