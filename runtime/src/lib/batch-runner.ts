/**
 * PR4 — BatchRunner state machine.
 *
 * Authoritative execution engine for `kind: mutation` actions. The
 * runtime owns the cursor, item leases, idempotency skip decisions,
 * verify interleaving, and failure-mode policy; the agent just obeys
 * `next_step` / `complete_step`.
 *
 * Strictly in-memory. A crashed or abandoned batch is *not* resumable —
 * the agent must restart. TTL is enforced so stale batches don't leak.
 *
 * State machine (per item):
 *
 *     planned
 *       │
 *       ▼ next_step (lease mutate)
 *     mutate_leased
 *       │
 *       ▼ complete_step(status=ok)
 *     mutate_done ── (no verify steps) ──▶ done
 *       │
 *       ▼ next_step (lease verify)
 *     verify_leased
 *       │
 *       ▼ complete_step(status=ok) ──▶ done
 *       ▼ complete_step(status=failed) ──▶ verify_failed
 *
 *     (mutate_leased with failed) ──▶ failed
 *
 * Each lease issues a fresh `item_token`. `complete_step` with a stale
 * or mismatched token is a no-op (idempotent replay). Once the item is
 * in a terminal state, further leases for it error.
 */

import { randomUUID } from "node:crypto";
import type {
  Connector,
  MutationAction,
  ConnectorStep,
} from "./connector-schema.js";
import { renderDeep } from "./template.js";
import { computeExistingKeySet, computeKey } from "./idempotency.js";

// ─── Types ──────────────────────────────────────────────────────────────

export type Phase = "mutate" | "verify";

export type ItemState =
  | "planned"
  | "mutate_leased"
  | "mutate_done"
  | "verify_leased"
  | "done"
  | "failed"
  | "verify_failed"
  | "not_run"
  | "skipped_idempotent";

export interface BatchItemPublic {
  input_index: number;
  key: string | null;
  state: ItemState;
  error_code?: string;
  error_summary?: string;
  captured?: Record<string, unknown>;
}

export interface BatchSummary {
  batch_id: string;
  connector_id: string;
  action: string;
  total_planned: number;
  total_skipped_idempotent: number;
  concurrency_honored: 1;
  concurrency_requested: number;
  concurrency_downgraded: boolean;
  concurrency_downgrade_reason?: string;
  destructive: boolean;
  requires_confirmation: boolean;
  confirmation_accepted: boolean;
  warnings: string[];
  /** Sweep-only. The pass number this batch is currently on (1-based). */
  sweep_pass?: number;
  /** Sweep-only. Max passes the runtime will perform before giving up. */
  sweep_max_passes?: number;
}

/** Response from `next_step`. Mutually exclusive variants. */
export type NextStepResponse =
  | {
      kind: "step";
      item_token: string;
      input_index: number;
      phase: Phase;
      rendered_steps: ConnectorStep[];
      remaining: number;
    }
  | { kind: "refresh_required"; reason: string; pass: number }
  | { kind: "done"; report: BatchReport };

export interface CompleteStepParams {
  item_token: string;
  status: "ok" | "failed" | "verify_failed";
  error_code?: string;
  error_summary?: string;
  captured?: Record<string, unknown>;
}

export interface CompleteStepResponse {
  ack: true;
  /** Number of repeated calls we ignored for this item_token. Useful for
   *  agent-side sanity checks. */
  replayed: boolean;
  item_state: ItemState;
  aborted: boolean;
  abort_reason?: string;
}

export interface BatchReport {
  batch_id: string;
  connector_id: string;
  action: string;
  succeeded: number;
  failed: number;
  verify_failed: number;
  skipped_idempotent: number;
  not_run: number;
  aborted: boolean;
  abort_reason?: string;
  items: BatchItemPublic[];
  /** Sweep-only. Number of passes actually executed (>=1). */
  passes_completed?: number;
  /**
   * Sweep-only. Number of items the runtime saw in the final
   * `submit_read_snapshot` after sweep termination — non-zero values mean
   * the sweep stalled (max_passes hit, or the last pass made no progress).
   */
  final_pass_remaining?: number;
}

