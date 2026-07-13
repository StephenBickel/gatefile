#!/usr/bin/env node
/**
 * Gatefile MCP Server
 *
 * Exposes gatefile operations as MCP tools over stdio (JSON-RPC 2.0).
 * Zero dependencies — speaks the protocol directly.
 *
 * Usage:
 *   gatefile mcp          (from CLI)
 *   npx gatefile mcp      (from MCP client config)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { createPlanFromDraft, approvePlan, PlanDraft } from "./planner";
import { applyPlan, previewPlan, rollbackApply } from "./applier";
import { buildInspectReport, formatInspectSummary } from "./inspect";
import { verifyPlan } from "./verify";
import { loadGatefileConfig } from "./config";
import { getRepoRoot } from "./state";
import { PlanFile } from "./types";

/* ------------------------------------------------------------------ */
/*  JSON-RPC helpers                                                   */
/* ------------------------------------------------------------------ */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function respond(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function respondError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function send(msg: JsonRpcResponse): void {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

/* ------------------------------------------------------------------ */
/*  File I/O helpers                                                   */
/* ------------------------------------------------------------------ */

function readPlan(path: string): PlanFile {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`Plan file not found: ${full}`);
  return JSON.parse(readFileSync(full, "utf-8")) as PlanFile;
}

function writePlan(path: string, plan: PlanFile): void {
  writeFileSync(resolve(path), JSON.stringify(plan, null, 2) + "\n", "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                   */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "inspect_plan",
    description:
      "Inspect a gatefile plan. Shows plan ID, summary, operations, risk level, integrity status, approval status, and whether the plan is ready to apply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the plan JSON file"
        },
        json: {
          type: "boolean",
          description: "Return machine-readable JSON instead of human summary (default: false)"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "create_plan",
    description:
      "Create a new gatefile plan from a draft. The draft specifies file and command operations the agent wants to execute. Returns the plan with a unique ID, risk score, and integrity hash.",
    inputSchema: {
      type: "object" as const,
      properties: {
        draft: {
          type: "object",
          description:
            "Plan draft object with: source (string), summary (string), operations (array of file/command ops), preconditions (optional array), execution (optional config), dependsOn (optional string array)"
        },
        out: {
          type: "string",
          description: "Path to write the created plan JSON file"
        }
      },
      required: ["draft", "out"]
    }
  },
  {
    name: "approve_plan",
    description:
      "Approve a gatefile plan. Locks the approval to the current plan hash so any tampering after approval is detected. Optionally sign with an Ed25519 attestation key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the plan JSON file"
        },
        by: {
          type: "string",
          description: "Name of the approver"
        },
        signing_key: {
          type: "string",
          description: "Optional path to Ed25519 private key PEM for signed approval"
        },
        key_id: {
          type: "string",
          description: "Optional key ID (requires signing_key)"
        }
      },
      required: ["path", "by"]
    }
  },
  {
    name: "verify_plan",
    description:
      "Verify a plan's integrity, approval status, and signer trust. Returns whether the plan is ready to apply and lists any blockers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the plan JSON file"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "dry_run_plan",
    description:
      "Preview what applying a plan would do without executing anything. Shows each operation that would run, file path safety checks, and recovery guidance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the plan JSON file"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "apply_plan",
    description:
      "Apply an approved plan — executes file writes and structured commands. Creates a pre-apply snapshot for rollback. Only works on verified, approved plans.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path to the plan JSON file"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "rollback_apply",
    description:
      "Rollback a previously applied plan using its receipt ID. Restores files from the pre-apply snapshot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        receipt_id: {
          type: "string",
          description: "Receipt ID from the apply report"
        }
      },
      required: ["receipt_id"]
    }
  }
];

/* ------------------------------------------------------------------ */
/*  Tool handlers                                                      */
/* ------------------------------------------------------------------ */

function toolResult(text: string, isError = false): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

