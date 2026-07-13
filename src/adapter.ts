import { CommandOperation, ExecutionConfig, FileAction, FileOperation, PLAN_VERSION, Precondition } from "./types";
import { PlanDraft } from "./planner";
import { validateCommandOperationValue } from "./command";
import { validatePlanDraft } from "./validation";

export interface AdapterFileChange {
  id?: string;
  action: FileAction;
  path: string;
  before?: string;
  after?: string;
}

export interface AdapterCommand {
  id?: string;
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export interface AgentProposalInput {
  source?: string;
  summary: string;
  fileChanges?: AdapterFileChange[];
  commands?: AdapterCommand[];
  preconditions?: Precondition[];
  execution?: ExecutionConfig;
}

export interface AgentEnvelopeInput {
  agent?: {
    name?: string;
  };
  proposal: AgentProposalInput;
}

export type AgentAdapterInput = AgentProposalInput | AgentEnvelopeInput;

function isEnvelope(input: AgentAdapterInput): input is AgentEnvelopeInput {
  return typeof (input as AgentEnvelopeInput).proposal === "object";
}

export function adaptAgentInputToDraft(input: AgentAdapterInput): PlanDraft {
  let envelope: AgentEnvelopeInput | undefined;
  let proposal: AgentProposalInput;
  if (isEnvelope(input)) {
    envelope = input;
    proposal = input.proposal;
  } else {
    proposal = input;
  }

  if (!proposal || typeof proposal.summary !== "string" || proposal.summary.trim().length === 0) {
    throw new Error("Adapter input must include a non-empty proposal summary");
  }

  const fileOperations: FileOperation[] = (proposal.fileChanges ?? []).map((change, idx) => {
    const base = {
      id: change.id ?? `op_file_${idx + 1}`,
      type: "file" as const,
      path: change.path
    };
    if (change.action === "create") {
      return { ...base, action: "create", after: change.after as string };
    }
    if (change.action === "update") {
      return {
        ...base,
        action: "update",
        before: change.before as string,
        after: change.after as string
      };
    }
    if (change.action === "delete") {
      return { ...base, action: "delete", before: change.before as string };
    }
    throw new Error(`Unsupported adapter file action: ${String(change.action)}`);
  });

  const commandOperations: CommandOperation[] = (proposal.commands ?? []).map((command, idx) => {
    const operation = {
      id: command.id ?? `op_command_${idx + 1}`,
      type: "command" as const,
      executable: command.executable,
      args: Array.isArray(command.args) ? [...command.args] : command.args,
      cwd: command.cwd,
      timeoutMs: command.timeoutMs,
      allowFailure: command.allowFailure
    };
    validateCommandOperationValue(operation, `commands[${idx}]`);
    return operation;
  });

  const operations = [...fileOperations, ...commandOperations];
  if (operations.length === 0) {
    throw new Error("Adapter input must include at least one file change or command");
  }

  const fallbackSource = envelope?.agent?.name ? `agent:${envelope.agent.name}` : "agent-adapter";

  return validatePlanDraft({
    version: PLAN_VERSION,
    source: proposal.source ?? fallbackSource,
    summary: proposal.summary,
    operations,
    preconditions: proposal.preconditions ?? [],
    execution: proposal.execution
  });
}
