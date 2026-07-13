import { Operation, RiskLevel, RiskProfile } from "./types";
import { formatCommandInvocation, isPotentiallyDestructiveCommand } from "./command";

function levelFromScore(score: number): RiskLevel {
  if (score >= 8) return "high";
  if (score >= 4) return "medium";
  return "low";
}

export function scoreRisk(operations: Operation[]): RiskProfile {
  let score = 0;
  const reasons: string[] = [];

  for (const op of operations) {
    if (op.type === "file") {
      if (op.action === "delete") {
        score += 3;
        reasons.push(`File delete: ${op.path}`);
      } else if (op.action === "update") {
        score += 1;
      }

      if (op.path.startsWith(".github/") || op.path.includes("/infra/")) {
        score += 2;
        reasons.push(`Sensitive path touched: ${op.path}`);
      }
      continue;
    }

    if (op.type === "command") {
      const invocation = formatCommandInvocation(op);
      score += 2;
      reasons.push(`Command execution: ${invocation}`);

      if (isPotentiallyDestructiveCommand(op)) {
        score += 4;
        reasons.push(`Potentially destructive command: ${invocation}`);
      }
      continue;
    }

    const unsupported = op as unknown as { type?: unknown };
    throw new Error(`Unsupported operation type in risk scoring: ${String(unsupported.type)}`);
  }

  return {
    score,
    level: levelFromScore(score),
    reasons
  };
}