function handleTool(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; isError: boolean } {
  try {
    switch (name) {
      case "inspect_plan": {
        const plan = readPlan(args.path as string);
        const report = buildInspectReport(plan, { repoRoot: getRepoRoot() });
        if (args.json) {
          return toolResult(JSON.stringify(report, null, 2));
        }
        const config = loadGatefileConfig(getRepoRoot());
        return toolResult(formatInspectSummary(plan, report, { config }));
      }

      case "create_plan": {
        const draft = args.draft as PlanDraft;
        const plan = createPlanFromDraft(draft, { repoRoot: getRepoRoot() });
        const outPath = args.out as string;
        writePlan(outPath, plan);
        return toolResult(
          `Plan created: ${outPath}\nID: ${plan.id}\nRisk: ${plan.risk.level} (score ${plan.risk.score})\nOperations: ${plan.operations.length}\nStatus: ${plan.approval.status}`
        );
      }

      case "approve_plan": {
        const planPath = args.path as string;
        const plan = readPlan(planPath);
        const signingKeyPem = args.signing_key
          ? readFileSync(resolve(args.signing_key as string), "utf-8")
          : undefined;
        const approved = approvePlan(plan, args.by as string, {
          signingPrivateKeyPem: signingKeyPem,
          signingKeyId: args.key_id as string | undefined
        });
        writePlan(planPath, approved);
        return toolResult(`Plan approved by ${args.by}: ${planPath}`);
      }

      case "verify_plan": {
        const plan = readPlan(args.path as string);
        const config = loadGatefileConfig(getRepoRoot());
        const report = verifyPlan(plan, { config });
        return toolResult(JSON.stringify(report, null, 2));
      }

      case "dry_run_plan": {
        const plan = readPlan(args.path as string);
        const repoRoot = getRepoRoot();
        const config = loadGatefileConfig(repoRoot);
        const preview = previewPlan(plan, {
          repoRoot,
          planPath: resolve(args.path as string),
          config
        });
        return toolResult(JSON.stringify(preview, null, 2));
      }

      case "apply_plan": {
        const planPath = args.path as string;
        const plan = readPlan(planPath);
        const repoRoot = getRepoRoot();
        const config = loadGatefileConfig(repoRoot);
        const report = applyPlan(plan, {
          repoRoot,
          planPath: resolve(planPath),
          config
        });
        return toolResult(JSON.stringify(report, null, 2));
      }

      case "rollback_apply": {
        const report = rollbackApply(args.receipt_id as string, {
          repoRoot: getRepoRoot()
        });
        return toolResult(JSON.stringify(report, null, 2));
      }

      default:
        return toolResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    return toolResult(`Error: ${(error as Error).message}`, true);
  }
}

/* ------------------------------------------------------------------ */
/*  MCP protocol handler                                               */
/* ------------------------------------------------------------------ */

const SERVER_INFO = {
  name: "gatefile",
  version: "0.1.1"
};

function handleMessage(req: JsonRpcRequest): JsonRpcResponse | null {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return respond(id ?? null, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });

    case "notifications/initialized":
      // Notification — no response
      return null;

    case "tools/list":
      return respond(id ?? null, { tools: TOOLS });

    case "tools/call": {
      const toolName = (params as { name?: string })?.name;
      const toolArgs = ((params as { arguments?: Record<string, unknown> })?.arguments) ?? {};
      if (!toolName) {
        return respondError(id ?? null, -32602, "Missing tool name");
      }
      const result = handleTool(toolName, toolArgs);
      return respond(id ?? null, result);
    }

    case "ping":
      return respond(id ?? null, {});

    default:
      // Unknown method — if it has an id, respond with error; otherwise ignore
      if (id != null) {
        return respondError(id, -32601, `Method not found: ${method}`);
      }
      return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Main: stdio transport                                              */
/* ------------------------------------------------------------------ */

export function startMcpServer(): void {
  // Prevent any accidental console.log from polluting the protocol
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    origError("[gatefile-mcp debug]", ...args);
  };

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send(respondError(null, -32700, "Parse error"));
      return;
    }

    const response = handleMessage(req);
    if (response) {
      send(response);
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });

  // Keep alive
  process.stdin.resume();
}
