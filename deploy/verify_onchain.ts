import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function normalizeSource(text: string): string {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "\n");
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

interface ContractRoles {
  producer: string;
  recall_authority: string;
}

interface ContractLimits {
  max_batches: number;
  max_parents: number;
  max_notices: number;
  max_batch_id_len: number;
  max_product_len: number;
  max_facility_len: number;
  max_notice_text_len: number;
  max_reason_len: number;
}

interface ContractCounts {
  batch_count: number;
  notice_count: number;
  active_notice_count: number;
  quarantined_batch_count: number;
}

interface NoticeRecord {
  notice_id: string;
  text: string;
  hash: string;
  direct_roots: string[];
  active: boolean;
  retracted: boolean;
  retraction_reason: string;
  issued_ts: number;
  retracted_ts: number;
}

interface BatchRecord {
  batch_id: string;
  product: string;
  facility: string;
  production_date: string;
  custodian: string;
  parents: string[];
  is_quarantined: boolean;
  registered_ts: number;
}

function assertNoticeRecord(val: unknown): asserts val is NoticeRecord {
  if (
    typeof val !== "object" ||
    val === null ||
    !("notice_id" in val) ||
    !("direct_roots" in val) ||
    !("active" in val) ||
    !("retracted" in val)
  ) {
    throw new Error("Invalid NoticeRecord structure received from contract");
  }
}

function assertBatchRecord(val: unknown): asserts val is BatchRecord {
  if (
    typeof val !== "object" ||
    val === null ||
    !("batch_id" in val) ||
    !("custodian" in val) ||
    !("is_quarantined" in val)
  ) {
    throw new Error("Invalid BatchRecord structure received from contract");
  }
}

function assertStringArray(val: unknown): asserts val is string[] {
  if (!Array.isArray(val) || val.some((x) => typeof x !== "string")) {
    throw new Error("Expected string array from contract");
  }
}

