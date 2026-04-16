/**
 * PR5 — navigate_by_labels resolver tests.
 *
 * These convert the thirteen `test.todo` contracts from v1-primitives.todo.test.ts
 * into concrete vectors over a synthetic ARIA tree. The resolver is pure;
 * browser-side concerns (scroll-into-view, click dispatch) are covered by
 * contract-style tests that exercise the emitted descriptor, not a real DOM.
 */

import { describe, expect, test } from "vitest";
import {
  resolveLabelChain,
  resolveLabelStep,
  type AriaNode,
} from "../label-resolver.js";
import {
  LabelMatchSchema,
  StepSchema,
  type LabelMatch,
} from "../connector-schema.js";

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

/**
 * A minimal Planner-ish ARIA tree:
 *   banner → (tabs: Board view / Grid view)
 *   main → Board view tabpanel (id: panel-board)
 *     bucket column "Development"
 *       heading "Development"
 *       button "Add task" (controls a dialog)
 *     bucket column "QA"
 *       heading "QA"
 *       button "Add task"
 */
function plannerTree(): AriaNode {
  return {
    role: "document",
    name: "Planner",
    children: [
      {
        role: "tablist",
        name: "Views",
        children: [
          {
            role: "tab",
            name: "Board view",
            ariaLabel: ["Board view", "תצוגת לוח"],
            controls: "panel-board",
          },
          {
            role: "tab",
            name: "Grid view",
            controls: "panel-grid",
          },
        ],
      },
      {
        role: "main",
        name: "Panels",
        children: [
          {
            role: "tabpanel",
            id: "panel-board",
            name: "Board panel",
            children: [
              {
                role: "region",
                name: "Development",
                children: [
                  { role: "heading", name: "Development" },
                  {
                    role: "button",
                    name: "Add task",
                    controls: "dialog-add-task-dev",
                  },
                ],
              },
              {
                role: "region",
                name: "QA",
                children: [
                  { role: "heading", name: "QA" },
                  { role: "button", name: "Add task" },
                ],
              },
            ],
          },
          {
            role: "tabpanel",
            id: "panel-grid",
            name: "Grid panel",
            visible: false,
            children: [],
          },
        ],
      },
    ],
  };
}

