import type {
  Workflow,
  WorkflowStep,
  WorkflowRunState,
  WorkflowStepState,
  Logger,
} from "../core/types.js";
import { ClaudeclawEventBus } from "../core/events.js";
import { v4 as uuid } from "uuid";

export type StepExecutor = (
  step: WorkflowStep,
  inputs: Map<string, string>
) => Promise<string>;

/**
 * DAG Workflow Engine
 * Executes workflow steps respecting dependencies, parallelism, retry, and fallback
 */
export class WorkflowEngine {
  private workflows = new Map<string, Workflow>();
  private eventBus: ClaudeclawEventBus;
  private logger: Logger;

  constructor(eventBus: ClaudeclawEventBus, logger: Logger) {
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Register a workflow definition
   */
  register(workflow: Workflow): void {
    this.validateDAG(workflow);
    this.workflows.set(workflow.id, workflow);
    this.logger.info(`Workflow registered: ${workflow.id} (${workflow.name})`);
  }

  /**
   * Execute a workflow
   */
  async execute(
    workflowId: string,
    executor: StepExecutor
  ): Promise<WorkflowRunState> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

    const state: WorkflowRunState = {
      workflowId,
      stepStates: new Map(),
      startedAt: new Date(),
      status: "running",
    };

    // Initialize step states
    for (const step of workflow.steps) {
      state.stepStates.set(step.id, {
        stepId: step.id,
        status: "pending",
        attempts: 0,
      });
    }

    this.eventBus.emit("workflow:started", {
      type: "workflow:started",
      workflowId,
    });
    this.logger.info(`Workflow started: ${workflowId}`);

    try {
      await this.executeDAG(workflow, state, executor);
      state.status = "completed";
    } catch (err) {
      state.status = "failed";
      this.logger.error(`Workflow failed: ${workflowId}`, {
        error: String(err),
      });
    }

    state.completedAt = new Date();
    this.eventBus.emit("workflow:completed", {
      type: "workflow:completed",
      workflowId,
      status: state.status,
    });

    return state;
  }

  /**
   * Create a workflow using builder pattern
   */
  static builder(id: string, name: string): WorkflowBuilder {
    return new WorkflowBuilder(id, name);
  }

  // --- DAG Execution ---

  private async executeDAG(
    workflow: Workflow,
    state: WorkflowRunState,
    executor: StepExecutor
  ): Promise<void> {
    const completed = new Set<string>();
    const failed = new Set<string>();

    while (completed.size + failed.size < workflow.steps.length) {
      // Find ready steps: all dependencies completed
      const readySteps = workflow.steps.filter((step) => {
        const stepState = state.stepStates.get(step.id)!;
        if (stepState.status !== "pending") return false;

        const deps = step.dependsOn ?? [];
        return deps.every((dep) => completed.has(dep) || failed.has(dep));
      });

      if (readySteps.length === 0) {
        // Check if we're stuck (circular dep or all remaining have failed deps)
        const remaining = workflow.steps.filter(
          (s) => !completed.has(s.id) && !failed.has(s.id)
        );
        if (remaining.length > 0) {
          // Check if remaining steps have failed dependencies with no fallback
          const stuck = remaining.every((step) => {
            const deps = step.dependsOn ?? [];
            return deps.some((d) => failed.has(d));
          });
          if (stuck) {
            // Skip steps with failed deps
            for (const step of remaining) {
              const stepState = state.stepStates.get(step.id)!;
              stepState.status = "skipped";
              failed.add(step.id);
            }
            break;
          }
        }
        break;
      }

      // Execute ready steps (parallel if allowed)
      const parallelSteps = readySteps.filter((s) => s.parallel !== false);
      const sequentialSteps = readySteps.filter(
        (s) => s.parallel === false
      );

      // Run parallel steps concurrently
      if (parallelSteps.length > 0) {
        const results = await Promise.allSettled(
          parallelSteps.map((step) =>
            this.executeStep(step, state, executor, completed)
          )
        );

        for (let i = 0; i < results.length; i++) {
          const step = parallelSteps[i];
          if (results[i].status === "fulfilled") {
            completed.add(step.id);
          } else {
            failed.add(step.id);
          }
        }
      }

      // Run sequential steps one at a time
      for (const step of sequentialSteps) {
        try {
          await this.executeStep(step, state, executor, completed);
          completed.add(step.id);
        } catch {
          failed.add(step.id);
        }
      }
    }

    // If any non-skipped step failed, throw
    const failedSteps = Array.from(failed).filter((id) => {
      const s = state.stepStates.get(id);
      return s && s.status === "failed";
    });
    if (failedSteps.length > 0) {
      throw new Error(`Steps failed: ${failedSteps.join(", ")}`);
    }
  }