async function main() {
  const env = loadEnv();
  const rawKey1 = env.ACCOUNT_PRIVATE_KEY_1;
  if (!rawKey1) {
    throw new Error("ACCOUNT_PRIVATE_KEY_1 must be set in .env");
  }

  const account = createAccount(asHex(rawKey1));
  const client = createClient({
    chain: {
      ...studioDevnet,
      rpcUrls: { default: { http: [RPC] } },
    },
    endpoint: RPC,
    account,
  });

  const chainIdHex = await withRetry("eth_chainId", async () => {
    const res = await client.request({ method: "eth_chainId" });
    if (typeof res !== "string") {
      throw new Error(`Expected string from eth_chainId, got ${typeof res}`);
    }
    return res;
  });
  const chainId = Number.parseInt(chainIdHex, 16);
  if (chainId !== CHAIN_ID) {
    throw new Error(`Expected chain ${CHAIN_ID}, got ${chainId}`);
  }

  let contractAddressRaw = process.argv[2];
  if (!contractAddressRaw) {
    const deployResultPath = new URL("../deploy-result.json", import.meta.url);
    if (existsSync(deployResultPath)) {
      const record = JSON.parse(readFileSync(deployResultPath, "utf8"));
      contractAddressRaw = record.contractAddress;
    }
  }

  if (!contractAddressRaw) {
    throw new Error("No contract address provided or found in deploy-result.json");
  }
  const contractAddress = asAddress(contractAddressRaw);

  console.log(`Verifying LotGuard contract at ${contractAddress} on Studio Next (${RPC})...`);

  // 1. Source verification: Exact bytes vs Deployed code
  const sourceBytes = readFileSync(new URL("../contracts/lotguard.py", import.meta.url));
  const rawFileSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const rawFileText = sourceBytes.toString("utf8");

  const deployedCode = await withRetry("getContractCode", async () => {
    const code = await client.getContractCode(contractAddress);
    if (typeof code !== "string") {
      throw new Error(`Expected string from getContractCode, got ${typeof code}`);
    }
    return code;
  });
  const onchainSha256 = sha256Text(deployedCode);

  const exactByteMatch = deployedCode === rawFileText;
  const normalizedLocal = normalizeSource(rawFileText);
  const normalizedDeployed = normalizeSource(deployedCode);
  const normalizedMatch = normalizedLocal === normalizedDeployed;

  console.log("Source verification:");
  console.log(`  Local Raw SHA-256:  ${rawFileSha256}`);
  console.log(`  On-chain SHA-256:   ${onchainSha256}`);
  console.log(`  Exact Byte Match:   ${exactByteMatch ? "PASSED" : "FAILED"}`);
  console.log(`  Normalized Match:   ${normalizedMatch ? "PASSED" : "FAILED"}`);

  if (!exactByteMatch) {
    if (normalizedMatch) {
      console.error(
        "DIAGNOSTIC ONLY: Normalized source text matches, but exact byte equality failed. Canonical verification requires exact byte equality.",
      );
    }
    throw new Error(
      `Canonical source verification FAILED: Deployed source does not match raw local contract file bytes (local=${rawFileSha256}, onchain=${onchainSha256})`,
    );
  }

  // 2. Strict On-chain State Reads: MUST FAIL if any required read fails
  console.log("\nReading and asserting on-chain contract state...");

  // Verify get_roles
  const rolesRaw = await withRetry("readContract:get_roles", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_roles",
      args: [],
    }),
  );
  if (typeof rolesRaw !== "object" || rolesRaw === null || !("producer" in rolesRaw) || !("recall_authority" in rolesRaw)) {
    throw new Error(`On-chain state read FAILED: get_roles returned invalid structure: ${JSON.stringify(rolesRaw)}`);
  }
  const roles = rolesRaw as unknown as ContractRoles;
  if (!roles.producer || !roles.recall_authority) {
    throw new Error("On-chain state read FAILED: empty role address in get_roles");
  }
  console.log("  [PASSED] get_roles:", roles);

  // Verify get_limits
  const limitsRaw = await withRetry("readContract:get_limits", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_limits",
      args: [],
    }),
  );
  if (typeof limitsRaw !== "object" || limitsRaw === null || !("max_batches" in limitsRaw) || !("max_notices" in limitsRaw)) {
    throw new Error(`On-chain state read FAILED: get_limits returned invalid structure: ${JSON.stringify(limitsRaw)}`);
  }
  const limits = limitsRaw as unknown as ContractLimits;
  if (Number(limits.max_batches) !== 12 || Number(limits.max_notices) !== 8 || Number(limits.max_parents) !== 3) {
    throw new Error(`On-chain state read FAILED: unexpected limits values: ${JSON.stringify(limits)}`);
  }
  console.log("  [PASSED] get_limits:", limits);

  // Verify get_counts
  const countsRaw = await withRetry("readContract:get_counts", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_counts",
      args: [],
    }),
  );
  if (typeof countsRaw !== "object" || countsRaw === null || !("batch_count" in countsRaw) || !("notice_count" in countsRaw)) {
    throw new Error(`On-chain state read FAILED: get_counts returned invalid structure: ${JSON.stringify(countsRaw)}`);
  }
  const counts = countsRaw as unknown as ContractCounts;
  if (
    Number(counts.batch_count) !== 5 ||
    Number(counts.notice_count) !== 2 ||
    Number(counts.active_notice_count) !== 0 ||
    Number(counts.quarantined_batch_count) !== 0
  ) {
    throw new Error(
      `On-chain state read FAILED: expected batch_count=5, notice_count=2, active_notice_count=0, quarantined_batch_count=0; got: ${JSON.stringify(counts)}`,
    );
  }
  console.log("  [PASSED] get_counts:", counts);

  // Verify Roles Match Expected Addresses
  const expectedProducer = "0x74e8338f52617cbf3e4a2aaa92dda6665ec4991f";
  const expectedAuthority = "0xac344a9ab8808d6fcff1f8d18f794c3b24fe2634";
  if (roles.producer.toLowerCase() !== expectedProducer) {
    throw new Error(`On-chain producer mismatch: expected ${expectedProducer}, got ${roles.producer}`);
  }
  if (roles.recall_authority.toLowerCase() !== expectedAuthority) {
    throw new Error(`On-chain recall authority mismatch: expected ${expectedAuthority}, got ${roles.recall_authority}`);
  }
  console.log("  [PASSED] verified canonical producer (Acc1) and authority (Acc2) addresses");

  // Verify Notice 0 (Pune Notice): direct root FLOUR-A, retracted
  const notice0Raw = await withRetry("readContract:get_notice:0", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_notice",
      args: ["0"],
    }),
  );
  assertNoticeRecord(notice0Raw);
  const notice0 = notice0Raw;
  console.log("  Notice 0 on-chain:", notice0);
  if (!notice0.direct_roots.includes("FLOUR-A") || notice0.direct_roots.length !== 1) {
    throw new Error(`Notice 0 direct_roots mismatch: expected ["FLOUR-A"], got ${JSON.stringify(notice0.direct_roots)}`);
  }
  if (notice0.active !== false || notice0.retracted !== true) {
    throw new Error(`Notice 0 status mismatch: expected active=false, retracted=true; got active=${notice0.active}, retracted=${notice0.retracted}`);
  }
  console.log("  [PASSED] Notice 0 verified (direct root FLOUR-A, active=false, retracted=true)");

  // Verify Notice 1 (Mumbai Notice): direct root FLOUR-B, retracted
  const notice1Raw = await withRetry("readContract:get_notice:1", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_notice",
      args: ["1"],
    }),
  );
  assertNoticeRecord(notice1Raw);
  const notice1 = notice1Raw;
  console.log("  Notice 1 on-chain:", notice1);
  if (!notice1.direct_roots.includes("FLOUR-B") || notice1.direct_roots.length !== 1) {
    throw new Error(`Notice 1 direct_roots mismatch: expected ["FLOUR-B"], got ${JSON.stringify(notice1.direct_roots)}`);
  }
  if (notice1.active !== false || notice1.retracted !== true) {
    throw new Error(`Notice 1 status mismatch: expected active=false, retracted=true; got active=${notice1.active}, retracted=${notice1.retracted}`);
  }
  console.log("  [PASSED] Notice 1 verified (direct root FLOUR-B, active=false, retracted=true)");

  // Verify final COMBO custodian Acc2 and not quarantined
  const comboRaw = await withRetry("readContract:get_batch:COMBO", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_batch",
      args: ["COMBO"],
    }),
  );
  assertBatchRecord(comboRaw);
  const combo = comboRaw;
  console.log("  COMBO batch on-chain:", combo);
  if (combo.custodian.toLowerCase() !== expectedAuthority) {
    throw new Error(`COMBO custodian mismatch: expected ${expectedAuthority} (Acc2), got ${combo.custodian}`);
  }
  if (combo.is_quarantined !== false) {
    throw new Error("COMBO batch unexpectedly quarantined on-chain");
  }
  console.log("  [PASSED] COMBO batch verified (custodian Acc2, is_quarantined=false)");

  // Verify get_quarantined_batch_ids is empty
  const quarantinedRaw = await withRetry("readContract:get_quarantined_batch_ids", () =>
    client.readContract({
      address: contractAddress,
      functionName: "get_quarantined_batch_ids",
      args: [],
    }),
  );
  assertStringArray(quarantinedRaw);
  const quarantinedList = quarantinedRaw;
  if (quarantinedList.length !== 0) {
    throw new Error(`Quarantined list not empty: ${JSON.stringify(quarantinedList)}`);
  }
  console.log("  [PASSED] get_quarantined_batch_ids verified empty (quarantine count = 0)");

  console.log("\nLotGuard On-Chain Verification: ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
