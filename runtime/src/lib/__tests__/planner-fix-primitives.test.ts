/**
 * Regression tests for the v1.1 LabelMatch / Capture primitives added so the
 * microsoft-planner connector can resolve the real Planner DOM (Phase B2 smoke
 * findings):
 *   - match_mode: prefix     — bucket headers ("Bucket: <name>, ...")
 *   - match_mode: prefix     — task cards    ("<title>, Use arrow keys ...")
 *   - match_case: false      — "More options" / "More Options" / "More actions"
 *   - capture.from_aria_label_split   — recovers <title> from the suffixed label
 *   - capture.from_aria_label_regex   — alias of from_aria_label_match
 */

import { describe, expect, test } from "vitest";
import {
  resolveLabelStep,
  type AriaNode,
} from "../label-resolver.js";
import {
  CaptureSchema,
  LabelMatchSchema,
  type LabelMatch,
} from "../connector-schema.js";

function lm(partial: Partial<LabelMatch> & { label: LabelMatch["label"] }): LabelMatch {
  return LabelMatchSchema.parse({
    click_action: "click",
    next_scope: "page",
    ...partial,
  });
}

describe("v1.1 LabelMatch primitives — match_mode + match_case", () => {
  test("match_mode: prefix resolves a Planner-style bucket header", () => {
    const tree: AriaNode = {
      role: "document",
      children: [
        {
          role: "group",
          ariaLabel:
            "Bucket: Compliance & Reviews, 1 of 9. 9 tasks in this bucket. " +
            "Press enter to add or view tasks in this column. Press CTRL, Shift, " +
            "and Comma or Period to reorder bucket.",
        },
        {
          role: "group",
          ariaLabel:
            "Bucket: Native Inference, 2 of 9. 5 tasks in this bucket. " +
            "Press enter to add or view tasks in this column.",
        },
      ],
    };
    const r = resolveLabelStep(
      tree,
      lm({
        label: "Bucket: Compliance & Reviews",
        match_mode: "prefix",
        next_scope: "subtree",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.strategy).toBe("aria_label_any_of");
      expect(r.resolved.node.ariaLabel).toContain("Compliance & Reviews");
    }
  });

  test("match_mode: prefix resolves a Planner-style task card by title", () => {
    const tree: AriaNode = {
      role: "list",
      children: [
        {
          role: "listitem",
          ariaLabel:
            "[PM] Compliance Go/No-Go gate (target May 30), Use arrow keys to " +
            "access important task information, press enter to access all task details.",
        },
        {
          role: "listitem",
          ariaLabel:
            "Other task title, Use arrow keys to access important task information, ...",
        },
      ],
    };
    const r = resolveLabelStep(
      tree,
      lm({
        label: "[PM] Compliance Go/No-Go gate (target May 30), Use arrow keys",
        match_mode: "prefix",
        click_action: "hover",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(
        (r.resolved.node.ariaLabel as string).startsWith(
          "[PM] Compliance Go/No-Go gate"
        )
      ).toBe(true);
    }
  });

  test("match_case: false matches 'More Options' / 'More options' / 'More actions'", () => {
    // Three coexisting overflow buttons inside one card subtree, with
    // inconsistent casing across tenants. `label_any_of` (label as array) +
    // match_case: false must resolve cleanly when scoped to a single card.
    const oneCard: AriaNode = {
      role: "listitem",
      children: [
        { role: "button", ariaLabel: "More Options" },
      ],
    };
    const r = resolveLabelStep(
      oneCard,
      lm({
        label: ["More options", "More actions"],
        match_case: false,
        role: "button",
      })
    );
    expect(r.ok).toBe(true);
  });

  test("default match_mode (exact) is unchanged from v1.0.0", () => {
    const tree: AriaNode = {
      role: "document",
      children: [{ role: "tab", name: "View Board" }],
    };
    const exact = resolveLabelStep(tree, lm({ label: "View Board", role: "tab" }));
    expect(exact.ok).toBe(true);
    const wrong = resolveLabelStep(tree, lm({ label: "Brd", role: "tab" }));
    expect(wrong.ok).toBe(false);
  });
});

describe("v1.1 Capture primitives", () => {
  test("from_aria_label_regex parses without error", () => {
    const c = CaptureSchema.parse({
      as: "title",
      from_aria_label_regex: "^(.+?), Use arrow keys",
    });
    expect(c.from_aria_label_regex).toBe("^(.+?), Use arrow keys");
  });

  test("from_aria_label_split parses without error", () => {
    const c = CaptureSchema.parse({
      as: "title",
      from_aria_label_split: ", Use arrow keys",
    });
    expect(c.from_aria_label_split).toBe(", Use arrow keys");
  });

  test("specifying two capture sources is rejected", () => {
    expect(() =>
      CaptureSchema.parse({
        as: "title",
        from_aria_label_match: "^(.+?), x",
        from_aria_label_split: ", x",
      })
    ).toThrow();
  });
});
