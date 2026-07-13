import {
  ApplyReport,
  DryRunReport,
  GatefileConfig,
  PlanFile,
  RollbackReport,
  VerifyPlanReport
} from "./types";
import {
  ApprovePlanOptions,
  PlanDraft,
  approvePlan as approvePlanKernel,
  createPlanFromDraft
} from "./planner";
import {
  InspectReport,
  buildInspectReport,
  formatInspectSummary
} from "./inspect";
import { verifyPlan as verifyPlanKernel } from "./verify";
import {
  applyPlan as applyPlanKernel,
  previewPlan as previewPlanKernel,
  rollbackApply as rollbackApplyKernel
} from "./applier";
import { loadGatefileConfig, normalizeGatefileConfig } from "./config";
import { runPolicyHook } from "./hooks";
import { getRepoRoot, repositoryIdForRoot } from "./state";
import { resolveStateHome } from "./state-auth";
import { validatePlanFile } from "./validation";

export interface GatefileEngineOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
  config?: GatefileConfig;
}

export interface GatefileEngineContext {
  repoRoot: string;
  repositoryId: string;
  stateHome: string;
}

export interface EnginePlanOptions {
  planPath?: string;
}

export interface EngineApproveOptions extends ApprovePlanOptions {
  planPath?: string;
}

export class GatefileEngine {
  readonly context: GatefileEngineContext;
  readonly #explicitConfig?: GatefileConfig;

  constructor(options: GatefileEngineOptions = {}) {
    const repoRoot = getRepoRoot(options.repoRoot);
    this.context = Object.freeze({
      repoRoot,
      repositoryId: options.repositoryId ?? repositoryIdForRoot(repoRoot),
      stateHome: resolveStateHome(options.stateHome)
    });
    Object.defineProperty(this, "context", { writable: false, configurable: false });
    this.#explicitConfig = options.config === undefined
      ? undefined
      : normalizeGatefileConfig(options.config);
  }

  private policyConfig(): GatefileConfig {
    return this.#explicitConfig === undefined
      ? loadGatefileConfig(this.context.repoRoot)
      : normalizeGatefileConfig(this.#explicitConfig);
  }

  createPlan(draft: PlanDraft): PlanFile {
    this.policyConfig();
    return createPlanFromDraft(draft, {
      context: { repositoryId: this.context.repositoryId },
      repoRoot: this.context.repoRoot
    });
  }

  inspectPlan(plan: PlanFile): InspectReport {
    const config = this.policyConfig();
    return buildInspectReport(plan, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      config
    });
  }

  formatInspectPlan(plan: PlanFile, report: InspectReport): string {
    const config = this.policyConfig();
    return formatInspectSummary(plan, report, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      config
    });
  }

  approvePlan(
    plan: PlanFile,
    approvedBy: string,
    options: EngineApproveOptions = {}
  ): PlanFile {
    validatePlanFile(plan);
    if (plan.context?.repositoryId !== this.context.repositoryId) {
      throw new Error(
        `Plan repository context ${String(plan.context?.repositoryId)} does not match engine repository context ${this.context.repositoryId}`
      );
    }

    const config = this.policyConfig();
    runPolicyHook(config, "beforeApprove", plan, {
      repoRoot: this.context.repoRoot,
      planPath: options.planPath
    });
    const { planPath: _planPath, ...approveOptions } = options;
    return approvePlanKernel(plan, approvedBy, approveOptions);
  }

  verifyPlan(plan: PlanFile): VerifyPlanReport {
    const config = this.policyConfig();
    return verifyPlanKernel(plan, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      config
    });
  }

  previewPlan(plan: PlanFile, options: EnginePlanOptions = {}): DryRunReport {
    const config = this.policyConfig();
    return previewPlanKernel(plan, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      planPath: options.planPath,
      config
    });
  }

  applyPlan(plan: PlanFile, options: EnginePlanOptions = {}): ApplyReport {
    const config = this.policyConfig();
    return applyPlanKernel(plan, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      planPath: options.planPath,
      config
    });
  }

  rollbackApply(receiptId: string): RollbackReport {
    const config = this.policyConfig();
    return rollbackApplyKernel(receiptId, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      config
    });
  }
}