// ─── Internal ───────────────────────────────────────────────────────────

interface InternalItem {
  input_index: number;
  binding: Record<string, unknown>; // e.g. { task: <element> }
  key: string | null;
  state: ItemState;
  // A freshly-issued token is valid until complete_step resolves it
  // (or a new lease is issued). See `state` transitions above.
  active_token: string | null;
  last_token: string | null;
  error_code?: string;
  error_summary?: string;
  captured?: Record<string, unknown>;
  // Which phase the current lease is for, if any.
  leased_phase: Phase | null;
}

export interface BatchRunnerOptions {
  /** Maximum lifetime of an idle batch, in ms. Defaults to 1 hour. */
  ttlMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

export interface StartBatchParams {
  connector: Connector;
  action: MutationAction;
  input: Record<string, unknown>;
  /** Existing-state snapshot captured by the agent out-of-band, used for
   *  idempotency. Each element is treated as a `{ <action.as>: element }`
   *  binding for key computation. Required when action.idempotency is set. */
  prior_state?: ReadonlyArray<Record<string, unknown>>;
  /**
   * For sweep actions, the initial set of targets to delete (the snapshot
   * of `sweep.targets_from`). Required when action.sweep is set. Each
   * element becomes a `{ <sweep.as>: element, input }` binding.
   */
  sweep_targets?: ReadonlyArray<Record<string, unknown>>;
  /** Wall-clock the sweep_targets snapshot was collected at. Used to
   *  reject stale `advance_sweep_pass` calls. */
  sweep_targets_collected_at?: number;
  /** User confirmation token required for destructive +
   *  requires_confirmation actions. The runtime does not validate what
   *  the token is — only that it was passed. Confirmation is collected
   *  by the agent via the standard local 127.0.0.1 prompt. */
  confirmation_token?: string;
}

export class BatchStateError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "BatchStateError";
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────

export class BatchRunner {
  private readonly batches = new Map<string, BatchContext>();
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(opts: BatchRunnerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.clock = opts.now ?? Date.now;
  }

