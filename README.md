# LotGuard: Intelligent Batch Custody & Recall Registry

LotGuard is a standalone GenLayer Intelligent Contract running on the GenVM consensus network. It provides an on-chain batch custody registry with AI-driven recall matching and deterministic supply chain graph quarantine propagation.

---

## 1. Product Overview & Real-World Boundary

In modern manufacturing and food supply chains, product recalls require matching natural-language regulatory notices (e.g., FDA, EFSA, or internal QA alerts) against batch manufacturing metadata, followed by quarantining both the directly contaminated batches and all downstream derived products.

LotGuard brings this workflow on-chain:
1. **Producer** registers production batches with immutable attributes (product category, facility, ISO production date) and parent ingredient dependencies.
2. **Current Custodian** can transfer on-chain registry custody of non-quarantined batches.
3. **Recall Authority** submits a natural-language recall notice.
4. **GenLayer Validators** execute semantic evaluation inside GenVM consensus (`exec_prompt`) to identify the canonical set of directly affected registered batch IDs.
5. **Deterministic Code** traverses the immutable batch graph to quarantine direct matches and every downstream descendant. Quarantined batches cannot be transferred.
6. **Recall Authority** can retract notices with an audit reason, immediately recomputing effective quarantine from remaining active notices.

> **CRITICAL REAL-WORLD BOUNDARY DISCLAIMER**  
> LotGuard tracks and enforces **purely on-chain registry custody and status records**. It does not control physical goods in warehouses, cannot independently authenticate physical factory operations, and consensus cannot prove real-world ground truth beyond validating the submitted data.

---

## 2. Architecture & State Model

```
+-----------------------------------------------------------------------------------+
|                                 LotGuard Contract                                 |
+-----------------------------------------------------------------------------------+
|  Roles:                                                                           |
|    - Producer: Fixed Address (registers batches)                                  |
|    - Recall Authority: Fixed Address (issues & retracts notices)                  |
|                                                                                   |
|  Immutable Batch Dependency Graph (Acyclic DAG):                                  |
|    - Registered in topological parent-before-child order                          |
|    - Maximum 12 batches lifetime                                                  |
|    - At most 3 parents per batch                                                  |
|    - Cyclic dependencies mathematically impossible                                |
|                                                                                   |
|  GenVM Consensus Layer:                                                           |
|    - Leader: executes LLM prompt against registered batch catalog                 |
|    - Validator: independently reruns evaluation and verifies exact result match   |
|    - Strict Canonical Output: {"status": "AFFECTED"|"UNCLEAR",                    |
|                                "affected_batch_ids": ["ID1", ...]}                |
|                                                                                   |
|  Deterministic Quarantine Engine:                                                 |
|    - Effective Quarantine = Union of descendants of all ACTIVE notice roots       |
|    - Transfer method rejects custody change for any quarantined batch             |
+-----------------------------------------------------------------------------------+
```

### The Five-Batch Supply Chain Architecture

| Batch ID | Product | Facility | Production Date | Parents | Initial Custodian | Post-Transfer Custodian |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **FLOUR-A** | flour | Pune plant | `2026-10-03` | `[]` | Acc1 (`0x74e8...`) | Acc1 (`0x74e8...`) |
| **FLOUR-B** | flour | Mumbai plant | `2026-10-03` | `[]` | Acc1 (`0x74e8...`) | Acc2 (`0xac34...`) *(Transferred Step 2)* |
| **SNACK-A** | snack | Pune packaging | `2026-10-05` | `["FLOUR-A"]` | Acc1 (`0x74e8...`) | Acc1 (`0x74e8...`) |
| **SNACK-B** | snack | Mumbai packaging | `2026-10-05` | `["FLOUR-B"]` | Acc1 (`0x74e8...`) | Acc1 (`0x74e8...`) |
| **COMBO** | snack combo | Pune packaging | `2026-10-06` | `["FLOUR-A", "FLOUR-B"]` | Acc1 (`0x74e8...`) | Acc2 (`0xac34...`) *(Transferred Step 8)* |

