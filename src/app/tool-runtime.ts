import {
  planToolRuntimeRequest,
  type PlanToolRuntimeRequestOptions,
  type ToolRuntimePlan,
} from "../domain/brain/index.js";

export interface PlanToolRuntimeRequestsInput extends PlanToolRuntimeRequestOptions {
  requests: readonly unknown[];
}

export interface PlanToolRuntimeRequestsResult {
  plans: ToolRuntimePlan[];
  plannedCount: number;
  proposalRequiredCount: number;
  rejectedCount: number;
}

export function planToolRuntimeRequests(
  input: PlanToolRuntimeRequestsInput,
): PlanToolRuntimeRequestsResult {
  const plans = input.requests.map((request) =>
    planToolRuntimeRequest(request, {
      now: input.now,
      planIdPrefix: input.planIdPrefix,
      auditEventIdPrefix: input.auditEventIdPrefix,
      proposalIdPrefix: input.proposalIdPrefix,
    }),
  );

  return {
    plans,
    plannedCount: plans.filter((plan) => plan.status === "planned").length,
    proposalRequiredCount: plans.filter((plan) => plan.status === "proposal_required").length,
    rejectedCount: plans.filter((plan) => plan.status === "rejected").length,
  };
}