  start(params: StartBatchParams): { summary: BatchSummary } {
    const { connector, action, input } = params;

    if (action.kind !== "mutation") {
      throw new BatchStateError(
        `start_batch requires a mutation action; got '${action.kind}'`,
        "not_a_mutation"
      );
    }

    // Destructive + requires_confirmation requires explicit token.
    if (action.destructive && action.requires_confirmation && !params.confirmation_token) {
      throw new BatchStateError(
        `Action '${action.name}' is destructive and requires_confirmation; ` +
          `pass confirmation_token to proceed.`,
        "confirmation_required"
      );
    }

    // Sweep actions: initial item set comes from the supplied
    // sweep_targets snapshot. Successive passes are appended via
    // advanceSweepPass after the agent re-fetches.
    if (action.sweep) {
      if (!params.sweep_targets) {
        throw new BatchStateError(
          `Action '${action.name}' is a sweep action (targets_from='${action.sweep.targets_from}') ` +
            `but no sweep_targets snapshot was provided. ` +
            `Call submit_read_snapshot() for the targets_from action before start_batch().`,
          "missing_sweep_targets"
        );
      }
      return this.startSweep(params);
    }

    const itemsRaw = this.resolveForEach(action, input);
    const bindingName = action.as ?? "item";

    // Compute per-item keys if idempotency is declared.
    const warnings: string[] = [];
    let skippedIdempotent: InternalItem[] = [];
    let activeItems: InternalItem[] = [];

    if (action.idempotency) {
      if (!params.prior_state) {
        throw new BatchStateError(
          `Action '${action.name}' declares idempotency.read_via='${action.idempotency.read_via}' ` +
            `but no prior_state snapshot was provided. ` +
            `Call submit_read_snapshot() before start_batch().`,
          "missing_prior_state"
        );
      }
      const normalizers = connector.text_normalizers ?? [];
      const existingKeys = computeExistingKeySet(
        action.idempotency,
        params.prior_state,
        bindingName,
        normalizers
      );
      for (let i = 0; i < itemsRaw.length; i++) {
        const binding = { [bindingName]: itemsRaw[i], input };
        const { key, missing } = computeKey(action.idempotency, binding, normalizers);
        if (missing.length > 0) {
          // Can't compute key → can't dedupe → run the item; report warning.
          warnings.push(
            `Item ${i}: idempotency key paths missing: ${missing.join(", ")} — will not be deduped.`
          );
          activeItems.push(this.makeItem(i, binding, null));
          continue;
        }
        const item = this.makeItem(i, binding, key);
        if (existingKeys.has(key)) {
          item.state = "skipped_idempotent";
          skippedIdempotent.push(item);
        } else {
          activeItems.push(item);
        }
      }
    } else {
      for (let i = 0; i < itemsRaw.length; i++) {
        const binding = { [bindingName]: itemsRaw[i], input };
        activeItems.push(this.makeItem(i, binding, null));
      }
      if ((action.for_each || action.sweep) && action.destructive === false) {
        warnings.push(
          "Batch has no idempotency declared; a re-run will duplicate work."
        );
      }
    }

    // Concurrency: v1 can only honor 1 for UI-driven connectors. Loud
    // warn-and-downgrade so the agent surfaces it to the user.
    const requested = action.batch?.concurrency ?? 1;
    let downgraded = false;
    let downgradeReason: string | undefined;
    if (requested > 1) {
      downgraded = true;
      downgradeReason =
        "v1 batch-runner is UI-sequential; concurrency > 1 is reserved for future API-shortcut runners.";
      warnings.push(
        `batch.concurrency=${requested} requested but downgraded to 1. ${downgradeReason}`
      );
    }

    const batch_id = randomUUID();
    const ctx: BatchContext = {
      batch_id,
      connector,
      action,
      input,
      items: activeItems,
      skippedIdempotent,
      cursor: 0,
      createdAt: this.clock(),
      lastTouchedAt: this.clock(),
      aborted: false,
      abortReason: undefined,
      warnings,
    };
    this.batches.set(batch_id, ctx);

    const summary: BatchSummary = {
      batch_id,
      connector_id: connector.id,
      action: action.name,
      total_planned: activeItems.length,
      total_skipped_idempotent: skippedIdempotent.length,
      concurrency_honored: 1,
      concurrency_requested: requested,
      concurrency_downgraded: downgraded,
      concurrency_downgrade_reason: downgradeReason,
      destructive: action.destructive,
      requires_confirmation: action.requires_confirmation,
      confirmation_accepted: Boolean(params.confirmation_token),
      warnings,
    };
    return { summary };
  }

  /** Lease the next step for this batch. Returns `{kind: "done", report}`
   *  when exhausted. */
  nextStep(batch_id: string): NextStepResponse {
    const ctx = this.ctx(batch_id);

    // If all items are terminal, wrap up — but for sweep actions, see if
    // we should ask the agent to refresh the target snapshot for another
    // pass before declaring the batch done.
    const pending = this.firstPendingItem(ctx);
    if (pending === null) {
      if (ctx.action.sweep && !ctx.sweepComplete) {
        const sweep = this.handleSweepPassEnd(ctx);
        if (sweep) return sweep;
      }
      return { kind: "done", report: this.buildReport(ctx) };
    }

    const item = ctx.items[pending];
    const phase: Phase = (() => {
      if (item.state === "planned" || item.state === "mutate_leased") return "mutate";
      if (item.state === "mutate_done" || item.state === "verify_leased") return "verify";
      throw new BatchStateError(
        `internal: unexpected state '${item.state}' for pending item ${item.input_index}`,
        "internal_state"
      );
    })();

    // Single outstanding lease invariant: if there's already an active
    // token for this phase, replay the same lease (agent retry case).
    if (item.active_token && item.leased_phase === phase) {
      return {
        kind: "step",
        item_token: item.active_token,
        input_index: item.input_index,
        phase,
        rendered_steps: this.renderPhaseSteps(ctx, item, phase),
        remaining: this.remaining(ctx),
      };
    }

    const token = randomUUID();
    item.active_token = token;
    item.leased_phase = phase;
    item.state = phase === "mutate" ? "mutate_leased" : "verify_leased";
    ctx.lastTouchedAt = this.clock();

    return {
      kind: "step",
      item_token: token,
      input_index: item.input_index,
      phase,
      rendered_steps: this.renderPhaseSteps(ctx, item, phase),
      remaining: this.remaining(ctx),
    };
  }

