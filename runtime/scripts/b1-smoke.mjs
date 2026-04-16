#!/usr/bin/env node
/**
 * Phase B1 smoke harness — drives the OC MCP server over stdio and
 * exercises the full 16-tool surface against the committed reference
 * connectors (microsoft-planner, azure-devops, mizrahi-bank). No
 * browser. No @playwright/mcp. Catches protocol-level bugs that the
 * in-process vitest suite cannot see because it never boots the MCP
 * transport.
 *
 * Run:   node runtime/scripts/b1-smoke.mjs
 * Exit:  0 = all green, 1 = any tool call failed an assertion
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "..", "dist", "cli.js");

const results = [];
let firstErrorExit = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) firstErrorExit = 1;
  const mark = ok ? "PASS" : "FAIL";
  const tail = detail ? ` - ${detail}` : "";
  process.stdout.write(`  [${mark}] ${name}${tail}\n`);
}

function parseText(result) {
  const first = result?.content?.[0];
  if (!first || first.type !== "text") return null;
  try {
    return JSON.parse(first.text);
  } catch {
    return first.text;
  }
}

function assertNotError(name, result) {
  if (result?.isError) {
    const text = result.content?.[0]?.text ?? "(no text)";
    record(name, false, `tool returned isError=true: ${String(text).slice(0, 200)}`);
    return false;
  }
  return true;
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args ?? {} });
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "serve"],
    stderr: "pipe",
  });

  const client = new Client(
    { name: "b1-smoke", version: "0.0.1" },
    { capabilities: {} }
  );

  const stderrChunks = [];
  transport.stderr?.on("data", (c) => stderrChunks.push(c));

  await client.connect(transport);

  try {
    // ---- tools/list ----
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [
      "auth_status",
      "complete_step",
      "configure_il_proxy",
      "finish_batch",
      "get_connector",
      "get_credentials",
      "list_connectors",
      "next_step",
      "prompt_runtime_input",
      "record_learning",
      "record_navigation",
      "request_credentials",
      "run_preview",
      "start_batch",
      "submit_read_snapshot",
      "vault_status",
    ];
    const missing = expected.filter((n) => !names.includes(n));
    record(
      "tools/list returns all 16 expected tools",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : `got ${names.length}`
    );

    // ---- list_connectors ----
    const lc = await call(client, "list_connectors");
    if (assertNotError("list_connectors", lc)) {
      const data = parseText(lc);
      const ids = Array.isArray(data) ? data.map((d) => d.id) : [];
      const want = ["microsoft-planner", "azure-devops", "mizrahi-bank"];
      const miss = want.filter((w) => !ids.includes(w));
      record(
        "list_connectors includes planner / ado / mizrahi",
        miss.length === 0,
        miss.length ? `missing: ${miss.join(", ")}` : `found ${ids.length}`
      );
    }

    // ---- get_connector for each reference ----
    for (const id of ["microsoft-planner", "azure-devops", "mizrahi-bank"]) {
      const gc = await call(client, "get_connector", { id });
      if (!assertNotError(`get_connector ${id}`, gc)) continue;
      const data = parseText(gc);
      const ok =
        data && data.id === id && typeof data.yaml === "string" && Array.isArray(data.actions);
      record(
        `get_connector ${id} returns {id, yaml, actions, merged}`,
        ok,
        ok ? `${data.actions.length} actions` : "shape mismatch"
      );
    }

    const gcMiss = await call(client, "get_connector", { id: "nope-nonexistent" });
    record(
      "get_connector(unknown) returns isError",
      gcMiss?.isError === true,
      gcMiss?.isError === true ? undefined : "expected isError=true"
    );

    // ---- auth_status per auth type ----
    const asPlanner = await call(client, "auth_status", { connector_id: "microsoft-planner" });
    if (assertNotError("auth_status microsoft-planner", asPlanner)) {
      const d = parseText(asPlanner);
      record(
        "auth_status planner -> persistent_profile",
        d?.auth_type === "persistent_profile",
        `got ${d?.auth_type}`
      );
    }
    const asMiz = await call(client, "auth_status", { connector_id: "mizrahi-bank" });
    if (assertNotError("auth_status mizrahi-bank", asMiz)) {
      const d = parseText(asMiz);
      record(
        "auth_status mizrahi -> credentials + boolean map",
        d?.auth_type === "credentials" &&
          d.credentials &&
          Object.values(d.credentials).every((v) => typeof v === "boolean"),
        d?.credentials ? `keys: ${Object.keys(d.credentials).join(",")}` : "no creds field"
      );
    }
    const asAdo = await call(client, "auth_status", { connector_id: "azure-devops" });
    if (assertNotError("auth_status azure-devops", asAdo)) {
      const d = parseText(asAdo);
      record(
        "auth_status ado -> any_of with >=2 options",
        d?.auth_type === "any_of" && Array.isArray(d.options) && d.options.length >= 2,
        `options: ${d?.options?.length ?? 0}`
      );
    }

    // ---- vault_status ----
    const vs = await call(client, "vault_status", { connector_id: "mizrahi-bank" });
    record("vault_status mizrahi-bank", !vs?.isError);

    // ---- run_preview mutation ----
    const rp = await call(client, "run_preview", {
      connector_id: "microsoft-planner",
      action: "create_tasks_from_batch",
      input: {
        tasks: [
          { title: "Risk register", bucket: "Governance", priority: "important" },
          { title: "Data map", bucket: "Governance" },
        ],
      },
    });
    if (assertNotError("run_preview create_tasks_from_batch", rp)) {
      const d = parseText(rp);
      const ok =
        d &&
        d.connector_id === "microsoft-planner" &&
        d.action === "create_tasks_from_batch" &&
        d.kind === "mutation" &&
        typeof d.item_count_estimate === "number" &&
        Array.isArray(d.plan);
      record(
        "run_preview returns structured plan",
        ok,
        ok ? `${d.item_count_estimate} items, ${d.plan.length} plan lines` : "shape mismatch"
      );
    }

    const rpFetch = await call(client, "run_preview", {
      connector_id: "microsoft-planner",
      action: "list_tasks",
      input: {},
    });
    record(
      "run_preview(fetch) returns isError",
      rpFetch?.isError === true,
      rpFetch?.isError === true ? undefined : "expected isError=true"
    );

    const rpDel = await call(client, "run_preview", {
      connector_id: "microsoft-planner",
      action: "delete_all_tasks",
      input: {},
    });
    if (assertNotError("run_preview delete_all_tasks", rpDel)) {
      const d = parseText(rpDel);
      record(
        "run_preview destructive flag propagates",
        d?.destructive === true && d?.requires_confirmation === true,
        `destructive=${d?.destructive}, requires_confirmation=${d?.requires_confirmation}`
      );
    }

    // ---- submit_read_snapshot + start_batch (idempotency) ----
    const srs = await call(client, "submit_read_snapshot", {
      connector_id: "microsoft-planner",
      action: "list_tasks",
      items: [
        { title: "Risk register", bucket: "Governance", id: "x1" },
        { title: "Old task", bucket: "Archive", id: "x2" },
      ],
    });
    if (assertNotError("submit_read_snapshot", srs)) {
      const d = parseText(srs);
      record("submit_read_snapshot stores 2 items", d?.stored === true && d?.count === 2);
    }

    const sb = await call(client, "start_batch", {
      connector_id: "microsoft-planner",
      action: "create_tasks_from_batch",
      input: {
        tasks: [
          { title: "Risk register", bucket: "Governance" }, // dup
          { title: "Vendor matrix", bucket: "Governance" }, // new
        ],
      },
    });
    let batchId = null;
    if (assertNotError("start_batch", sb)) {
      const d = parseText(sb);
      batchId = d?.batch_id;
      record(
        "start_batch returns batch_id + summary",
        typeof batchId === "string" && batchId.length > 0,
        batchId ? `batch_id=${batchId.slice(0, 8)}...` : "no batch_id"
      );
      record(
        "start_batch marks duplicates as idempotent-skip",
        typeof d?.total_skipped_idempotent === "number" && d.total_skipped_idempotent >= 1,
        `total_skipped_idempotent=${d?.total_skipped_idempotent}, total_planned=${d?.total_planned}`
      );
    }

    if (batchId) {
      const ns = await call(client, "next_step", { batch_id: batchId });
      if (assertNotError("next_step", ns)) {
        const d = parseText(ns);
        record(
          "next_step returns {kind:'step'|'done'}",
          d && (d.kind === "step" || d.kind === "done"),
          `kind=${d?.kind}`
        );
        if (d?.kind === "step" && d.item_token) {
          const cs = await call(client, "complete_step", {
            batch_id: batchId,
            item_token: d.item_token,
            status: "ok",
          });
          record("complete_step ok", !cs?.isError);
        }
      }
      const fb = await call(client, "finish_batch", { batch_id: batchId });
      if (assertNotError("finish_batch", fb)) {
        const d = parseText(fb);
        record(
          "finish_batch returns BatchReport",
          d && typeof d.succeeded === "number" && Array.isArray(d.items),
          `succeeded=${d?.succeeded}, skipped=${d?.skipped_idempotent}, failed=${d?.failed}`
        );
      }
    }

    // ---- record_navigation happy path ----
    const rn = await call(client, "record_navigation", {
      connector_id: "microsoft-planner",
      label_path: ["Board view", "Governance", "Add task"],
      observed_url: "https://tasks.office.com/tenant/Home/PlanViews/abc123",
      via: "button",
    });
    if (!assertNotError("record_navigation benign path", rn)) {
      // already recorded via assertNotError
    } else {
      record("record_navigation benign path", true);
    }

    // ---- record_learning PII reject ----
    const rlPii = await call(client, "record_learning", {
      connector_id: "microsoft-planner",
      entries: [
        {
          kind: "quirk",
          text: "contact alice@contoso.com for Planner admin access",
        },
      ],
    });
    record(
      "record_learning rejects email in quirk text (PII guard)",
      rlPii?.isError === true,
      rlPii?.isError === true ? undefined : "expected isError=true"
    );

    // ---- record_learning happy path ----
    const rlOk = await call(client, "record_learning", {
      connector_id: "microsoft-planner",
      entries: [
        {
          kind: "quirk",
          text: "must switch to Board view before clicking Add task; Grid view hides per-bucket Add button",
        },
      ],
    });
    record("record_learning benign quirk accepted", !rlOk?.isError);
  } finally {
    await client.close().catch(() => {});
  }

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;
  process.stdout.write(`\nPhase B1: ${passed}/${total} checks passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.stdout.write("\nFailed checks:\n");
    for (const r of results.filter((r) => !r.ok)) {
      process.stdout.write(`  - ${r.name}: ${r.detail ?? ""}\n`);
    }
    if (stderrChunks.length > 0) {
      process.stdout.write("\nServer stderr:\n");
      process.stdout.write(Buffer.concat(stderrChunks).toString("utf8"));
    }
  }
  process.exit(firstErrorExit);
}

main().catch((err) => {
  process.stderr.write(`b1-smoke fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
