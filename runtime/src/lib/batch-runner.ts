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

    // Bind for_each input → items. Sweep is a different code path.
    if (action.sweep) {
      throw new BatchStateError(
        `sweep batches are not yet implemented (shipping after PR4). ` +
          `Use for_each batches for now.`,
        "sweep_not_implemented"
      );
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

    // If all items are terminal, wrap up.
    const pending = this.firstPendingItem(ctx);
    if (pending === null) {
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
      aborted: ctx.aborted,
      abort_reason: ctx.abortReason,
      items,
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
}