  complete(batch_id: string, params: CompleteStepParams): CompleteStepResponse {
    const ctx = this.ctx(batch_id);
    const item = ctx.items.find((x) => x.last_token === params.item_token);
    if (item) {
      // Replay: the token's already been resolved. Idempotent no-op.
      return {
        ack: true,
        replayed: true,
        item_state: item.state,
        aborted: ctx.aborted,
        abort_reason: ctx.abortReason,
      };
    }
    const active = ctx.items.find((x) => x.active_token === params.item_token);
    if (!active) {
      throw new BatchStateError(
        `Unknown item_token or already resolved.`,
        "unknown_token"
      );
    }

    // Advance state based on phase + reported status.
    if (active.leased_phase === "mutate") {
      if (params.status === "ok") {
        active.captured = { ...(active.captured ?? {}), ...(params.captured ?? {}) };
        // Merge captured into the binding so verify steps can template it.
        if (params.captured) {
          active.binding = { ...active.binding, ...params.captured };
        }
        if (ctx.action.verify && ctx.action.verify.length > 0) {
          active.state = "mutate_done";
        } else {
          active.state = "done";
        }
      } else {
        active.state = "failed";
        active.error_code = this.sanitizeErrorCode(params.error_code);
        active.error_summary = this.capErrorSummary(params.error_summary);
        this.maybeAbort(ctx, active);
      }
    } else if (active.leased_phase === "verify") {
      if (params.status === "ok") {
        active.state = "done";
      } else {
        active.state = "verify_failed";
        active.error_code = this.sanitizeErrorCode(params.error_code);
        active.error_summary = this.capErrorSummary(params.error_summary);
        this.maybeAbort(ctx, active);
      }
    } else {
      throw new BatchStateError(
        `internal: complete called on item with no leased phase`,
        "internal_state"
      );
    }

    active.last_token = active.active_token;
    active.active_token = null;
    active.leased_phase = null;
    ctx.lastTouchedAt = this.clock();

    return {
      ack: true,
      replayed: false,
      item_state: active.state,
      aborted: ctx.aborted,
      abort_reason: ctx.abortReason,
    };
  }

  finish(batch_id: string): BatchReport {
    const ctx = this.ctx(batch_id);
    const report = this.buildReport(ctx);
    this.batches.delete(batch_id);
    return report;
  }

  /**
   * Begin a sweep batch. Initial pass items come from the supplied
   * `sweep_targets` snapshot; subsequent passes are added by
   * advanceSweepPass.
   */
  private startSweep(params: StartBatchParams): { summary: BatchSummary } {
    const { connector, action, input } = params;
    const sweep = action.sweep!;
    const targets = params.sweep_targets!;
    const collectedAt = params.sweep_targets_collected_at ?? this.clock();

    const warnings: string[] = [];
    const requested = action.batch?.concurrency ?? 1;
    let downgraded = false;
    let downgradeReason: string | undefined;
    if (requested > 1) {
      downgraded = true;
      downgradeReason =
        "v1 batch-runner is UI-sequential; concurrency > 1 is reserved for future API-shortcut runners.";
      warnings.push(
        `batch.concurrency=${requested} requested but downgraded to 1. ${downgradeReason}`
      );
    }

    const items: InternalItem[] = [];
    for (let i = 0; i < targets.length; i++) {
      const binding = { [sweep.as]: targets[i], input };
      items.push(this.makeItem(i, binding, null));
    }

    const batch_id = randomUUID();
    const ctx: BatchContext = {
      batch_id,
      connector,
      action,
      input,
      items,
      skippedIdempotent: [],
      cursor: 0,
      createdAt: this.clock(),
      lastTouchedAt: this.clock(),
      aborted: false,
      warnings,
      sweepPass: 1,
      sweepItemCursor: targets.length,
      sweepLastSnapshotAt: collectedAt,
      sweepAwaitingRefresh: false,
      sweepComplete: targets.length === 0 ? true : false,
      sweepLastPassSucceeded: undefined,
      sweepFinalRemaining: targets.length === 0 ? 0 : undefined,
    };
    this.batches.set(batch_id, ctx);

    const summary: BatchSummary = {
      batch_id,
      connector_id: connector.id,
      action: action.name,
      total_planned: items.length,
      total_skipped_idempotent: 0,
      concurrency_honored: 1,
      concurrency_requested: requested,
      concurrency_downgraded: downgraded,
      concurrency_downgrade_reason: downgradeReason,
      destructive: action.destructive,
      requires_confirmation: action.requires_confirmation,
      confirmation_accepted: Boolean(params.confirmation_token),
      warnings,
      sweep_pass: 1,
      sweep_max_passes: sweep.max_passes,
    };
    return { summary };
  }