  private async executeStep(
    step: WorkflowStep,
    state: WorkflowRunState,
    executor: StepExecutor,
    completed: Set<string>
  ): Promise<void> {
    const stepState = state.stepStates.get(step.id)!;
    stepState.status = "running";
    stepState.startedAt = new Date();

    // Collect inputs from completed dependencies
    const inputs = new Map<string, string>();
    for (const dep of step.dependsOn ?? []) {
      const depState = state.stepStates.get(dep);
      if (depState?.result) {
        inputs.set(dep, depState.result);
      }
    }

    const maxRetries = step.retry?.maxRetries ?? 0;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      stepState.attempts = attempt + 1;

      try {
        this.logger.info(
          `Step ${step.id}: attempt ${attempt + 1}/${maxRetries + 1}`
        );

        // Apply timeout if specified
        let result: string;
        if (step.timeout) {
          result = await withTimeout(
            executor(step, inputs),
            step.timeout,
            `Step ${step.id} timed out`
          );
        } else {
          result = await executor(step, inputs);
        }

        stepState.status = "completed";
        stepState.result = result;
        stepState.completedAt = new Date();
        this.logger.info(`Step ${step.id}: completed`);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          `Step ${step.id}: attempt ${attempt + 1} failed: ${lastError.message}`
        );

        // Apply backoff before retry
        if (attempt < maxRetries) {
          const backoff =
            (step.retry?.backoffMs ?? 1000) *
            Math.pow(step.retry?.backoffFactor ?? 2, attempt);
          await sleep(backoff);
        }
      }
    }

    // All attempts failed
    stepState.status = "failed";
    stepState.error = lastError?.message;
    stepState.completedAt = new Date();

    // Handle fallback
    if (step.fallback === "skip") {
      this.logger.info(`Step ${step.id}: skipped (fallback)`);
      stepState.status = "skipped";
      return;
    }

    throw lastError;
  }

  // --- Validation ---

  private validateDAG(workflow: Workflow): void {
    const stepIds = new Set(workflow.steps.map((s) => s.id));

    // Check for missing dependencies
    for (const step of workflow.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepIds.has(dep)) {
          throw new Error(
            `Step ${step.id} depends on unknown step: ${dep}`
          );
        }
      }
    }

    // Check for circular dependencies
    if (this.hasCycle(workflow)) {
      throw new Error(`Workflow ${workflow.id} has circular dependencies`);
    }
  }

  private hasCycle(workflow: Workflow): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (stepId: string): boolean => {
      if (stack.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visited.add(stepId);
      stack.add(stepId);

      const step = workflow.steps.find((s) => s.id === stepId);
      if (step) {
        for (const dep of step.dependsOn ?? []) {
          if (dfs(dep)) return true;
        }
      }

      stack.delete(stepId);
      return false;
    };

    return workflow.steps.some((s) => dfs(s.id));
  }
}

/**
 * Builder pattern for creating workflows
 */
export class WorkflowBuilder {
  private steps: WorkflowStep[] = [];

  constructor(
    private id: string,
    private name: string
  ) {}

  addStep(
    id: string,
    options: Omit<WorkflowStep, "id">
  ): WorkflowBuilder {
    this.steps.push({ id, ...options });
    return this;
  }

  onFailure(
    stepId: string,
    config: { retry?: number; fallback?: "skip" | "abort" }
  ): WorkflowBuilder {
    const step = this.steps.find((s) => s.id === stepId);
    if (step) {
      if (config.retry) {
        step.retry = { maxRetries: config.retry };
      }
      if (config.fallback) {
        step.fallback = config.fallback;
      }
    }
    return this;
  }

  build(): Workflow {
    return {
      id: this.id,
      name: this.name,
      steps: [...this.steps],
    };
  }
}

// --- Utilities ---

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
