import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createAccount, createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

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

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
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

function assertDeployReceipt(tx: TransactionReceiptLike) {
  const status = txStatus(tx);
  const exec = txExecution(tx);
  if (!/finalized/i.test(status)) {
    throw new Error(`Deploy not finalized: status=${status} execution=${exec}`);
  }
  const execLc = exec.toLowerCase();
  if (!execLc.includes("finished_with_return")) {
    throw new Error(
      `Deploy execution was not FINISHED_WITH_RETURN: status=${status} execution=${exec}`,
    );
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function normalizeSource(text: string): string {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "\n");
}

function makeClient(privateKey: `0x${string}`) {
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

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 10): Promise<T> {
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
      const delay = Math.min(4000 * (i + 1), 15000);
      console.log("RETRY", label, i + 1, msg.replace(/\s+/g, " ").slice(0, 160));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw last;
}

export default async function main(injected?: any) {
  const env = loadEnv();
  const rawKey1 = env.ACCOUNT_PRIVATE_KEY_1;
  if (!rawKey1) {
    throw new Error("ACCOUNT_PRIVATE_KEY_1 must be set in .env");
  }
  const privateKey1 = asHex(rawKey1);

  let client = injected;
  let deployerAccount: { address: `0x${string}` };
  if (!client || typeof client.estimateTransactionFees !== "function") {
    const built = makeClient(privateKey1);
    client = built.client;
    deployerAccount = built.account;
  } else {
    deployerAccount = client.account;
  }

  // 1. Verify chain ID (Read-only RPC call with retry)
  const chainIdHex = await withRetry("eth_chainId", async () => {
    const res = await client.request({ method: "eth_chainId" });
    if (typeof res !== "string") {
      throw new Error(`Expected string from eth_chainId, got ${typeof res}`);
    }
    return res;
  });
  const chainId = Number.parseInt(chainIdHex, 16);
  if (chainId !== CHAIN_ID) {
    throw new Error(`Expected Studio Next chain ID ${CHAIN_ID}, got ${chainId}`);
  }

  // 2. Validate roles
  const producer = asAddress(env.LOTGUARD_PRODUCER || deployerAccount.address);
  const rawKey2 = env.ACCOUNT_PRIVATE_KEY_2;
  const authorityFromKey2 = rawKey2 ? createAccount(asHex(rawKey2)).address : undefined;
  const recallAuthority = asAddress(
    env.LOTGUARD_RECALL_AUTHORITY || authorityFromKey2 || "",
  );

  if (producer.toLowerCase() === recallAuthority.toLowerCase()) {
    throw new Error("LOTGUARD_PRODUCER and LOTGUARD_RECALL_AUTHORITY must be distinct addresses");
  }

  // 3. Load contract source bytes and compute hashes
  const sourceBytes = readFileSync(new URL("../contracts/lotguard.py", import.meta.url));
  const rawFileSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const rawFileText = sourceBytes.toString("utf8");

  // 4. Estimate fees (Read-only call with retry)
  console.log("Estimating fees on Studio Next (chain 61997)...");
  const rawEstimate = await withRetry("estimateTransactionFees", () =>
    client.estimateTransactionFees(),
  );
  assertFeeEstimate(rawEstimate);
  const fees = {
    feeValue: rawEstimate.feeValue,
    distribution: rawEstimate.distribution,
  };
  console.log("Fees estimated:", jsonSafe(fees));

  // 5. Deploy contract — SINGLE BROADCAST, NO AUTOMATIC RETRY
  console.log("Deploying LotGuard contract (single broadcast, no retry) with args:", {
    producer,
    recallAuthority,
  });
  const deployHash = await client.deployContract({
    code: new Uint8Array(sourceBytes),
    args: [producer, recallAuthority],
    fees,
  });
  console.log("DEPLOY_HASH:", deployHash);

  // 6. Wait for transaction receipt (Poll read-only with retry)
  console.log("Waiting for finalized transaction receipt...");
  const rawDeployTx = await withRetry("waitForTransactionReceipt", () =>
    client.waitForTransactionReceipt({
      hash: deployHash,
      waitUntil: "finalized",
      retries: 120,
      interval: 4000,
    }),
  );
  assertReceipt(rawDeployTx);
  assertDeployReceipt(rawDeployTx);

  const contractAddress =
    rawDeployTx.txDataDecoded?.contractAddress ?? rawDeployTx.recipient;
  if (!contractAddress) {
    throw new Error("Finalized deployment receipt has no contract address");
  }
  const normalizedContractAddress = asAddress(contractAddress);

  // 7. Verify on-chain source against exact local file bytes
  console.log("Verifying source code on-chain at", normalizedContractAddress);
  const deployedText = await withRetry("getContractCode", async () => {
    const code = await client.getContractCode(normalizedContractAddress);
    if (typeof code !== "string") {
      throw new Error(`Expected string from getContractCode, got ${typeof code}`);
    }
    return code;
  });
  const deployedSha256 = sha256Text(deployedText);

  const exactByteMatch = deployedText === rawFileText;
  const normalizedLocal = normalizeSource(rawFileText);
  const normalizedDeployed = normalizeSource(deployedText);
  const normalizedMatch = normalizedLocal === normalizedDeployed;

  console.log("Source verification results:");
  console.log(`  Local Raw SHA-256:    ${rawFileSha256}`);
  console.log(`  On-chain SHA-256:     ${deployedSha256}`);
  console.log(`  Exact Byte Match:     ${exactByteMatch ? "PASSED" : "FAILED"}`);
  console.log(`  Normalized Match:     ${normalizedMatch ? "PASSED" : "FAILED"}`);

  if (!exactByteMatch) {
    if (normalizedMatch) {
      console.error(
        "DIAGNOSTIC ONLY: Normalized source text matches, but exact byte equality failed. Canonical verification requires exact byte equality.",
      );
    }
    throw new Error(
      `Canonical source verification FAILED: Deployed source does not match raw local contract file bytes (local=${rawFileSha256}, onchain=${deployedSha256})`,
    );
  }

  const record = {
    rpc: RPC,
    chainId,
    contractAddress: normalizedContractAddress,
    deployHash,
    producer,
    recallAuthority,
    deployer: deployerAccount.address,
    statusName: txStatus(rawDeployTx),
    execution: txExecution(rawDeployTx),
    localRawSha256: rawFileSha256,
    deployedSha256,
    exactByteMatch,
    normalizedMatch,
    sdkTransformationNote: exactByteMatch
      ? "None (Byte-for-byte exact match)"
      : "Line endings or trailing whitespace transformed during on-chain submission",
    fees: jsonSafe(fees),
    explorer: `https://explorer-studio-dev.genlayer.com/address/${normalizedContractAddress}`,
    deployedAt: new Date().toISOString(),
  };

  writeFileSync(
    new URL("../deploy-result.json", import.meta.url),
    JSON.stringify(record, null, 2),
  );
  console.log("LotGuard successfully deployed and recorded:", record);
  return normalizedContractAddress;
}

const isDirect =
  Boolean(process.argv[1]) &&
  String(process.argv[1]).replaceAll("\\", "/").endsWith("deployScript.ts");
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