*All five batches are initially registered by Producer Acc1 (`0x74e8338F52617cBF3e4A2Aaa92ddA6665Ec4991F`) with Acc1 as initial custodian. In Step 2 of the live demonstration, `FLOUR-B` is transferred to Acc2 (`0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634`).*

When the Recall Authority submits Notice 0 (Pune Notice):
> *"Recall flour produced at the Pune plant from October 1 through October 4, 2026."*

1. **AI Consensus**: Validators agree that **`FLOUR-A`** is the only **DIRECT** match root.
2. **On-Chain Propagation**: Contract code automatically traces the dependency graph and quarantines **`FLOUR-A`**, **`SNACK-A`** (descendant of `FLOUR-A`), and **`COMBO`** (descendant of `FLOUR-A` and `FLOUR-B`).
3. **Registry Enforcement**:
   - Transfers of quarantined batches (`COMBO`) fail execution with `FINISHED_WITH_ERROR` and preserve unchanged custody.
   - `FLOUR-B` and `SNACK-B` remain unquarantined and fully transferable.

---

## 3. Consensus Boundaries & Adversarial Prompt Handling

### GenLayer Network Consensus Mechanics

In the live GenLayer network:
1. **Validator Committee & Majority Voting**: Intelligent contracts execute non-deterministic calls using a distributed committee of validators. Transactions are accepted or rejected based on validator majority agreement (BFT consensus). A single dissenting validator does not necessarily block a result if the required majority of validators agree on the output.
2. **Leader Rotation & Undetermined Transactions**: If validators fail to reach majority consensus, or if leader proposals diverge without consensus agreement, the network may rotate leaders, or mark the transaction as `UNDETERMINED`.
3. **Zero State Mutation on Non-Consensus**: When network consensus fails or a transaction is marked `UNDETERMINED`, the transaction does **not** change contract storage. State is committed only upon reaching consensus agreement. Disagreement on the network does not always manifest as an EVM-style VM "revert"; it can terminate as `UNDETERMINED` or trigger leader rotation without mutating state.

---

### What Direct Mode Can and Cannot Prove About Network Consensus

#### What Direct Mode Proves:
1. **Deterministic Logic**: The smart contract code, state transition logic, graph reachability algorithms, and data structures execute deterministically within the GenVM Python runtime.
2. **Validator Comparison Logic**: The contract's `validator_fn` correctly receives the leader proposal wrapped in `gl.vm.Return(result)`, computes its own independent sanitized result, and verifies equivalence (`leader_san == validator_san`).
3. **Simulated Rejection on Disagreement**: Direct mode tests the adapter-level simulated rejection: when the test harness supplies conflicting leader and validator outputs (e.g., leader emits `["FLOUR-A"]` while validator emits `["FLOUR-B"]`), the test adapter catches the divergence and verifies that the transaction halts without changing contract state.
4. **Consensus Agreement Handling**: When both simulated nodes independently compute matching results, consensus succeeds, the notice is issued, and descendants are quarantined.
5. **Deterministic Schema Sanitization**: Rejects non-dict returns, missing fields, unrecognized keys, duplicate IDs, unregistered IDs, and unsorted ID arrays.

#### What Direct Mode CANNOT Prove:
1. **Distributed BFT P2P Consensus**: Direct mode runs sequentially in a single Python process on one machine. It does **not** simulate network latency, p2p gossip message propagation, validator node discovery, or Byzantine fault-tolerant quorum threshold voting among decentralized peers.
2. **Committee Sampling, Leader Rotation & Slashing**: It cannot simulate validator committee sampling, stake-weighted voting, leader rotation, or validator slashing for misbehavior.
3. **Live LLM Stochasticity**: Direct mode uses pre-defined or mock LLM strings. It cannot prove that decentralized, physically distinct LLM inference engines with varying tokenization or temperature seeds will produce identical strings on real-world edge cases.

---

### Adversarial Prompt Handling & Honest Security Boundaries