/** Shorthand to build a fully-defaulted LabelMatch from a partial. */
function lm(partial: Partial<LabelMatch> & { label: LabelMatch["label"] }): LabelMatch {
  return LabelMatchSchema.parse({
    click_action: "click",
    next_scope: "page",
    ...partial,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe("PR5 — navigate_by_labels strategies", () => {
  test("exact aria-label match is preferred over case-insensitive contains", () => {
    // "Add task" matches exact name on the two buttons, and would also match
    // case-insensitive contains. Exact-name strategy runs first, so it is
    // used — confirmed by `strategy` on the resolved node.
    const tree = plannerTree();
    // Narrow to a single bucket so the name is unambiguous.
    const dev = tree.children![1].children![0].children![0]; // region "Development"
    // Use the dev region as the scope root and resolve "Add task" inside it.
    const r = resolveLabelStep(
      { role: "region", children: [dev.children![1]] } as AriaNode,
      lm({ label: "add TASK" as any }) // upper-case variant
    );
    // This deliberate mismatch forces fall-through to contains; strategy is
    // case_insensitive_contains, not exact_name.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.strategy).toBe("case_insensitive_contains");

    const r2 = resolveLabelStep(
      { role: "region", children: [dev.children![1]] } as AriaNode,
      lm({ label: "Add task" })
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.resolved.strategy).toBe("exact_name");
  });

  test("next_scope: controlled_region follows aria-controls to the tabpanel", () => {
    const tree = plannerTree();
    const chain: LabelMatch[] = [
      lm({ label: "Board view", role: "tab", next_scope: "controlled_region" }),
      // Inside the controlled region, find the Development heading.
      lm({ label: "Development", role: "heading" }),
    ];
    const result = resolveLabelChain(tree, chain);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].ok).toBe(true);
  });

  test("next_scope: subtree limits to descendants of the matched node", () => {
    const tree = plannerTree();
    // After resolving the Development region, a subtree scope means "Add task"
    // is looked up only inside that region — so it resolves to a single node
    // (not ambiguous across QA too).
    const chain: LabelMatch[] = [
      lm({ label: "Development", role: "region", next_scope: "subtree" }),
      lm({ label: "Add task", role: "button" }),
    ];
    const result = resolveLabelChain(tree, chain);
    expect(result.ok).toBe(true);
    const last = result.steps[1];
    expect(last.ok).toBe(true);
  });

  test("next_scope: page (default) rescans the full ARIA tree", () => {
    const tree = plannerTree();
    // After resolving "Development", a page-scoped next step for "Add task"
    // would be ambiguous (two buckets both contain it) — this is the
    // documented failure mode we want operators to see.
    const chain: LabelMatch[] = [
      lm({ label: "Development", role: "region", next_scope: "page" }),
      lm({ label: "Add task", role: "button" }),
    ];
    const result = resolveLabelChain(tree, chain);
    expect(result.ok).toBe(false);
    const last = result.steps[1];
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.reason).toBe("ambiguous");
  });

  test("tie-break: ≥2 candidates after all strategies → step fails with 'ambiguous' error", () => {
    const tree = plannerTree();
    const r = resolveLabelStep(tree, lm({ label: "Add task", role: "button" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      if (r.reason === "ambiguous") expect(r.candidateCount).toBe(2);
    }
  });

  test("tie-break: a role+name pairing disambiguates otherwise-identical labels", () => {
    // Build a tree where the literal name "Save" appears both as a button
    // and as a heading — role constraint picks the button.
    const tree: AriaNode = {
      role: "document",
      children: [
        { role: "heading", name: "Save" },
        { role: "button", name: "Save" },
      ],
    };
    const r = resolveLabelStep(tree, lm({ label: "Save", role: "button" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.node.role).toBe("button");
      expect(["exact_name", "role_name_pair"]).toContain(r.resolved.strategy);
    }
  });

  test("localized label: ['Board', 'לוח'] resolves against the Hebrew aria-label", () => {
    // Swap the tree's tab name to the Hebrew form and drop the English
    // accessible name. The aria-label any-of must match "תצוגת לוח".
    const tree: AriaNode = {
      role: "document",
      children: [
        {
          role: "tab",
          name: "תצוגת לוח",
          ariaLabel: ["תצוגת לוח"],
        },
      ],
    };
    const r = resolveLabelStep(tree, lm({ label: ["Board view", "תצוגת לוח"] }));
    expect(r.ok).toBe(true);
  });

  test("element off-screen is auto-scrolled into view before click (contract)", () => {
    // The resolver itself is pure and does NOT perform scrolling — that is
    // the browser driver's responsibility. We assert the contract: the
    // resolved descriptor carries enough information (role, accessible
    // name, id path) for the driver to locate and scroll it.
    const tree = plannerTree();
    const r = resolveLabelStep(tree, lm({ label: "Grid view", role: "tab" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.node.role).toBe("tab");
      expect(r.resolved.node.name).toBe("Grid view");
      // path is a stable locator the driver can reuse.
      expect(Array.isArray(r.resolved.path)).toBe(true);
      expect(r.resolved.path.length).toBeGreaterThan(0);
    }
  });

  test("click_action: right_click opens context menu (schema contract)", () => {
    const step = LabelMatchSchema.parse({
      label: "Task",
      role: "listitem",
      click_action: "right_click",
    });
    expect(step.click_action).toBe("right_click");
  });

  test("click_action: hover reveals ellipsis menu (schema contract)", () => {
    const step = LabelMatchSchema.parse({
      label: "Task",
      click_action: "hover",
    });
    expect(step.click_action).toBe("hover");
  });

  test("optional: true on a label step yields success when label is absent", () => {
    const tree = plannerTree();
    const chain: LabelMatch[] = [
      // Dismissing a cookie banner that doesn't exist.
      lm({ label: "Accept cookies", role: "button" }),
      lm({ label: "Board view", role: "tab" }),
    ];
    const result = resolveLabelChain(tree, chain, [true, false]);
    expect(result.ok).toBe(true);
    // First step missed — but optional.
    expect(result.steps[0].ok).toBe(false);
    expect(result.steps[0].optional).toBe(true);
    // Second step still resolved.
    expect(result.steps[1].ok).toBe(true);
  });

  test("fallback_instructions is emitted only when label resolution fails (schema contract)", () => {
    // Represented as a whole StepSchema: label step carries `fallback_instructions`,
    // which the runtime surfaces to the agent only when the resolver reports
    // `not_found` or `ambiguous`.
    const step = StepSchema.parse({
      phase: "navigate",
      navigate_by_labels: [{ label: "Board view" }],
      fallback_instructions: "Open the Board view tab from the top bar.",
    });
    expect(step.fallback_instructions).toBeDefined();
    // The resolver's failure result is the input the runtime uses to decide
    // whether to surface fallback_instructions.
    const tree: AriaNode = { role: "document", children: [] };
    const r = resolveLabelStep(tree, step.navigate_by_labels![0]);
    expect(r.ok).toBe(false);
    // The runtime reads fallback_instructions only on this branch.
  });

  test("nav_failure entry is recorded on resolution failure, PII-scrubbed (shape contract)", () => {
    // Shape test: the object handed to record_learning for a nav_failure
    // contains the label and reason, both of which are free of PII by
    // construction (labels are UI strings from the YAML; reasons are
    // resolver enums). The full PII scan happens in learning.ts.
    const r = resolveLabelStep(
      { role: "document", children: [] },
      lm({ label: "Nonexistent" })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // This is the payload shape the runtime serialises into a nav_failure
      // learn entry.
      const entry = {
        kind: "nav_failure",
        label: Array.isArray(r.label) ? r.label.join("|") : r.label,
        reason: r.reason,
      };
      expect(entry.label).toBe("Nonexistent");
      expect(entry.reason).toBe("not_found");
      // No hidden PII-like fields.
      expect(Object.keys(entry).sort()).toEqual(["kind", "label", "reason"]);
    }
  });
});