  /**
   * Append the next pass of a sweep. Called by the MCP server after the
   * agent has re-run the targets fetch and re-submitted the snapshot.
   *
   * Returns:
   *   - { advanced: true, planned: N } — pass N+1 has been queued, agent
   *     may resume `next_step`.
   *   - { advanced: false, reason: 'snapshot_not_fresh' } — the supplied
   *     snapshot is older than the one already consumed; agent must re-fetch.
   *   - { advanced: true, planned: 0, complete: true } — sweep terminated
   *     (empty refresh, max_passes hit, or no progress); next call to
   *     `next_step` will return `{kind: "done", report}`.
   */
  advanceSweepPass(
    batch_id: string,
    targets: ReadonlyArray<Record<string, unknown>>,
    collectedAt: number
  ): {
    advanced: boolean;
    pass: number;
    planned: number;
    complete?: boolean;
    reason?: string;
  } {
    const ctx = this.ctx(batch_id);
    if (!ctx.action.sweep) {
      throw new BatchStateError(
        "advance_sweep_pass called on a non-sweep batch.",
        "not_a_sweep"
      );
    }
    if (!ctx.sweepAwaitingRefresh) {
      throw new BatchStateError(
        "Batch is not awaiting a sweep refresh; finish the current pass first.",
        "not_awaiting_refresh"
      );
    }
    if (collectedAt <= (ctx.sweepLastSnapshotAt ?? 0)) {
      return {
        advanced: false,
        pass: ctx.sweepPass ?? 1,
        planned: 0,
        reason: "snapshot_not_fresh",
      };
    }

    const sweep = ctx.action.sweep;
    const succeededLastPass = ctx.sweepLastPassSucceeded ?? 0;

    // Termination: empty refresh.
    if (targets.length === 0) {
      ctx.sweepComplete = true;
      ctx.sweepAwaitingRefresh = false;
      ctx.sweepLastSnapshotAt = collectedAt;
      ctx.sweepFinalRemaining = 0;
      ctx.sweepPass = (ctx.sweepPass ?? 1); // last completed pass
      return { advanced: true, pass: ctx.sweepPass, planned: 0, complete: true };
    }

    // Termination: max_passes reached. We've completed sweepPass passes;
    // the next pass would be sweepPass+1 which would exceed the bound.
    if ((ctx.sweepPass ?? 1) >= sweep.max_passes) {
      ctx.sweepComplete = true;
      ctx.sweepAwaitingRefresh = false;
      ctx.sweepLastSnapshotAt = collectedAt;
      ctx.sweepFinalRemaining = targets.length;
      ctx.sweepHaltReason = `max_passes_reached (${sweep.max_passes})`;
      ctx.warnings.push(
        `Sweep halted at max_passes=${sweep.max_passes} with ${targets.length} target(s) still present.`
      );
      return { advanced: true, pass: ctx.sweepPass ?? 1, planned: 0, complete: true };
    }

    // Termination: previous pass made zero progress AND the target set is
    // still non-empty — the sweep is stalled.
    if (succeededLastPass === 0) {
      ctx.sweepComplete = true;
      ctx.sweepAwaitingRefresh = false;
      ctx.sweepLastSnapshotAt = collectedAt;
      ctx.sweepFinalRemaining = targets.length;
      ctx.sweepHaltReason = "no_progress";
      ctx.warnings.push(
        `Sweep halted: pass ${ctx.sweepPass ?? 1} succeeded on 0 items but ${targets.length} target(s) remain.`
      );
      return { advanced: true, pass: ctx.sweepPass ?? 1, planned: 0, complete: true };
    }

    // Queue the next pass.
    const nextPass = (ctx.sweepPass ?? 1) + 1;
    const cursorBase = ctx.sweepItemCursor ?? ctx.items.length;
    for (let i = 0; i < targets.length; i++) {
      const binding = { [sweep.as]: targets[i], input: ctx.input };
      ctx.items.push(this.makeItem(cursorBase + i, binding, null));
    }
    ctx.sweepItemCursor = cursorBase + targets.length;
    ctx.sweepPass = nextPass;
    ctx.sweepLastSnapshotAt = collectedAt;
    ctx.sweepAwaitingRefresh = false;
    ctx.sweepLastPassSucceeded = undefined;
    ctx.lastTouchedAt = this.clock();
    return { advanced: true, pass: nextPass, planned: targets.length };
  }

