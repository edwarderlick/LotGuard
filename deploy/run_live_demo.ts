import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

type CalldataEncodable =
  | null
  | boolean
  | string
  | number
  | bigint
  | Uint8Array
  | CalldataEncodable[]
  | { [key: string]: CalldataEncodable };

const RPC = "https://studio-next.genlayer.com/api";
const CHAIN_ID = 61997;

function loadEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(new URL("../.env", import.meta.url), "utf8")
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

function asHex(val: string): `0x${string}` {
  const trimmed = val.trim();
  if (!trimmed.startsWith("0x") || trimmed.length < 3) {
    throw new Error(`Invalid hex value: ${val}`);
  }
  return trimmed as `0x${string}`;
}

function asAddress(val: string): `0x${string}` {
  const trimmed = val.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`Invalid Ethereum address: ${val}`);
  }
  return trimmed as `0x${string}`;
}

interface FeeEstimate {
  feeValue: bigint;
  distribution: unknown;
}

function assertFeeEstimate(est: unknown): asserts est is FeeEstimate {
  if (
    typeof est !== "object" ||
    est === null ||
    !("feeValue" in est) ||
    !("distribution" in est)
  ) {
    throw new Error("Invalid fee estimation response from client");
  }
}

interface TransactionReceiptLike {
  status?: number | string;
  statusName?: string;
  txExecutionResultName?: string;
  executionResult?: string;
  txDataDecoded?: { contractAddress?: string };
  recipient?: string;
}

function assertReceipt(tx: unknown): asserts tx is TransactionReceiptLike {
  if (typeof tx !== "object" || tx === null) {
    throw new Error("Transaction receipt is not a valid object");
  }
}

const STATUS_BY_NUMBER: Record<number, string> = {
  0: "UNINITIALIZED",
  1: "PENDING",
  2: "PROPOSING",
  3: "COMMITTING",
  4: "REVEALING",
  5: "ACCEPTED",
  6: "UNDETERMINED",
  7: "FINALIZED",
  8: "CANCELED",
};

function txStatus(tx: TransactionReceiptLike): string {
  if (tx.statusName) return String(tx.statusName);
  const raw = tx.status;
  if (typeof raw === "number" && STATUS_BY_NUMBER[raw]) return STATUS_BY_NUMBER[raw];
  if (STATUS_BY_NUMBER[Number(raw)]) return STATUS_BY_NUMBER[Number(raw)];
  return String(raw ?? "");
}

