#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildInspectReport, formatInspectSummary } from "./inspect";
import { verifyPlan } from "./verify";
import { approvePlan } from "./planner";
import { previewPlan, applyPlan } from "./applier";
import { PlanFile } from "./types";

function loadPlan(planPath: string): PlanFile {
  const resolved = resolve(planPath);
  const raw = readFileSync(resolved, "utf-8");
  return JSON.parse(raw) as PlanFile;
}

const server = new Server(
  { name: "gatefile", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gatefile_inspect",
      description:
        "Inspect a gatefile plan — returns a summary of what the plan contains, including operations, risk level, integrity status, and approval state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          planPath: {
            type: "string",
            description: "Path to the plan JSON file",
          },
          json: {
            type: "boolean",
            description:
              "Return machine-readable JSON instead of human summary (default: true)",
          },
        },
        required: ["planPath"],
      },
    },
    {
      name: "gatefile_verify",
      description:
        "Verify a gatefile plan's integrity — checks that the plan hash matches, approval is bound to the current content, and returns ready/not-ready status with any blockers.",
      inputSchema: {
        type: "object" as const,
        properties: {
          planPath: {
            type: "string",
            description: "Path to the plan JSON file",
          },
        },
        required: ["planPath"],
      },
    },
    {
      name: "gatefile_approve",
      description:
        "Approve a gatefile plan — binds approval to the exact plan hash. The plan file is updated in place with the approval record.",
      inputSchema: {
        type: "object" as const,
        properties: {
          planPath: {
            type: "string",
            description: "Path to the plan JSON file",
          },
          approvedBy: {
            type: "string",
            description: "Name or identifier of the approver (default: 'mcp-user')",
          },
        },
        required: ["planPath"],
      },
    },
    {
      name: "gatefile_apply",
      description:
        "Apply a gatefile plan — execute the plan's file changes and commands with safety guardrails. WARNING: When dryRun is false (the default), this executes real file writes and shell commands. Use dryRun: true to preview without executing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          planPath: {
            type: "string",
            description: "Path to the plan JSON file",
          },
          dryRun: {
            type: "boolean",
            description:
              "Preview what would happen without executing (default: true for safety)",
          },
        },
        required: ["planPath"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "gatefile_inspect": {
        const planPath = args?.planPath as string;
        const json = (args?.json as boolean) ?? true;
        const plan = loadPlan(planPath);
        const report = buildInspectReport(plan);

        if (json) {
          return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        }

        const summary = formatInspectSummary(plan, report);
        return { content: [{ type: "text", text: summary }] };
      }

      case "gatefile_verify": {
        const planPath = args?.planPath as string;
        const plan = loadPlan(planPath);
        const report = verifyPlan(plan);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      case "gatefile_approve": {
        const planPath = args?.planPath as string;
        const approvedBy = (args?.approvedBy as string) ?? "mcp-user";
        const plan = loadPlan(planPath);
        const approved = approvePlan(plan, approvedBy);
        const resolved = resolve(planPath);
        writeFileSync(resolved, JSON.stringify(approved, null, 2) + "\n", "utf-8");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "approved",
                  planId: approved.id,
                  approvedBy: approved.approval.approvedBy,
                  approvedPlanHash: approved.approval.approvedPlanHash,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "gatefile_apply": {
        const planPath = args?.planPath as string;
        const dryRun = (args?.dryRun as boolean) ?? true;
        const plan = loadPlan(planPath);

        if (dryRun) {
          const report = previewPlan(plan);
          return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        }

        const report = applyPlan(plan);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("gatefile MCP server failed to start:", error);
  process.exit(1);
});
