# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.flow_progress_store import FlowProgressStore


@pytest.fixture()
def store(tmp_path):
    return FlowProgressStore(str(tmp_path / "flows"))


def test_start_record_finish_and_reset(store):
    progress = store.start("p1", "r1")
    assert progress["status"] == "running"
    assert progress["current_step"] == 0
    progress = store.record_step("p1", "r1", 1, "running")
    assert progress["current_step"] == 1
    progress = store.record_step("p1", "r1", 1, "done", output={"a": 1})
    assert progress["completed_steps"] == [1]
    progress = store.finish("p1", "r1", "done")
    assert progress["status"] == "done"
    reset = store.reset("p1", "r1")
    assert reset["status"] == "idle"
    assert reset["completed_steps"] == []


def test_roles_are_isolated(store):
    store.start("p1", "r1")
    store.start("p1", "r2")
    store.record_step("p1", "r1", 1, "done", output={"role": "r1"})
    assert store.get("p1", "r2")["completed_steps"] == []
    assert store.get("p1", "r1")["completed_steps"] == [1]


def test_same_role_lock_conflict(store):
    lock = store.lock("p1", "r1")
    assert lock.try_acquire() is True
    try:
        second = store.lock("p1", "r1")
        assert second.try_acquire() is False
    finally:
        lock.release()
