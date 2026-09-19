import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// startManualFlowRun — the owner-triggered "Run manually" action.
// Same fake-Supabase approach as dispatch.test.ts: drive the real
// function against a fake admin client so the assertion is "a run
// was actually started/advanced", not "a helper returned true".
// ============================================================

const h = vi.hoisted(() => ({
  state: {
    nodes: [] as unknown[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    insertedRun: null as Record<string, unknown> | null,
    rpcCalls: [] as string[],
    /** When set, the flow_runs INSERT reports this as a driver error. */
    insertError: null as { message: string } | null,
  },
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_nodes") return h.state.nodes;
    return [];
  }

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: () => b,
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === "flow_runs" && !h.state.insertError) {
          h.state.insertedRun = {
            id: "run-1",
            vars: {},
            reprompt_count: 0,
            ...row,
          };
        }
        return b;
      },
      maybeSingle: async () => {
        if (table === "flow_runs" && h.state.insertError) {
          return { data: null, error: h.state.insertError };
        }
        return {
          data:
            table === "flow_runs" ? h.state.insertedRun : (rows(table)[0] ?? null),
          error: null,
        };
      },
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (
        resolve: (r: { data: unknown[]; error: null; count: number }) => unknown,
      ) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string) => {
        h.state.rpcCalls.push(name);
        return Promise.resolve({ error: null });
      },
    }),
  };
});

const engineSendText = vi.fn(async () => ({ whatsapp_message_id: "wamid.1" }));

vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) =>
    (engineSendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: "wamid.3",
  })),
  engineSendInteractiveList: vi.fn(async () => ({
    whatsapp_message_id: "wamid.4",
  })),
}));

import { startManualFlowRun } from "./engine";
import { supabaseAdmin } from "./admin-client";
import type { FlowRow } from "./types";

const FLOW = {
  id: "flow-1",
  account_id: "acct-1",
  // Author — must NOT end up as flow_runs.user_id for a manual run.
  user_id: "author-1",
  name: "Test flow",
  description: null,
  status: "active",
  trigger_type: "manual",
  trigger_config: {},
  entry_node_id: "start",
  fallback_policy: { on_no_match: "reprompt", on_timeout: "handoff", max_reprompts: 2 },
  execution_count: 0,
  last_executed_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as FlowRow;

const NODES = [
  {
    id: "n1",
    flow_id: "flow-1",
    node_key: "start",
    node_type: "start",
    config: { next_node_key: "greet" },
  },
  {
    id: "n2",
    flow_id: "flow-1",
    node_key: "greet",
    node_type: "send_message",
    config: { text: "Hi there", next_node_key: "done" },
  },
  {
    id: "n3",
    flow_id: "flow-1",
    node_key: "done",
    node_type: "end",
    config: {},
  },
];

function startedRuns() {
  return h.state.inserted.filter((i) => i.table === "flow_runs");
}

beforeEach(() => {
  h.state.nodes = NODES;
  h.state.inserted = [];
  h.state.insertedRun = null;
  h.state.rpcCalls = [];
  h.state.insertError = null;
  engineSendText.mockClear();
});

describe("startManualFlowRun", () => {
  it("inserts a run stamped with the acting owner, not the flow's author", async () => {
    const db = supabaseAdmin();
    const result = await startManualFlowRun(db, FLOW, {
      accountId: "acct-1",
      userId: "owner-1",
      contactId: "ct-1",
      conversationId: "cv-1",
    });

    expect(result.consumed).toBe(true);
    expect(result.flow_run_id).toBe("run-1");

    const [run] = startedRuns();
    expect(run.row).toMatchObject({
      flow_id: "flow-1",
      account_id: "acct-1",
      user_id: "owner-1",
      contact_id: "ct-1",
      conversation_id: "cv-1",
      status: "active",
      current_node_key: "start",
    });

    // The flow actually ran, not just got created.
    expect(engineSendText).toHaveBeenCalledTimes(1);
    expect(h.state.rpcCalls).toContain("increment_flow_execution_count");
  });

  it("returns duplicate_inbound_ignored when the contact already has an active run", async () => {
    h.state.insertError = { message: "duplicate key value violates unique constraint \"idx_one_active_run_per_contact\" (23505)" };

    const db = supabaseAdmin();
    const result = await startManualFlowRun(db, FLOW, {
      accountId: "acct-1",
      userId: "owner-1",
      contactId: "ct-1",
      conversationId: "cv-1",
    });

    expect(result).toEqual({ consumed: true, outcome: "duplicate_inbound_ignored" });
    expect(engineSendText).not.toHaveBeenCalled();
  });
});