  /**
   * End-of-pass handler invoked by nextStep when no items remain pending.
   * Either signals refresh_required or marks the sweep complete.
   *
   * Returns `null` when the sweep is finished (so nextStep falls through
   * to building the BatchReport).
   */
  private handleSweepPassEnd(ctx: BatchContext): NextStepResponse | null {
    const sweep = ctx.action.sweep!;
    // Tally this pass's successes and stash for the next-pass progress check.
    const succeededThisPass = this.countPassSucceeded(ctx);
    ctx.sweepLastPassSucceeded = succeededThisPass;

    // until_empty:false → one pass and out, regardless of remaining state.
    if (!sweep.until_empty) {
      ctx.sweepComplete = true;
      ctx.sweepFinalRemaining = undefined;
      return null;
    }

    // Already at max_passes — don't request a refresh we can't act on.
    if ((ctx.sweepPass ?? 1) >= sweep.max_passes) {
      ctx.sweepComplete = true;
      ctx.sweepHaltReason = `max_passes_reached (${sweep.max_passes})`;
      ctx.warnings.push(
        `Sweep halted at max_passes=${sweep.max_passes}; agent did not get a chance to verify drainage.`
      );
      return null;
    }

    // If refresh_between_passes is false, behave like for_each over the
    // initial snapshot — no further passes.
    if (!sweep.refresh_between_passes) {
      ctx.sweepComplete = true;
      return null;
    }

    ctx.sweepAwaitingRefresh = true;
    ctx.lastTouchedAt = this.clock();
    return {
      kind: "refresh_required",
      reason: "sweep_pass_complete",
      pass: ctx.sweepPass ?? 1,
    };
  }

  /** Count items that landed in `done` state during the most recent pass. */
  private countPassSucceeded(ctx: BatchContext): number {
    // The current pass occupies the tail end of ctx.items. We tracked the
    // pre-pass cursor in sweepItemCursor (set to the post-append length at
    // the END of advanceSweepPass), so the current pass items are the slice
    // [sweepItemCursor - lastPassSize, sweepItemCursor). However sweep pass
    // 1 has no prior cursor — items are simply [0, initial_count).
    // Simpler: count `done` items added since the last
    // sweepLastPassSucceeded reset by tracking the last-counted index.
    // Pragmatic v1: count `done` items minus the running tally so far.
    let done = 0;
    for (const item of ctx.items) {
      if (item.state === "done") done++;
    }
    const prior = (ctx as { _sweepDoneSoFar?: number })._sweepDoneSoFar ?? 0;
    (ctx as { _sweepDoneSoFar?: number })._sweepDoneSoFar = done;
    return done - prior;
  }

