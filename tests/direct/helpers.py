"""Shared helper functions for LotGuard direct unit tests."""

from __future__ import annotations

import json

CONTRACT_PATH = "contracts/lotguard.py"

PRODUCER = "0x1111111111111111111111111111111111111111"
RECALL_AUTHORITY = "0x2222222222222222222222222222222222222222"
CUSTODIAN_1 = "0x3333333333333333333333333333333333333333"
CUSTODIAN_2 = "0x4444444444444444444444444444444444444444"
CUSTODIAN_3 = "0x5555555555555555555555555555555555555555"
STRANGER = "0x9999999999999999999999999999999999999999"
ZERO = "0x0000000000000000000000000000000000000000"


def deploy(
    direct_vm,
    direct_deploy,
    producer: str = PRODUCER,
    recall_authority: str = RECALL_AUTHORITY,
):
    direct_vm.sender = producer
    return direct_deploy(CONTRACT_PATH, producer, recall_authority)


def register_batch(
    direct_vm,
    contract,
    batch_id: str,
    product: str,
    facility: str,
    production_date: str,
    initial_custodian: str = CUSTODIAN_1,
    parents: list[str] | None = None,
    sender: str = PRODUCER,
):
    direct_vm.sender = sender
    parent_ids_json = json.dumps(parents or [])
    contract.register_batch(
        batch_id,
        product,
        facility,
        production_date,
        initial_custodian,
        parent_ids_json,
    )


def mock_evaluation(direct_vm, payload):
    if hasattr(direct_vm, "clear_mocks"):
        direct_vm.clear_mocks()
    direct_vm._llm_mock_sequence = None
    if isinstance(payload, str):
        body = payload
    else:
        body = json.dumps(payload)
    direct_vm.mock_llm(r".*", body)


def mock_evaluation_sequence(direct_vm, payloads: list):
    if hasattr(direct_vm, "clear_mocks"):
        direct_vm.clear_mocks()
    seq = []
    for p in payloads:
        if isinstance(p, str):
            seq.append(p)
        else:
            seq.append(json.dumps(p))
    direct_vm._llm_mock_sequence = seq


def issue_notice(
    direct_vm,
    contract,
    notice_text: str,
    sender: str = RECALL_AUTHORITY,
) -> str:
    direct_vm.sender = sender
    return contract.issue_notice(notice_text)


def retract_notice(
    direct_vm,
    contract,
    notice_id: str,
    reason: str,
    sender: str = RECALL_AUTHORITY,
):
    direct_vm.sender = sender
    contract.retract_notice(notice_id, reason)


def transfer_custody(
    direct_vm,
    contract,
    batch_id: str,
    new_custodian: str,
    sender: str = CUSTODIAN_1,
):
    direct_vm.sender = sender
    contract.transfer_custody(batch_id, new_custodian)