function txExecution(tx: TransactionReceiptLike): string {
  return String(tx.txExecutionResultName ?? tx.executionResult ?? "");
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 15): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String(err);
      if (
        !/ETIMEDOUT|fetch failed|unknown RPC|socket|econnreset|network|ECONNREFUSED|ENOTFOUND|UND_ERR|gateway|timeout|502|503|504/i.test(
          msg,
        )
      ) {
        throw err;
      }
      const delay = Math.min(3000 * (i + 1), 15000);
      console.log(`[RETRY ${i + 1}/${attempts}] ${label}: ${msg.slice(0, 120)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last;
}

function createStudioClient(privateKey: `0x${string}`) {
  const account = createAccount(privateKey);
  const client = createClient({
    chain: {
      ...studioDevnet,
      rpcUrls: { default: { http: [RPC] } },
    },
    endpoint: RPC,
    account,
  });
  return { account, client };
}

interface StepLog {
  step: string;
  txHash?: string;
  status?: string;
  execution?: string;
  expectedOutcome: string;
  observedOutcome: string;
  passed: boolean;
}

export async function runLiveDemo(targetContractAddress?: `0x${string}`) {
  const env = loadEnv();
  const rawKey1 = env.ACCOUNT_PRIVATE_KEY_1;
  const rawKey2 = env.ACCOUNT_PRIVATE_KEY_2;
  if (!rawKey1 || !rawKey2) {
    throw new Error("ACCOUNT_PRIVATE_KEY_1 and ACCOUNT_PRIVATE_KEY_2 must be set in .env");
  }

  const { account: acc1, client: client1 } = createStudioClient(asHex(rawKey1));
  const { account: acc2, client: client2 } = createStudioClient(asHex(rawKey2));

  let contractAddress = targetContractAddress;
  if (!contractAddress) {
    const deployResultPath = new URL("../deploy-result.json", import.meta.url);
    if (existsSync(deployResultPath)) {
      const record = JSON.parse(readFileSync(deployResultPath, "utf8"));
      contractAddress = asAddress(record.contractAddress);
    }
  }

  if (!contractAddress) {
    throw new Error("No contract address available. Deploy first or provide address as argument.");
  }

  console.log("================================================================================");
  console.log("            LOTGUARD STUDIO NEXT LIVE INTEGRATION DEMONSTRATION                ");
  console.log("================================================================================");
  console.log(`Contract:         ${contractAddress}`);
  console.log(`Producer / Acc1:  ${acc1.address}`);
  console.log(`Authority / Acc2: ${acc2.address}`);
  console.log(`RPC Endpoint:     ${RPC}`);
  console.log("--------------------------------------------------------------------------------\n");

  const evidence: {
    contractAddress: string;
    sourceSha256: string;
    timestamp: string;
    steps: StepLog[];
  } = {
    contractAddress,
    sourceSha256: createHash("sha256")
      .update(readFileSync(new URL("../contracts/lotguard.py", import.meta.url)))
      .digest("hex"),
    timestamp: new Date().toISOString(),
    steps: [],
  };

  // Helper to send a write transaction with explicit fee estimation (no retry on broadcast)
  async function executeWriteTx(
    stepName: string,
    client: typeof client1,
    fnName: string,
    args: CalldataEncodable[],
    expectSuccess = true,
  ): Promise<{ txHash: string; status: string; execution: string }> {
    console.log(`\n>>> [EXECUTE] ${stepName}`);
    console.log(`    Calling ${fnName}(${JSON.stringify(args).slice(0, 120)})...`);

    // 1. Fee estimation (read-only with retry)
    const rawFee = await withRetry(`estimateFees:${fnName}`, () =>
      client.estimateTransactionFees(),
    );
    assertFeeEstimate(rawFee);
    const fees = { feeValue: rawFee.feeValue, distribution: rawFee.distribution };

    // 2. Single broadcast (NO automatic retry on broadcast)
    const txHash = await client.writeContract({
      address: contractAddress!,
      functionName: fnName,
      args,
      fees,
    });
    console.log(`    TX_HASH: ${txHash}`);

    // 3. Poll receipt with retry
    const receipt = await withRetry(`waitForReceipt:${fnName}`, () =>
      client.waitForTransactionReceipt({
        hash: txHash,
        waitUntil: "finalized",
        retries: 120,
        interval: 4000,
      }),
    );
    assertReceipt(receipt);

    const status = txStatus(receipt);
    const exec = txExecution(receipt);
    console.log(`    Receipt Status: ${status} | Execution: ${exec}`);

    if (expectSuccess) {
      if (!/finalized/i.test(status)) {
        throw new Error(`Step '${stepName}' failed: transaction status is ${status}`);
      }
      if (!exec.toLowerCase().includes("finished_with_return")) {
        throw new Error(
          `Step '${stepName}' failed: expected FINISHED_WITH_RETURN, got ${exec}`,
        );
      }
    } else {
      if (!/finalized/i.test(status)) {
        throw new Error(
          `Step '${stepName}' failed: expected FINALIZED status for blocked transaction, got ${status}`,
        );
      }
      if (
        !exec.toLowerCase().includes("finished_with_error") &&
        !exec.toLowerCase().includes("reverted")
      ) {
        throw new Error(
          `Step '${stepName}' failed: expected FINISHED_WITH_ERROR for blocked transaction, got ${exec}`,
        );
      }
    }

    return { txHash, status, execution: exec };
  }

  // Helper to read state
  async function readState<T>(fnName: string, args: CalldataEncodable[] = []): Promise<T> {
    const res = await withRetry(`readContract:${fnName}`, () =>
      client1.readContract({
        address: contractAddress!,
        functionName: fnName,
        args,
      }),
    );
    return res as T;
  }

  // ---------------------------------------------------------------------------
  // STEP 1: Register Five Batches
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 1: Register Five Batches in Topological Order");
  console.log("================================================================================");

  const batchesToRegister = [
    { id: "FLOUR-A", prod: "flour", fac: "Pune plant", date: "2026-10-03", parents: [] },
    { id: "FLOUR-B", prod: "flour", fac: "Mumbai plant", date: "2026-10-03", parents: [] },
    { id: "SNACK-A", prod: "snack", fac: "Pune packaging", date: "2026-10-05", parents: ["FLOUR-A"] },
    { id: "SNACK-B", prod: "snack", fac: "Mumbai packaging", date: "2026-10-05", parents: ["FLOUR-B"] },
    { id: "COMBO", prod: "snack combo", fac: "Pune packaging", date: "2026-10-06", parents: ["FLOUR-A", "FLOUR-B"] },
  ];

  for (const b of batchesToRegister) {
    const res = await executeWriteTx(
      `Register batch ${b.id}`,
      client1,
      "register_batch",
      [b.id, b.prod, b.fac, b.date, acc1.address, JSON.stringify(b.parents)],
    );
    evidence.steps.push({
      step: `Register ${b.id}`,
      txHash: res.txHash,
      status: res.status,
      execution: res.execution,
      expectedOutcome: "Batch registered with initial custodian Acc1",
      observedOutcome: `FINALIZED, execution=${res.execution}`,
      passed: true,
    });
  }

  const allBatchIds = await readState<string[]>("get_all_batch_ids");
  console.log("  Registered batch IDs on-chain:", allBatchIds);
  if (allBatchIds.length !== 5) {
    throw new Error(`Expected 5 registered batches, got ${allBatchIds.length}`);
  }

  // ---------------------------------------------------------------------------
  // STEP 2: Unaffected Custody Transfer (Normal Operations)
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 2: Demonstrate Unaffected Custody Transfer (FLOUR-B -> Acc2)");
  console.log("================================================================================");
  const transfer1Res = await executeWriteTx(
    "Transfer FLOUR-B to Acc2",
    client1,
    "transfer_custody",
    ["FLOUR-B", acc2.address],
  );
  const flourBRecord = await readState<{ custodian: string }>("get_batch", ["FLOUR-B"]);
  console.log("  FLOUR-B updated custodian on-chain:", flourBRecord.custodian);
  const flourBPassed = flourBRecord.custodian.toLowerCase() === acc2.address.toLowerCase();
  evidence.steps.push({
    step: "Transfer FLOUR-B (Unaffected)",
    txHash: transfer1Res.txHash,
    status: transfer1Res.status,
    execution: transfer1Res.execution,
    expectedOutcome: `Custodian updated to ${acc2.address}`,
    observedOutcome: `Custodian is ${flourBRecord.custodian}`,
    passed: flourBPassed,
  });
  if (!flourBPassed) throw new Error("FLOUR-B custodian mismatch after transfer");

  // ---------------------------------------------------------------------------
  // STEP 3: Issue Notice 1 (Pune Notice) & Quarantining Descendants
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 3: Issue Pune Recall Notice (Direct FLOUR-A -> Quarantines FLOUR-A, SNACK-A, COMBO)");
  console.log("================================================================================");
  const puneNoticeText = "Recall flour produced at the Pune plant from October 1 through October 4, 2026.";
  const notice1Res = await executeWriteTx(
    "Issue Pune Notice (Notice 0)",
    client2,
    "issue_notice",
    [puneNoticeText],
  );

  const q1 = await readState<string[]>("get_quarantined_batch_ids");
  console.log("  On-chain quarantined batches after Pune notice:", q1);
  const q1Expected = ["COMBO", "FLOUR-A", "SNACK-A"];
  const q1Matches = q1Expected.every((id) => q1.includes(id)) && !q1.includes("FLOUR-B") && !q1.includes("SNACK-B");

  evidence.steps.push({
    step: "Issue Pune Recall Notice",
    txHash: notice1Res.txHash,
    status: notice1Res.status,
    execution: notice1Res.execution,
    expectedOutcome: "FLOUR-A, SNACK-A, and COMBO quarantined; FLOUR-B and SNACK-B clear",
    observedOutcome: `Quarantined: ${JSON.stringify(q1)}`,
    passed: q1Matches,
  });
  if (!q1Matches) throw new Error(`Quarantine state mismatch after Pune notice: ${JSON.stringify(q1)}`);

  // ---------------------------------------------------------------------------
  // STEP 4: Demonstrate Blocked Custody Transfer on Quarantined COMBO
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 4: Demonstrate Blocked Custody Transfer for Quarantined COMBO");
  console.log("================================================================================");
  const blockedRes = await executeWriteTx(
    "Attempt transfer of quarantined COMBO (Expected to fail/revert)",
    client1,
    "transfer_custody",
    ["COMBO", acc2.address],
    false, // expect non-success
  );
  const comboBeforeRetract = await readState<{ custodian: string }>("get_batch", ["COMBO"]);
  const blockedPassed =
    !blockedRes.execution.toLowerCase().includes("finished_with_return") &&
    comboBeforeRetract.custodian.toLowerCase() === acc1.address.toLowerCase();

  console.log("  Blocked transfer result:", blockedRes.execution);
  console.log("  COMBO custodian unchanged on-chain:", comboBeforeRetract.custodian);
  evidence.steps.push({
    step: "Blocked Custody Transfer on COMBO",
    txHash: blockedRes.txHash,
    status: blockedRes.status,
    execution: blockedRes.execution,
    expectedOutcome: "Transaction execution fails and custodian remains Acc1",
    observedOutcome: `Execution: ${blockedRes.execution}, Custodian: ${comboBeforeRetract.custodian}`,
    passed: blockedPassed,
  });
  if (!blockedPassed) throw new Error("Blocked transfer unexpectedly succeeded or mutated state");

  // ---------------------------------------------------------------------------
  // STEP 5: Issue Notice 2 (Mumbai Notice) & Dual Root Quarantine
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 5: Issue Mumbai Recall Notice (Direct FLOUR-B -> Quarantines All 5 Batches)");
  console.log("================================================================================");
  const mumbaiNoticeText = "Recall flour produced at the Mumbai plant from October 1 through October 4, 2026.";
  const notice2Res = await executeWriteTx(
    "Issue Mumbai Notice (Notice 1)",
    client2,
    "issue_notice",
    [mumbaiNoticeText],
  );

  const q2 = await readState<string[]>("get_quarantined_batch_ids");
  console.log("  On-chain quarantined batches after Mumbai notice:", q2);
  const allFiveQuarantined = q2.length === 5;
  evidence.steps.push({
    step: "Issue Mumbai Recall Notice",
    txHash: notice2Res.txHash,
    status: notice2Res.status,
    execution: notice2Res.execution,
    expectedOutcome: "All 5 batches quarantined under dual active notices",
    observedOutcome: `Quarantined count: ${q2.length} (${JSON.stringify(q2)})`,
    passed: allFiveQuarantined,
  });
  if (!allFiveQuarantined) throw new Error(`Expected all 5 batches quarantined, got ${q2.length}`);

  // ---------------------------------------------------------------------------
  // STEP 6: Retract Notice 0 (Pune) & Verify COMBO REMAINS Quarantined
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 6: Retract Pune Notice (FLOUR-A/SNACK-A cleared, but COMBO REMAINS Quarantined)");
  console.log("================================================================================");
  const retract1Res = await executeWriteTx(
    "Retract Notice 0 (Pune)",
    client2,
    "retract_notice",
    ["0", "Pune flour cleared after laboratory testing"],
  );

  const q3 = await readState<string[]>("get_quarantined_batch_ids");
  console.log("  On-chain quarantined batches after Pune retraction:", q3);
  const flourACleared = !(await readState<boolean>("is_batch_quarantined", ["FLOUR-A"]));
  const snackACleared = !(await readState<boolean>("is_batch_quarantined", ["SNACK-A"]));
  const comboStillQuarantined = await readState<boolean>("is_batch_quarantined", ["COMBO"]);
  const flourBStillQuarantined = await readState<boolean>("is_batch_quarantined", ["FLOUR-B"]);

  const step6Passed = flourACleared && snackACleared && comboStillQuarantined && flourBStillQuarantined;
  console.log("  FLOUR-A cleared:", flourACleared);
  console.log("  SNACK-A cleared:", snackACleared);
  console.log("  COMBO remains quarantined (due to Mumbai notice):", comboStillQuarantined);

  // Assert COMBO transfer is still blocked
  const blockedTransferAfterRetract1 = await executeWriteTx(
    "Attempt transfer of COMBO while still quarantined by Mumbai notice",
    client1,
    "transfer_custody",
    ["COMBO", acc2.address],
    false,
  );
  const comboAfterBlocked2 = await readState<{ custodian: string }>("get_batch", ["COMBO"]);
  console.log("  Second blocked transfer result:", blockedTransferAfterRetract1.execution);
  console.log("  COMBO custodian unchanged on-chain:", comboAfterBlocked2.custodian);
  const blocked2Passed =
    !blockedTransferAfterRetract1.execution.toLowerCase().includes("finished_with_return") &&
    comboAfterBlocked2.custodian.toLowerCase() === acc1.address.toLowerCase();
  if (!blocked2Passed) {
    throw new Error("COMBO custodian unexpectedly changed or transfer succeeded while under Mumbai notice");
  }

  evidence.steps.push({
    step: "Retract Pune Notice (Persistent COMBO Quarantine)",
    txHash: retract1Res.txHash,
    status: retract1Res.status,
    execution: retract1Res.execution,
    expectedOutcome: "FLOUR-A/SNACK-A cleared; COMBO remains quarantined by Mumbai notice",
    observedOutcome: `Quarantined: ${JSON.stringify(q3)}`,
    passed: step6Passed,
  });

  evidence.steps.push({
    step: "Blocked Custody Transfer on COMBO (Covered by Mumbai Notice)",
    txHash: blockedTransferAfterRetract1.txHash,
    status: blockedTransferAfterRetract1.status,
    execution: blockedTransferAfterRetract1.execution,
    expectedOutcome: "Transfer blocked while covered by active Mumbai notice; custodian remains Acc1",
    observedOutcome: `Execution: ${blockedTransferAfterRetract1.execution}, Custodian: ${comboAfterBlocked2.custodian}`,
    passed: blocked2Passed,
  });
  if (!step6Passed) throw new Error("Step 6 failed: COMBO was prematurely unquarantined");

  // ---------------------------------------------------------------------------
  // STEP 7: Retract Notice 1 (Mumbai) & Full Quarantine Clearance
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 7: Retract Mumbai Notice (All Batches Now Cleared)");
  console.log("================================================================================");
  const retract2Res = await executeWriteTx(
    "Retract Notice 1 (Mumbai)",
    client2,
    "retract_notice",
    ["1", "Mumbai flour cleared after inspection"],
  );

  const q4 = await readState<string[]>("get_quarantined_batch_ids");
  console.log("  On-chain quarantined batches after Mumbai retraction:", q4);
  const allClear = q4.length === 0;
  evidence.steps.push({
    step: "Retract Mumbai Notice (Full Clearance)",
    txHash: retract2Res.txHash,
    status: retract2Res.status,
    execution: retract2Res.execution,
    expectedOutcome: "All batches clear of quarantine (quarantine count = 0)",
    observedOutcome: `Quarantined count: ${q4.length}`,
    passed: allClear,
  });
  if (!allClear) throw new Error(`Batches still quarantined after full retraction: ${JSON.stringify(q4)}`);

  // ---------------------------------------------------------------------------
  // STEP 8: Transfer COMBO Now Succeeds!
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("STEP 8: Demonstrate COMBO Transfer Now Succeeds");
  console.log("================================================================================");
  const finalTransferRes = await executeWriteTx(
    "Transfer COMBO to Acc2 after full retraction",
    client1,
    "transfer_custody",
    ["COMBO", acc2.address],
    true,
  );

  const comboFinal = await readState<{ custodian: string }>("get_batch", ["COMBO"]);
  console.log("  COMBO custodian updated on-chain:", comboFinal.custodian);
  const finalTransferPassed = comboFinal.custodian.toLowerCase() === acc2.address.toLowerCase();
  evidence.steps.push({
    step: "Transfer COMBO (Post-Clearance)",
    txHash: finalTransferRes.txHash,
    status: finalTransferRes.status,
    execution: finalTransferRes.execution,
    expectedOutcome: `COMBO custodian successfully updated to ${acc2.address}`,
    observedOutcome: `COMBO custodian is ${comboFinal.custodian}`,
    passed: finalTransferPassed,
  });
  if (!finalTransferPassed) throw new Error("COMBO custodian did not update after clearance");

  // ---------------------------------------------------------------------------
  // Save Compact Evidence
  // ---------------------------------------------------------------------------
  const evidencePath = new URL("../live-demo-evidence.json", import.meta.url);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log("\n================================================================================");
  console.log(">>> ALL LIVE INTEGRATION SCENARIOS PASSED WITH OBSERVED ON-CHAIN VERIFICATION <<<");
  console.log(`Compact evidence written to: ${evidencePath.pathname}`);
  console.log("================================================================================\n");

  return evidence;
}

const isDirect =
  Boolean(process.argv[1]) &&
  String(process.argv[1]).replaceAll("\\", "/").endsWith("run_live_demo.ts");
if (isDirect) {
  runLiveDemo().catch((err) => {
    console.error("LIVE DEMO FAILED:", err);
    process.exit(1);
  });
}