  /** Best-effort GC of batches past their TTL. Call periodically. */
  reapExpired(): string[] {
    const now = this.clock();
    const removed: string[] = [];
    for (const [id, ctx] of this.batches) {
      if (now - ctx.lastTouchedAt > this.ttlMs) {
        removed.push(id);
        this.batches.delete(id);
      }
    }
    return removed;
  }

  /** Test-only accessor. */
  peek(batch_id: string): BatchContext | undefined {
    return this.batches.get(batch_id);
  }

  // ─── private helpers ──────────────────────────────────────────────────

  private ctx(batch_id: string): BatchContext {
    const c = this.batches.get(batch_id);
    if (!c) {
      throw new BatchStateError(
        `batch_id '${batch_id}' not found (expired, finished, or never started).`,
        "batch_not_found"
      );
    }
    if (this.clock() - c.lastTouchedAt > this.ttlMs) {
      this.batches.delete(batch_id);
      throw new BatchStateError(
        `batch_id '${batch_id}' expired (TTL ${this.ttlMs} ms). Restart required.`,
        "batch_expired"
      );
    }
    return c;
  }

  private makeItem(
    input_index: number,
    binding: Record<string, unknown>,
    key: string | null
  ): InternalItem {
    return {
      input_index,
      binding,
      key,
      state: "planned",
      active_token: null,
      last_token: null,
      leased_phase: null,
    };
  }

  private resolveForEach(
    action: MutationAction,
    input: Record<string, unknown>
  ): unknown[] {
    if (!action.for_each) return [undefined]; // single-shot mutation
    const m = /^\s*\{\{\s*input\.([a-zA-Z0-9_.]+)\s*\}\}\s*$/.exec(action.for_each);
    if (!m) {
      throw new BatchStateError(
        `for_each expression '${action.for_each}' must be of the form '{{input.path}}'`,
        "for_each_malformed"
      );
    }
    let cur: unknown = input;
    for (const p of m[1].split(".")) {
      if (cur == null || typeof cur !== "object") {
        throw new BatchStateError(
          `for_each path '${m[1]}' resolved to undefined on input`,
          "for_each_unresolved"
        );
      }
      cur = (cur as Record<string, unknown>)[p];
    }
    if (!Array.isArray(cur)) {
      throw new BatchStateError(
        `for_each path '${m[1]}' did not resolve to an array (got ${typeof cur}).`,
        "for_each_not_array"
      );
    }
    return cur;
  }

  private firstPendingItem(ctx: BatchContext): number | null {
    if (ctx.aborted) return null;
    for (let i = 0; i < ctx.items.length; i++) {
      const s = ctx.items[i].state;
      if (
        s === "planned" ||
        s === "mutate_leased" ||
        s === "mutate_done" ||
        s === "verify_leased"
      )
        return i;
    }
    return null;
  }

  private remaining(ctx: BatchContext): number {
    let n = 0;
    for (const item of ctx.items) {
      if (
        item.state === "planned" ||
        item.state === "mutate_leased" ||
        item.state === "mutate_done" ||
        item.state === "verify_leased"
      )
        n++;
    }
    return n;
  }

  private renderPhaseSteps(
    ctx: BatchContext,
    item: InternalItem,
    phase: Phase
  ): ConnectorStep[] {
    const source = phase === "mutate" ? ctx.action.steps : ctx.action.verify ?? [];
    const filtered = source.filter((s) => {
      if (!s.phase) return true;
      if (phase === "mutate") return s.phase !== "verify";
      return s.phase === "verify";
    });
    const { rendered } = renderDeep(filtered, item.binding);
    return rendered;
  }

  private maybeAbort(ctx: BatchContext, item: InternalItem): void {
    const mode = ctx.action.failure_mode ?? "fail_fast";
    if (mode === "fail_fast") {
      ctx.aborted = true;
      ctx.abortReason = `fail_fast: item ${item.input_index} ${item.state}` +
        (item.error_code ? ` (${item.error_code})` : "");
      // Any untouched items become `not_run`.
      for (const other of ctx.items) {
        if (
          other !== item &&
          (other.state === "planned" || other.state === "mutate_leased" ||
           other.state === "mutate_done" || other.state === "verify_leased")
        ) {
          other.state = "not_run";
          other.active_token = null;
          other.leased_phase = null;
        }
      }
    }
  }

