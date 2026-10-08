import os
import time
import uuid
import threading
from enum import Enum
from pathlib import Path
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Dict, Any, List, Optional, Callable

class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class TaskStage(str, Enum):
    QUEUED = "queued"
    PREPARING = "preparing"
    EXTRACTING = "extracting_volume"
    ANATOMICAL_MASKING = "anatomical_masking"
    SEGMENTING = "inference_segmentation"
    RECIST_CALCULATION = "recist_calculation"
    RENDERING = "rendering_publication_slice"
    COMPLETED = "completed"
    FAILED = "failed"

@dataclass
class AsyncTask:
    task_id: str
    status: TaskStatus
    stage: TaskStage
    progress_pct: int
    created_at: float
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    duration_sec: Optional[float] = None
    model_name: str = "lung_nodule_segmenter"
    input_source: str = "volume"
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

class TaskManager:
    def __init__(self, max_workers: int = 2):
        self.lock = threading.Lock()
        self.tasks: Dict[str, AsyncTask] = {}
        self.futures: Dict[str, Future] = {}
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="HeurionImagingWorker")

    def submit_task(
        self,
        runner_fn: Callable[..., Dict[str, Any]],
        model_name: str,
        input_source: str,
        *args,
        **kwargs
    ) -> AsyncTask:
        task_id = f"task_{int(time.time())}_{uuid.uuid4().hex[:8]}"
        task = AsyncTask(
            task_id=task_id,
            status=TaskStatus.QUEUED,
            stage=TaskStage.QUEUED,
            progress_pct=0,
            created_at=time.time(),
            model_name=model_name,
            input_source=input_source
        )

        with self.lock:
            self._prune_expired_tasks()
            self.tasks[task_id] = task

        def _worker_wrapper():
            with self.lock:
                task.status = TaskStatus.RUNNING
                task.stage = TaskStage.PREPARING
                task.started_at = time.time()
                task.progress_pct = 10

            def progress_callback(stage: TaskStage, pct: int):
                with self.lock:
                    task.stage = stage
                    task.progress_pct = min(max(pct, 0), 99)

            try:
                # Execute user inference function with optional progress callback
                if "progress_cb" in kwargs or any(p in kwargs for p in ("progress_callback", "cb")):
                    res = runner_fn(*args, **kwargs)
                else:
                    try:
                        res = runner_fn(*args, progress_cb=progress_callback, **kwargs)
                    except TypeError:
                        res = runner_fn(*args, **kwargs)

                with self.lock:
                    task.status = TaskStatus.COMPLETED
                    task.stage = TaskStage.COMPLETED
                    task.progress_pct = 100
                    task.completed_at = time.time()
                    task.duration_sec = round(task.completed_at - (task.started_at or task.created_at), 3)
                    task.result = res
            except Exception as exc:
                with self.lock:
                    task.status = TaskStatus.FAILED
                    task.stage = TaskStage.FAILED
                    task.completed_at = time.time()
                    task.duration_sec = round(task.completed_at - (task.started_at or task.created_at), 3)
                    task.error = str(exc)

        future = self.executor.submit(_worker_wrapper)
        with self.lock:
            self.futures[task_id] = future

        return task

    def update_progress(self, task_id: str, stage: TaskStage, progress_pct: int):
        with self.lock:
            task = self.tasks.get(task_id)
            if task and task.status == TaskStatus.RUNNING:
                task.stage = stage
                task.progress_pct = min(max(progress_pct, 0), 99)

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            task = self.tasks.get(task_id)
            if not task:
                return None
            res = asdict(task)
            res["status"] = task.status.value
            res["stage"] = task.stage.value
            if task.started_at and task.status == TaskStatus.RUNNING:
                res["elapsed_sec"] = round(time.time() - task.started_at, 2)
            return res

    def list_tasks(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.lock:
            sorted_tasks = sorted(self.tasks.values(), key=lambda t: t.created_at, reverse=True)[:limit]
            results = []
            for t in sorted_tasks:
                d = asdict(t)
                d["status"] = t.status.value
                d["stage"] = t.stage.value
                results.append(d)
            return results

    def cancel_task(self, task_id: str) -> bool:
        with self.lock:
            task = self.tasks.get(task_id)
            future = self.futures.get(task_id)
            if not task:
                return False
            if task.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
                return False

            if future and future.cancel():
                task.status = TaskStatus.CANCELLED
                task.stage = TaskStage.FAILED
                task.error = "Task cancelled by client"
                return True
            else:
                task.status = TaskStatus.CANCELLED
                task.stage = TaskStage.FAILED
                task.error = "Task marked for cancellation"
                return True

    def _prune_expired_tasks(self, ttl_seconds: int = 7200):
        """Removes completed or failed tasks older than TTL."""
        now = time.time()
        to_del = [
            tid for tid, t in self.tasks.items()
            if t.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED)
            and (now - t.created_at) > ttl_seconds
        ]
        for tid in to_del:
            self.tasks.pop(tid, None)
            self.futures.pop(tid, None)

# Global singleton task manager for the imaging worker process
task_manager = TaskManager(max_workers=int(os.environ.get("IMAGING_CONCURRENCY", "2")))
