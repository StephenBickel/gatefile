import { CommandOperation, ExecutionConfig, FileAction, FileOperation, Precondition } from "./types";
import { PlanDraft } from "./planner";

export interface AdapterFileChange {
  id?: string;
  action: FileAction;
  path: string;
  before?: string;
  after?: string;
}

export interface AdapterCommand {
  id?: string;
  command: string;
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

  const fileOperations: FileOperation[] = (proposal.fileChanges ?? []).map((change, idx) => ({
    id: change.id ?? `op_file_${idx + 1}`,
    type: "file",
    action: change.action,
    path: change.path,
    before: change.before,
    after: change.after
  }));

  const commandOperations: CommandOperation[] = (proposal.commands ?? []).map((command, idx) => ({
    id: command.id ?? `op_command_${idx + 1}`,
    type: "command",
    command: command.command,
    cwd: command.cwd,
    timeoutMs: command.timeoutMs,
    allowFailure: command.allowFailure
  }));

  const operations = [...fileOperations, ...commandOperations];
  if (operations.length === 0) {
    throw new Error("Adapter input must include at least one file change or command");
  }

  const fallbackSource = envelope?.agent?.name ? `agent:${envelope.agent.name}` : "agent-adapter";

  return {
    version: "0.1",
    source: proposal.source ?? fallbackSource,
    summary: proposal.summary,
    operations,
    preconditions: proposal.preconditions ?? [],
    execution: proposal.execution
  };
}