  private buildReport(ctx: BatchContext): BatchReport {
    let succeeded = 0,
      failed = 0,
      verify_failed = 0,
      not_run = 0;
    for (const item of ctx.items) {
      if (item.state === "done") succeeded++;
      else if (item.state === "failed") failed++;
      else if (item.state === "verify_failed") verify_failed++;
      else if (item.state === "not_run") not_run++;
    }
    const items: BatchItemPublic[] = [
      ...ctx.skippedIdempotent.map((i) => ({
        input_index: i.input_index,
        key: i.key,
        state: i.state,
      })),
      ...ctx.items.map((i) => ({
        input_index: i.input_index,
        key: i.key,
        state: i.state,
        error_code: i.error_code,
        error_summary: i.error_summary,
        captured: i.captured,
      })),
    ].sort((a, b) => a.input_index - b.input_index);

    return {
      batch_id: ctx.batch_id,
      connector_id: ctx.connector.id,
      action: ctx.action.name,
      succeeded,
      failed,
      verify_failed,
      skipped_idempotent: ctx.skippedIdempotent.length,
      not_run,
      aborted: ctx.aborted || Boolean(ctx.sweepHaltReason),
      abort_reason: ctx.abortReason ?? ctx.sweepHaltReason,
      items,
      passes_completed: ctx.action.sweep ? ctx.sweepPass ?? 1 : undefined,
      final_pass_remaining: ctx.action.sweep ? ctx.sweepFinalRemaining : undefined,
    };
  }

  private sanitizeErrorCode(code: string | undefined): string | undefined {
    if (!code) return undefined;
    // keep only ascii-safe tokens; cap at 64 chars
    return code.replace(/[^a-zA-Z0-9_.\-]/g, "_").slice(0, 64);
  }

  private capErrorSummary(summary: string | undefined): string | undefined {
    if (!summary) return undefined;
    const trimmed = summary.replace(/\s+/g, " ").trim();
    return trimmed.length > 240 ? trimmed.slice(0, 237) + "..." : trimmed;
  }
}

interface BatchContext {
  batch_id: string;
  connector: Connector;
  action: MutationAction;
  input: Record<string, unknown>;
  items: InternalItem[];
  skippedIdempotent: InternalItem[];
  cursor: number;
  createdAt: number;
  lastTouchedAt: number;
  aborted: boolean;
  abortReason?: string;
  warnings: string[];
  // ─── sweep state (only set when action.sweep is present) ───────────
  /** 1-based pass counter; first pass is 1. */
  sweepPass?: number;
  /** Monotonic counter so successive passes get unique input_index values. */
  sweepItemCursor?: number;
  /** Wall-clock timestamp of the snapshot consumed for the current pass.
   *  advance_sweep_pass refuses snapshots whose collected_at <= this. */
  sweepLastSnapshotAt?: number;
  /** True between "all current items terminal" and the agent's next
   *  advance_sweep_pass call. While true, nextStep returns refresh_required
   *  instead of leasing more steps. */
  sweepAwaitingRefresh?: boolean;
  /** True once the runtime decides the sweep is finished (empty refresh,
   *  max passes, or no-progress halt). */
  sweepComplete?: boolean;
  /** Set when the runtime halts a sweep early. Reported in BatchReport. */
  sweepHaltReason?: string;
  /** How many items succeeded in the immediately-prior pass — 0 means the
   *  sweep is stalled and the next refresh that comes back non-empty will
   *  trigger a no_progress halt. */
  sweepLastPassSucceeded?: number;
  /** Snapshot remaining after the final advance_sweep_pass that produced
   *  no new work; surfaced in BatchReport.final_pass_remaining. */
  sweepFinalRemaining?: number;
}