#### 1. Isolation of Untrusted Input
The natural-language recall notice and batch catalog are treated strictly as **untrusted data**, isolated in dedicated XML tags within the system prompt:
```xml
<registered_batches_catalog>
[JSON Catalog of Registered Batches]
</registered_batches_catalog>

<recall_notice_data>
[Raw Recall Notice Text]
</recall_notice_data>
```
The prompt explicitly instructs validators to evaluate only the factual statements in `<recall_notice_data>` and ignore any meta-instructions, role-play attempts, or system overrides embedded in the notice text.

#### 2. Strict Schema Sanitization (Defense-in-Depth)
The contract strictly enforces an exact 2-key schema on the evaluation output:
```json
{
  "status": "AFFECTED",
  "affected_batch_ids": ["FLOUR-A"]
}
```
or
```json
{
  "status": "UNCLEAR",
  "affected_batch_ids": []
}
```
`_sanitize_evaluation_result` deterministically rejects:
- **Extra keys**: Injections attempting to append keys such as `{"override": true}`, `{"payout": 100}`, or `{"notes": "..."}` revert immediately.
- **Unregistered batch IDs**: Injections attempting to target non-existent or fictitious IDs (e.g., `["HACKED-BATCH-999"]`) revert immediately.
- **Malformed types**: IDs that are not strings or statuses that are not `"AFFECTED"` or `"UNCLEAR"` revert immediately.
- **Duplicate or unsorted IDs**: Reverts to prevent non-canonical representation.
- **Suppression Attacks**: If an adversary's prompt forces the status to `"UNCLEAR"`, the contract halts without modifying any registry state.

#### 3. Multi-Validator Consensus Defense
If an adversary submits a prompt injection that persuades one validator node to output a maliciously altered batch list (e.g. including an unaffected Mumbai batch `FLOUR-B`), but other honest validators adhere to system instructions and emit only `FLOUR-A`, the divergence prevents an attacker from unilaterally dictating consensus. If no consensus agreement is reached, the transaction fails or remains `UNDETERMINED` without mutating registry state.

