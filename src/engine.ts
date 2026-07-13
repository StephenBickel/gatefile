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
import { validatePlanForApproval } from "./approval-validation";
import { pinRuntimeRepoRoot } from "./pinned-runtime";
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
import {
  loadGatefileConfigFromPinnedRoot,
  normalizeGatefileConfig
} from "./config";
import { runPolicyHook } from "./hooks";
import { getRepoRoot, repositoryIdForPinnedRoot } from "./state";
import { resolveStateHomeForContext } from "./state-auth";

export interface GatefileEngineOptions {
  repoRoot?: string;
  repositoryId?: string;
  stateHome?: string;
  config?: GatefileConfig;
}

export interface GatefileEngineContext {
  readonly repoRoot: string;
  readonly repositoryId: string;
  readonly stateHome: string;
}

export interface EnginePlanOptions {
  planPath?: string;
}

export interface EngineApproveOptions extends ApprovePlanOptions {
  planPath?: string;
}

interface GatefileEnginePrivateState {
  readonly explicitConfig: GatefileConfig | undefined;
}

const enginePrivateState = new WeakMap<object, GatefileEnginePrivateState>();

function privateStateFor(engine: GatefileEngine): GatefileEnginePrivateState {
  const state = enginePrivateState.get(engine);
  if (state === undefined) {
    throw new TypeError("GatefileEngine method called with an invalid receiver");
  }
  return state;
}

function policyConfigFor(engine: GatefileEngine): GatefileConfig {
  const state = privateStateFor(engine);
  return state.explicitConfig === undefined
    ? loadGatefileConfigFromPinnedRoot(engine.context.repoRoot)
    : normalizeGatefileConfig(state.explicitConfig);
}

export class GatefileEngine {
  readonly context: GatefileEngineContext;

  constructor(options: GatefileEngineOptions = {}) {
    const repoRoot = getRepoRoot(options.repoRoot);
    this.context = Object.freeze({
      repoRoot,
      repositoryId: options.repositoryId ?? repositoryIdForPinnedRoot(repoRoot),
      stateHome: resolveStateHomeForContext(options.stateHome)
    });
    Object.defineProperty(this, "context", { writable: false, configurable: false });
    enginePrivateState.set(this, Object.freeze({
      explicitConfig: options.config === undefined
        ? undefined
        : normalizeGatefileConfig(options.config)
    }));
  }

  createPlan(draft: PlanDraft): PlanFile {
    policyConfigFor(this);
    return createPlanFromDraft(draft, {
      context: { repositoryId: this.context.repositoryId },
      repoRoot: this.context.repoRoot
    });
  }

  inspectPlan(plan: PlanFile): InspectReport {
    const config = policyConfigFor(this);
    return buildInspectReport(plan, pinRuntimeRepoRoot({
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      config
    }));
  }

  formatInspectPlan(plan: PlanFile, report: InspectReport): string {
    const config = policyConfigFor(this);
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
    validatePlanForApproval(plan);
    if (plan.context?.repositoryId !== this.context.repositoryId) {
      throw new Error(
        `Plan repository context ${String(plan.context?.repositoryId)} does not match engine repository context ${this.context.repositoryId}`
      );
    }

    const config = policyConfigFor(this);
    runPolicyHook(config, "beforeApprove", plan, {
      repoRoot: this.context.repoRoot,
      planPath: options.planPath
    });
    const { planPath: _planPath, ...approveOptions } = options;
    return approvePlanKernel(plan, approvedBy, approveOptions);
  }

  verifyPlan(plan: PlanFile): VerifyPlanReport {
    const config = policyConfigFor(this);
    return verifyPlanKernel(plan, {
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      config
    });
  }

  previewPlan(plan: PlanFile, options: EnginePlanOptions = {}): DryRunReport {
    const config = policyConfigFor(this);
    return previewPlanKernel(plan, pinRuntimeRepoRoot({
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      planPath: options.planPath,
      config
    }));
  }

  applyPlan(plan: PlanFile, options: EnginePlanOptions = {}): ApplyReport {
    const config = policyConfigFor(this);
    return applyPlanKernel(plan, pinRuntimeRepoRoot({
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome,
      planPath: options.planPath,
      config
    }));
  }

  rollbackApply(receiptId: string): RollbackReport {
    privateStateFor(this);
    return rollbackApplyKernel(receiptId, pinRuntimeRepoRoot({
      repoRoot: this.context.repoRoot,
      repositoryId: this.context.repositoryId,
      stateHome: this.context.stateHome
    }));
  }
}