#### 4. Honest Limitation: Universal LLM Jailbreaks & Agreed False Positives
> [!WARNING]
> **CRITICAL SECURITY LIMITATION**  
> Schema checks and consensus verification **DO NOT** guarantee that a valid but maliciously influenced batch ID will be rejected if **all** consensus validators are simultaneously tricked.
> 
> If an adversarial prompt successfully convinces the entire validator committee (both leader and validators) to agree on a valid registered batch ID (for instance, convincing all models that an innocent competitor's batch is affected), consensus will accept the output because the validator majority reached agreement on a syntactically valid ID.
> 
> **Consensus can only prove that validators agreed on the submitted data; it cannot independently establish physical ground truth or defeat unanimous semantic manipulation.**
> 
> To mitigate this real-world boundary:
> - Only the designated, authenticated `recall_authority` can issue notices (preventing unauthorized public injection attempts).
> - The `recall_authority` has the on-chain ability to call `retract_notice(notice_id, reason)`, immediately undoing false-positive quarantines and recomputing clean registry state while preserving an immutable audit record.

---

## 4. Deterministic Propagation & Retraction

### Effective Quarantine Calculation
Quarantine status is derived dynamically from active notice roots:
$$\text{ActiveRoots} = \bigcup_{n \in \text{ActiveNotices}} \text{NoticeRoots}(n)$$

Because batches are registered in topological order (parents must exist before children), a single ordered pass over registered batches determines all descendants:
```python
quarantined = set(active_roots)
for batch_id in self.batch_ids:
    if any(parent in quarantined for parent in batch.parents):
        quarantined.add(batch_id)
```

### Overlapping Notices & Retraction
- **Overlapping Coverage**: If Batch $C$ has parents $A$ and $B$, Notice 1 covers $A$, and Notice 2 covers $B$, Batch $C$ is quarantined by both.
- **Audit-Preserving Retraction**: When Notice 1 is retracted with a reason, Notice 1 is deactivated (`active = False`), but history is preserved.
- **Persistent Coverage**: Batch $C$ **stays quarantined** as long as Notice 2 remains active.
- **Permanent Deduplication**: Duplicate notice text is permanently rejected by SHA-256 hash, even after retraction.

---

## 5. Explicit Bounds & Constants

| Limit / Parameter | Value | Enforcement |
| :--- | :--- | :--- |
| `MAX_BATCHES` | `12` | Reverts on 13th batch registration attempt |
| `MAX_PARENTS` | `3` | Reverts if child lists > 3 parents |
| `MAX_NOTICES` | `8` | Reverts on 9th recall notice attempt |
| `MAX_BATCH_ID_LEN` | `32` (ASCII letters, digits, `_`, `-`) | Regex & length check |
| `MAX_PRODUCT_LEN` | `64` | String length check (1..64) |
| `MAX_FACILITY_LEN` | `64` | String length check (1..64) |
| `DATE_FORMAT` | ISO `YYYY-MM-DD` | Calendar validation (years 2000-2099) |
| `MAX_NOTICE_TEXT_LEN`| `1000` (min 10) | Length check |
| `MAX_REASON_LEN` | `500` (min 1) | Non-empty retraction reason check |

---

## 6. Contract API Reference

### Write Methods (`@gl.public.write`)

#### `register_batch(batch_id, product, facility, production_date, initial_custodian, parent_ids_json) -> None`
- **Caller**: Only `producer`.
- **Preconditions**:
  - `batch_id` unique and bounded.
  - `production_date` valid ISO date `YYYY-MM-DD`.
  - `initial_custodian != 0x0`.
  - All `parent_ids` must already exist.
  - None of the `parent_ids` can be currently quarantined.

#### `transfer_custody(batch_id, new_custodian) -> None`
- **Caller**: Only current custodian of `batch_id`.
- **Preconditions**:
  - `new_custodian != 0x0` and `new_custodian != current_custodian`.
  - `batch_id` must **NOT** be quarantined.

#### `issue_notice(notice_text) -> str`
- **Caller**: Only `recall_authority`.
- **Action**: Runs GenVM consensus LLM evaluation. If direct matches are found, stores notice and quarantines roots + descendants.
- **Returns**: New `notice_id` string (e.g. `"0"`).

#### `retract_notice(notice_id, reason) -> None`
- **Caller**: Only `recall_authority`.
- **Preconditions**: Notice must be active and not previously retracted; `reason` non-empty.
- **Action**: Marks notice inactive, records audit reason, recomputes quarantine.

---

### View Methods (`@gl.public.view`)

- `get_roles() -> dict`: Returns `{"producer": "0x...", "recall_authority": "0x..."}`.
- `get_limits() -> dict`: Returns contract capacity and size constants.
- `get_counts() -> dict`: Returns batch count, notice count, active notice count, quarantined batch count.
- `get_all_batch_ids() -> list[str]`: Returns list of all registered batch IDs.
- `get_batch(batch_id: str) -> dict`: Returns full batch record including parent links, custodian, and quarantine status.
- `is_batch_quarantined(batch_id: str) -> bool`: Returns `True` if batch is currently quarantined.
- `get_quarantined_batch_ids() -> list[str]`: Returns sorted list of all currently quarantined batch IDs.
- `get_all_notice_ids() -> list[str]`: Returns list of all issued notice IDs.
- `get_notice(notice_id: str) -> dict`: Returns notice text, hash, direct roots, active/retracted status, and reason.

---

## 7. Testing & Verification

The test suite contains **41 comprehensive unit tests** executed in direct mode with `pytest` and `gltest`.

### Running Tests and Linter

```bash
# 1. Run TypeScript typecheck (zero errors)
npx tsc --noEmit

# 2. Run GenVM AST safety linter
npm run lint

# 3. Run all direct unit tests
npm run test:direct
```

### Test Coverage Highlights

1. **Core Four-Batch Flow**: Direct match (`FLOUR-A`) propagates quarantine to child (`SNACK-A`); `FLOUR-B` and `SNACK-B` remain unquarantined and transferable.
2. **Authority & Roles**: Rejection of zero addresses, duplicate roles, unauthorized batch registration, notice issuance, and notice retraction.
3. **Graph Integrity & Acyclicity**: Unknown parents, self-parents, duplicate parents, and registering a child of a quarantined parent are all rejected.
4. **Capacity Caps**: Enforces 12 batches, 8 notices, and 3 parents maximum.
5. **Exact Consensus Validation**: Rejects malformed JSON, missing fields, extra keys (payout bait), unregistered IDs, duplicate IDs, and unsorted IDs.
6. **Consensus Disagreement Rejection**: Verifies that when leader and validator compute conflicting batch lists (`FLOUR-A` vs `FLOUR-B`), consensus rejects the notice and preserves zero state mutation.
7. **Consensus Agreement Commitment**: Verifies that when leader and validator agree on `FLOUR-A`, consensus commits the notice and quarantines descendants.
8. **Validator Direct Boundary Checks**: Asserts `validator_fn` rejects non-Return objects and conflicting returns, and accepts matching returns.
9. **Adversarial Prompt Handling**:
   - Rejection of prompt injections attempting format override with extra keys (`override: true`).
   - Disagreement rejection when injection fools leader into adding an unaffected batch, but honest validator dissents.
   - Rejection of suppression attacks attempting to force `UNCLEAR`.
   - Rejection of fictitious un-registered batch IDs (`HACKED-BATCH-999`).
   - Documented test demonstrating that unanimous model manipulation would commit, but can be safely retracted by the recall authority.
10. **Overlapping Notices & Retraction**: Tests multi-parent children covered by multiple active notices, proving child stays quarantined until all covering notices are retracted.
11. **Zero State Mutation**: Proves that UNCLEAR evaluations, failed validations, or unauthorized calls leave contract storage completely untouched.

---

## 8. Completed Studio Next Deployment & On-Chain Canonical Verification

LotGuard was successfully deployed and verified on GenLayer Studio Next (Chain ID `61997`).

### Canonical Deployment Parameters

| Parameter | Value |
| :--- | :--- |
| **Network** | GenLayer Studio Next (`studioDevnet`) |
| **Chain ID** | `61997` (Hex: `0xf22d`) |
| **RPC Endpoint** | `https://studio-next.genlayer.com/api` |
| **Canonical Contract Address** | [`0xa153CB64dfb448b13306874FcAed385A20ec20C5`](https://explorer-studio-dev.genlayer.com/address/0xa153CB64dfb448b13306874FcAed385A20ec20C5) |
| **Deployment Transaction Hash** | [`0xb72434885b079be8739dcbc19ca1dc2c385bba885e130fc87391643317a8e29d`](https://explorer-studio-dev.genlayer.com/tx/0xb72434885b079be8739dcbc19ca1dc2c385bba885e130fc87391643317a8e29d) |
| **Transaction Status** | `FINALIZED` (`status: 7`) |
| **Execution Result** | `FINISHED_WITH_RETURN` |
| **Local Raw Source SHA-256** | `66f24b81aca07d32028898931c45b919fe3034129a8aac6bf0467e289dcd6f89` |
| **On-Chain Source SHA-256** | `66f24b81aca07d32028898931c45b919fe3034129a8aac6bf0467e289dcd6f89` |
| **Exact Byte Match** | `PASSED` (`deployedCode === rawFileText`) |
| **Producer Address (Acc1)** | `0x74e8338F52617cBF3e4A2Aaa92ddA6665Ec4991F` |
| **Recall Authority Address (Acc2)**| `0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634` |
| **Deployment Evidence** | [`deploy-result.json`](./deploy-result.json) |
| **Live Demonstration Evidence** | [`live-demo-evidence.json`](./live-demo-evidence.json) |

### Verification Script & Read-Only Results (`deploy/verify_onchain.ts`)

The automated read-only verification script queries the deployed contract on Studio Next and asserts exact source equality, roles, limits, counts, notice roots, and batch custody:

```bash
# Run read-only on-chain verification
npm run verify:onchain
```

**Observed Verification Output:**
- **Source Verification**: Deployed source code fetched via `getContractCode` matches raw local `contracts/lotguard.py` byte-for-byte (`66f24b81aca07d32028898931c45b919fe3034129a8aac6bf0467e289dcd6f89`). Exact byte match: `PASSED`.
- **Roles**: `producer` is `0x74e8338F52617cBF3e4A2Aaa92ddA6665Ec4991F` (Acc1) and `recall_authority` is `0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634` (Acc2).
- **Limits**: `max_batches=12`, `max_notices=8`, `max_parents=3`, `max_batch_id_len=32`, `max_product_len=64`, `max_facility_len=64`, `max_notice_text_len=1000`, `max_reason_len=500`.
- **Counts**: `batch_count=5`, `notice_count=2`, `active_notice_count=0`, `quarantined_batch_count=0`.
- **Notice 0 (Pune Notice)**: direct root `["FLOUR-A"]`, `active=false`, `retracted=true`, reason `"Pune flour cleared after laboratory testing"`.
- **Notice 1 (Mumbai Notice)**: direct root `["FLOUR-B"]`, `active=false`, `retracted=true`, reason `"Mumbai flour cleared after inspection"`.
- **Batch COMBO**: custodian `0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634` (Acc2), `is_quarantined=false`.
- **Quarantined Batch IDs**: empty list `[]`.

---

## 9. Completed Live Demonstration Results (8 On-Chain Scenarios)

The live demonstration executed the full 8-scenario supply chain lifecycle on Studio Next. All transactions were finalized on-chain and recorded in [`live-demo-evidence.json`](./live-demo-evidence.json).

### Scenario 1: Batch Registration (5 Batches in Topological Order)
Producer Acc1 (`0x74e8...`) registered 5 batches with Acc1 as initial custodian:
- `FLOUR-A`: parents `[]`, TX `0x4383626cd3611fbf456df759b717cdd66f1efa4477ef1eba1f8e192778db741c` (`FINALIZED`, `FINISHED_WITH_RETURN`)
- `FLOUR-B`: parents `[]`, TX `0xcbb4166c2fc57a021202e43f7455023d71b80440320e7a25ee810c8f2bd6f742` (`FINALIZED`, `FINISHED_WITH_RETURN`)
- `SNACK-A`: parents `["FLOUR-A"]`, TX `0x7e07a1ed0aeee1b68001492fac1e99bebf45c11904097a3c49beb4c9feba272e` (`FINALIZED`, `FINISHED_WITH_RETURN`)
- `SNACK-B`: parents `["FLOUR-B"]`, TX `0x391613910c81ab613f6a8670bf9c325900110bc0c356b51af871ebf303a3388c` (`FINALIZED`, `FINISHED_WITH_RETURN`)
- `COMBO`: parents `["FLOUR-A", "FLOUR-B"]`, TX `0x68933ff130ae5877ba3ff1f86e1a7a9073e9b572a08d899b2b825f6dbc1bdfe5` (`FINALIZED`, `FINISHED_WITH_RETURN`)

*On-chain check: `get_all_batch_ids` returned all 5 registered IDs; all initial custodians set to Acc1.*

### Scenario 2: Unaffected Custody Transfer (Normal Operations)
Acc1 transferred unquarantined batch `FLOUR-B` to Acc2 (`0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634`).
- **TX Hash**: `0x638e8c9090f8c9292fc00f4fe6ec9b4583c4cffa958718b15c5dc976a990fa48`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_RETURN`
- **Observed State**: `FLOUR-B` custodian on-chain updated to `0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634`.

### Scenario 3: Issue Notice 0 (Pune Notice) & Descendant Quarantine
Recall Authority Acc2 submitted natural-language notice:
> *"Recall flour produced at the Pune plant from October 1 through October 4, 2026."*
- **TX Hash**: `0x268e35ee46bf8310d00bd25d0c05ded8a8f41432792fc427847cfee41ecbc8cc`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_RETURN`
- **AI Consensus Direct Match**: `["FLOUR-A"]`
- **Observed State**: `get_quarantined_batch_ids` returned `["COMBO", "FLOUR-A", "SNACK-A"]`. `FLOUR-B` and `SNACK-B` remained clear.

### Scenario 4: Blocked Custody Transfer 1 on Quarantined COMBO
Acc1 attempted to transfer quarantined batch `COMBO` to Acc2.
- **TX Hash**: `0x2eb8db92af6d9174604560235f13f735f898c0ee2e39916c0dfb95bfcbe9f24c`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_ERROR`
- **Observed State**: Execution failed; on-chain custodian for `COMBO` remained unchanged as Acc1 (`0x74e8338F52617cBF3e4A2Aaa92ddA6665Ec4991F`).

### Scenario 5: Issue Notice 1 (Mumbai Notice) & Dual Active Quarantine
Recall Authority Acc2 submitted natural-language notice:
> *"Recall flour produced at the Mumbai plant from October 1 through October 4, 2026."*
- **TX Hash**: `0xecc218d0ed1a4a4ce67ca0a06770028ff7124d961064a9816c5cd755272520b3`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_RETURN`
- **AI Consensus Direct Match**: `["FLOUR-B"]`
- **Observed State**: `get_quarantined_batch_ids` returned all 5 batches `["COMBO", "FLOUR-A", "FLOUR-B", "SNACK-A", "SNACK-B"]`. `COMBO` is covered by both Notice 0 and Notice 1.

### Scenario 6: Retract Notice 0 (Pune Notice) & Persistent COMBO Quarantine
Recall Authority Acc2 retracted Notice 0 with reason `"Pune flour cleared after laboratory testing"`.
- **TX Hash**: `0x95e9c9eeff3ee4a3894fab37486915823cef061b0e229b6cb30df950f71cd627`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_RETURN`
- **Observed State**: `FLOUR-A` and `SNACK-A` cleared of quarantine. `FLOUR-B`, `SNACK-B`, and `COMBO` remain quarantined due to active Notice 1.
- **Blocked Transfer 2 on COMBO**:
  - Acc1 attempted to transfer `COMBO` while still covered by Notice 1.
  - **TX Hash**: `0xaf6120f3177ab5a5ef7a8122eb24e1f2d74a716240532a2cb499002b21ef7439`
  - **Receipt**: `FINALIZED`, `FINISHED_WITH_ERROR`
  - **Observed State**: Execution failed; custodian remained unchanged as Acc1.

### Scenario 7: Retract Notice 1 (Mumbai Notice) & Full Quarantine Clearance
Recall Authority Acc2 retracted Notice 1 with reason `"Mumbai flour cleared after inspection"`.
- **TX Hash**: `0xb3398345ec7e1bbb9e1c8413467b1cb665bb2781a522df73739d5692cab32a6f`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_RETURN`
- **Observed State**: `get_quarantined_batch_ids` returned `[]` (`quarantined_batch_count: 0`). All batches clear.

### Scenario 8: Transfer COMBO Post-Clearance
With all recall notices retracted, Acc1 transferred `COMBO` to Acc2 (`0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634`).
- **TX Hash**: `0xe4bb1df2c4233bee080a963287fb4b86d9363fb17e3c74328b2d66af4b46e94c`
- **Receipt**: `FINALIZED`, `FINISHED_WITH_RETURN`
- **Observed State**: `COMBO` custodian successfully updated to `0xac344A9aB8808d6fcfF1f8D18F794C3b24FE2634`.

---

## 10. Repository Structure & Publication Manifest

The repository contains exactly **20 clean, publication-ready files**. Bulky artifacts (`artifacts/`), virtual environments, secrets (`.env`), and caches (`node_modules/`, `.pytest_cache/`, `__pycache__/`) are excluded by [`.gitignore`](./.gitignore).

```
LotGuard/
├── .env.example
├── .gitignore
├── gltest.config.yaml
├── package.json
├── package-lock.json
├── pytest.ini
├── README.md
├── requirements.txt
├── tsconfig.json
├── deploy-result.json
├── live-demo-evidence.json
├── contracts/
│   └── lotguard.py
├── deploy/
│   ├── deployScript.ts
│   ├── run_live_demo.ts
│   └── verify_onchain.ts
└── tests/
    ├── __init__.py
    └── direct/
        ├── __init__.py
        ├── conftest.py
        ├── helpers.py
        └── test_lotguard.py
```

