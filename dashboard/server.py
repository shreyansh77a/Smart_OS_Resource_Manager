import os
import sys
import time
import json
import signal
import asyncio
import re
from pathlib import Path
from typing import Dict, Any, List, Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Base directories
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# Read PROJECT_DIR from environment or default to parent folder
project_dir_env = os.environ.get("PROJECT_DIR")
if project_dir_env:
    PROJECT_DIR = Path(project_dir_env).resolve()
else:
    PROJECT_DIR = BASE_DIR.parent

STATE_FILE = PROJECT_DIR / "state.json"
LOG_FILE = PROJECT_DIR / "manager.log"
CONF_FILE = PROJECT_DIR / "manager.conf"

# Mock Mode flag (active if MOCK=1 or automatically on Windows when state.json is absent)
mock_env = os.environ.get("MOCK")
if mock_env is not None:
    MOCK_MODE = mock_env == "1"
else:
    MOCK_MODE = sys.platform == "win32" and not STATE_FILE.is_file()

# Safe signal definitions for cross-platform support
SIGUSR1 = getattr(signal, "SIGUSR1", None)
SIGKILL = getattr(signal, "SIGKILL", getattr(signal, "SIGTERM", 9))

DEFAULT_CONFIG: Dict[str, Any] = {
    "dry_run": 0,
    "cpu_limit": 70.0,
    "mem_limit_mb": 500.0,
    "t_renice": 5,
    "t_kill": 10,
    "leak_secs": 10,
    "nice_value": 10,
    "grace_cycles": 3,
    "table_rows": 10,
    "protected": "systemd, init, sshd, bash, zsh, sh, node, MainThread, SessionLeader",
}

# ---------------------------------------------------------------------------
# Mock Simulator
# ---------------------------------------------------------------------------
class MockSimulator:
    def __init__(self):
        self.start_time = time.time()
        self.epoch = int(self.start_time)
        self.uptime_sec = 0
        self.config = dict(DEFAULT_CONFIG)
        self.totals = {"warn": 1, "renice": 1, "pause": 0, "kill": 1}
        self.events: List[Dict[str, str]] = [
            {
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "level": "INFO",
                "message": "smart_rm initialized (MOCK mode active)",
            },
            {
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "level": "CONFIG",
                "message": "Loaded rules from manager.conf",
            },
        ]
        self.log_lines: List[str] = [
            f"{self.events[0]['time']} [INFO] {self.events[0]['message']}",
            f"{self.events[1]['time']} [CONFIG] {self.events[1]['message']}",
        ]
        # Active simulated processes: pid -> dict
        self.simulated_processes: Dict[int, Dict[str, Any]] = {}
        self.next_pid = 2500
        self.demo_tasks: Dict[str, int] = {}  # kind -> pid

    def add_event(self, level: str, message: str):
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        event = {"time": now_str, "level": level, "message": message}
        self.events.append(event)
        if len(self.events) > 30:
            self.events.pop(0)
        self.log_lines.append(f"{now_str} [{level}] {message}")
        if len(self.log_lines) > 500:
            self.log_lines.pop(0)

    def start_demo(self, kind: str) -> int:
        pid = self.next_pid
        self.next_pid += 1

        if kind == "cpu":
            self.simulated_processes[pid] = {
                "pid": pid,
                "name": "yes",
                "kind": "cpu",
                "state": "R",
                "nice": 0,
                "cpu_pct": 99.6,
                "mem_mb": 1.4,
                "status": "ok",
                "elapsed": 0,
            }
            self.add_event("INFO", f"Demo process started: pid={pid} (yes)")
        elif kind == "leak":
            self.simulated_processes[pid] = {
                "pid": pid,
                "name": "leak",
                "kind": "leak",
                "state": "R",
                "nice": 0,
                "cpu_pct": 14.5,
                "mem_mb": 110.0,
                "status": "ok",
                "elapsed": 0,
            }
            self.add_event("INFO", f"Demo process started: pid={pid} (leak)")
        elif kind == "stubborn":
            self.simulated_processes[pid] = {
                "pid": pid,
                "name": "stubborn",
                "kind": "stubborn",
                "state": "R",
                "nice": 0,
                "cpu_pct": 98.4,
                "mem_mb": 4.2,
                "status": "ok",
                "elapsed": 0,
                "term_attempted": False,
            }
            self.add_event("INFO", f"Demo process started: pid={pid} (stubborn)")
        else:
            raise ValueError(f"Unknown kind {kind}")

        self.demo_tasks[kind] = pid
        return pid

    def stop_all_demos(self) -> int:
        count = len(self.simulated_processes)
        for pid, proc in list(self.simulated_processes.items()):
            self.add_event("INFO", f"Manual demo stop: terminated pid={pid} ({proc['name']})")
        self.simulated_processes.clear()
        self.demo_tasks.clear()
        return count

    def tick(self):
        self.uptime_sec += 1
        now = datetime.now()
        self.epoch = int(now.timestamp())

        # Update simulated demo processes
        dry_run = bool(self.config.get("dry_run", 0))
        t_renice = int(self.config.get("t_renice", 5))
        t_kill = int(self.config.get("t_kill", 10))
        leak_secs = int(self.config.get("leak_secs", 10))
        target_nice = int(self.config.get("nice_value", 10))
        mem_limit = float(self.config.get("mem_limit_mb", 500.0))

        to_delete = []

        for pid, proc in list(self.simulated_processes.items()):
            proc["elapsed"] += 1
            elapsed = proc["elapsed"]
            kind = proc.get("kind")

            if kind == "cpu":
                if elapsed >= 1 and elapsed < t_renice:
                    if proc["status"] != "warned":
                        proc["status"] = "warned"
                        self.totals["warn"] += 1
                        self.add_event("WARN", f"pid={pid} (yes): CPU {proc['cpu_pct']:.1f}% exceeds threshold -> warning issued")
                elif elapsed >= t_renice and elapsed < t_kill:
                    if proc["status"] != "reniced":
                        proc["status"] = "reniced"
                        proc["nice"] = target_nice
                        self.totals["renice"] += 1
                        act = "dry-run: would renice" if dry_run else f"reniced to {target_nice}"
                        self.add_event("RENICE", f"pid={pid} (yes): high CPU sustained for {t_renice}s -> {act}")
                elif elapsed >= t_kill:
                    if proc["status"] != "killed":
                        proc["status"] = "killed"
                        proc["state"] = "Z"
                        proc["cpu_pct"] = 0.0
                        self.totals["kill"] += 1
                        act = "dry-run: would send SIGTERM" if dry_run else "sent SIGTERM (process terminated)"
                        self.add_event("KILL", f"pid={pid} (yes): CPU hog over {t_kill}s limit -> {act}")
                if elapsed > t_kill + 1:
                    to_delete.append(pid)

            elif kind == "leak":
                if proc["state"] != "T":
                    proc["mem_mb"] += 65.0
                    proc["cpu_pct"] = max(5.0, round(12.0 + (elapsed % 3), 1))
                    if proc["mem_mb"] >= mem_limit or elapsed >= leak_secs:
                        if proc["status"] != "paused":
                            proc["status"] = "paused"
                            proc["state"] = "T"
                            proc["cpu_pct"] = 0.0
                            self.totals["pause"] += 1
                            act = "dry-run: would pause" if dry_run else "paused via SIGSTOP"
                            self.add_event("PAUSE", f"pid={pid} (leak): rapid memory growth ({proc['mem_mb']:.1f} MB) -> {act}")
                    elif proc["mem_mb"] > (mem_limit * 0.7) and proc["status"] == "ok":
                        proc["status"] = "warned"
                        self.totals["warn"] += 1
                        self.add_event("WARN", f"pid={pid} (leak): memory reached {proc['mem_mb']:.1f} MB -> warning issued")

            elif kind == "stubborn":
                if elapsed >= 1 and elapsed < t_renice:
                    if proc["status"] != "warned":
                        proc["status"] = "warned"
                        self.totals["warn"] += 1
                        self.add_event("WARN", f"pid={pid} (stubborn): high CPU usage detected")
                elif elapsed >= t_renice and elapsed < t_kill:
                    if proc["status"] != "reniced":
                        proc["status"] = "reniced"
                        proc["nice"] = target_nice
                        self.totals["renice"] += 1
                        act = "dry-run: would renice" if dry_run else f"reniced to {target_nice}"
                        self.add_event("RENICE", f"pid={pid} (stubborn): CPU sustained -> {act}")
                elif elapsed >= t_kill and not proc.get("term_attempted"):
                    proc["term_attempted"] = True
                    act = "dry-run: would send SIGTERM" if dry_run else "sent SIGTERM (ignored by process)"
                    self.add_event("KILL", f"pid={pid} (stubborn): CPU hog sustained -> {act}")
                elif elapsed >= t_kill + int(self.config.get("grace_cycles", 3)):
                    if proc["status"] != "killed":
                        proc["status"] = "killed"
                        proc["state"] = "Z"
                        proc["cpu_pct"] = 0.0
                        self.totals["kill"] += 1
                        act = "dry-run: would send SIGKILL" if dry_run else "SIGTERM ignored -> escalated to SIGKILL (KILL-9)"
                        self.add_event("KILL-9", f"pid={pid} (stubborn): {act}")
                if elapsed > t_kill + int(self.config.get("grace_cycles", 3)) + 1:
                    to_delete.append(pid)

        for pid in to_delete:
            if pid in self.simulated_processes:
                del self.simulated_processes[pid]
            for k, p in list(self.demo_tasks.items()):
                if p == pid:
                    del self.demo_tasks[k]

    def get_state(self) -> Dict[str, Any]:
        self.tick()
        now = datetime.now()
        timestamp = now.strftime("%Y-%m-%dT%H:%M:%S")

        # Standard baseline processes
        base_processes = [
            {"pid": 1, "name": "systemd", "state": "S", "nice": 0, "cpu_pct": 0.1, "mem_mb": 15.4, "status": "protected"},
            {"pid": 412, "name": "sshd", "state": "S", "nice": 0, "cpu_pct": 0.0, "mem_mb": 9.2, "status": "protected"},
            {"pid": 605, "name": "bash", "state": "S", "nice": 0, "cpu_pct": 0.3, "mem_mb": 8.1, "status": "protected"},
            {"pid": 980, "name": "node", "state": "S", "nice": 0, "cpu_pct": 1.8, "mem_mb": 142.0, "status": "protected"},
            {"pid": 1042, "name": "smart_rm", "state": "S", "nice": -5, "cpu_pct": 0.8, "mem_mb": 18.5, "status": "protected"},
            {"pid": 1184, "name": "python3", "state": "S", "nice": 0, "cpu_pct": 2.4, "mem_mb": 64.0, "status": "ok"},
            {"pid": 1290, "name": "code-server", "state": "S", "nice": 0, "cpu_pct": 3.1, "mem_mb": 185.0, "status": "protected"},
            {"pid": 1410, "name": "dbus-daemon", "state": "S", "nice": -2, "cpu_pct": 0.1, "mem_mb": 7.6, "status": "ok"},
            {"pid": 1533, "name": "rsyslogd", "state": "S", "nice": 0, "cpu_pct": 0.2, "mem_mb": 6.2, "status": "ok"},
        ]

        # Combine with active simulated demo processes
        demo_procs = []
        for p in self.simulated_processes.values():
            demo_procs.append({
                "pid": p["pid"],
                "name": p["name"],
                "state": p["state"],
                "nice": p["nice"],
                "cpu_pct": p["cpu_pct"],
                "mem_mb": round(p["mem_mb"], 1),
                "status": p["status"],
            })

        all_procs = demo_procs + base_processes
        all_procs.sort(key=lambda x: x["cpu_pct"], reverse=True)
        max_rows = int(self.config.get("table_rows", 10))
        top_procs = all_procs[:max_rows]

        # Calculate system stats
        total_mem = 5800.0
        used_mem = 1320.0 + sum(p["mem_mb"] for p in demo_procs)
        used_mem = min(total_mem - 200.0, used_mem)
        free_mem = round(total_mem - used_mem, 1)
        mem_pct = round((used_mem / total_mem) * 100.0, 1)

        base_cpu = 14.5 + (0.5 * (self.uptime_sec % 5))
        demo_cpu = sum(p["cpu_pct"] for p in demo_procs if p["state"] != "T" and p["state"] != "Z")
        total_cpu = min(399.0, round(base_cpu + demo_cpu, 1))
        # Normalized CPU % for gauge (0 - 100)
        norm_cpu_pct = min(100.0, round(total_cpu / 4.0, 1))

        load1 = round(0.25 + (demo_cpu / 100.0), 2)
        load5 = round(0.18 + (demo_cpu / 200.0), 2)
        load15 = round(0.09 + (demo_cpu / 350.0), 2)

        mode_str = "DRY-RUN" if bool(self.config.get("dry_run", 0)) else "LIVE"

        return {
            "running": True,
            "missing": False,
            "stale": False,
            "age_sec": 0.1,
            "timestamp": timestamp,
            "epoch": self.epoch,
            "pid": 1042,
            "uptime_sec": self.uptime_sec,
            "mode": mode_str,
            "cores": 4,
            "config_file": "manager.conf",
            "system": {
                "cpu_pct": norm_cpu_pct,
                "mem_pct": mem_pct,
                "mem_total_mb": int(total_mem),
                "mem_free_mb": int(free_mem),
                "load": [load1, load5, load15],
                "process_count": 120 + len(demo_procs),
            },
            "rules": {
                "cpu_limit": float(self.config.get("cpu_limit", 70.0)),
                "mem_limit_mb": float(self.config.get("mem_limit_mb", 500.0)),
                "t_renice": int(self.config.get("t_renice", 5)),
                "t_kill": int(self.config.get("t_kill", 10)),
                "leak_secs": int(self.config.get("leak_secs", 10)),
                "nice_value": int(self.config.get("nice_value", 10)),
                "grace_cycles": int(self.config.get("grace_cycles", 3)),
            },
            "totals": dict(self.totals),
            "processes": top_procs,
            "events": list(self.events),
        }

mock_simulator = MockSimulator() if MOCK_MODE else None

# ---------------------------------------------------------------------------
# Helper functions for Real Mode
# ---------------------------------------------------------------------------
def parse_manager_conf(path: Path) -> Dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    if not path.is_file():
        return config

    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip()
                    if key == "dry_run":
                        config[key] = int(val)
                    elif key in ("cpu_limit", "mem_limit_mb"):
                        config[key] = float(val)
                    elif key in ("t_renice", "t_kill", "leak_secs", "nice_value", "grace_cycles", "table_rows"):
                        config[key] = int(val)
                    elif key == "protected":
                        config[key] = val
    except Exception as e:
        print(f"Warning: error parsing manager.conf: {e}", file=sys.stderr)

    return config

def write_manager_conf_atomic(path: Path, config: Dict[str, Any]):
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    temp_path = parent / f".{path.name}.tmp"

    template = f"""# Smart Resource Manager Configuration
# Automatically written by Control Center on {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

# Run in dry-run mode (1 = log actions only, 0 = enforce signals)
dry_run = {int(config.get("dry_run", 0))}

# CPU limit threshold percentage (10.0 - 100.0)
cpu_limit = {float(config.get("cpu_limit", 70.0))}

# Memory limit threshold in MB (50.0 - 100000.0)
mem_limit_mb = {float(config.get("mem_limit_mb", 500.0))}

# Seconds of sustained high CPU before renicing (1 - 60)
t_renice = {int(config.get("t_renice", 5))}

# Seconds of sustained high CPU before sending SIGTERM (t_renice - 120)
t_kill = {int(config.get("t_kill", 10))}

# Seconds of continuous memory growth before pausing via SIGSTOP (2 - 120)
leak_secs = {int(config.get("leak_secs", 10))}

# Target nice value for reniced processes (1 - 19)
nice_value = {int(config.get("nice_value", 10))}

# Grace cycles between SIGTERM and SIGKILL (1 - 30)
grace_cycles = {int(config.get("grace_cycles", 3))}

# Maximum rows in top processes table (3 - 50)
table_rows = {int(config.get("table_rows", 10))}

# Protected process names (comma-separated, never reniced/paused/killed)
protected = {str(config.get("protected", DEFAULT_CONFIG["protected"]))}
"""
    with open(temp_path, "w", encoding="utf-8") as f:
        f.write(template)

    os.replace(temp_path, path)

# Tracked real demo processes: list of {pid: int, kind: str, proc: Popen}
tracked_demo_processes: List[Dict[str, Any]] = []

# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
app = FastAPI(title="Smart Resource Manager Control Center")

class ConfigUpdateModel(BaseModel):
    dry_run: Optional[int] = Field(None, ge=0, le=1)
    cpu_limit: Optional[float] = Field(None, ge=10.0, le=100.0)
    mem_limit_mb: Optional[float] = Field(None, ge=50.0, le=100000.0)
    t_renice: Optional[int] = Field(None, ge=1, le=60)
    t_kill: Optional[int] = Field(None, ge=1, le=120)
    leak_secs: Optional[int] = Field(None, ge=2, le=120)
    nice_value: Optional[int] = Field(None, ge=1, le=19)
    grace_cycles: Optional[int] = Field(None, ge=1, le=30)
    table_rows: Optional[int] = Field(None, ge=3, le=50)
    protected: Optional[str] = None

class DemoStartModel(BaseModel):
    kind: str = Field(..., pattern="^(cpu|leak|stubborn)$")

# Serve static index directly at root
@app.get("/", response_class=HTMLResponse)
async def get_index():
    index_file = STATIC_DIR / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=404, detail="Frontend index.html not found")
    with open(index_file, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())

# GET /api/state
@app.get("/api/state")
async def get_state():
    if MOCK_MODE:
        return mock_simulator.get_state()

    if not STATE_FILE.is_file():
        return {
            "running": False,
            "missing": True,
            "stale": True,
            "age_sec": 999.0,
            "system": {"cpu_pct": 0, "mem_pct": 0, "mem_total_mb": 0, "mem_free_mb": 0, "load": [0, 0, 0], "process_count": 0},
            "processes": [],
            "events": [],
            "totals": {"warn": 0, "renice": 0, "pause": 0, "kill": 0},
            "rules": DEFAULT_CONFIG,
        }

    try:
        mtime = STATE_FILE.stat().st_mtime
        age_sec = round(time.time() - mtime, 1)
        stale = age_sec > 3.0

        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        data["stale"] = stale
        data["age_sec"] = age_sec
        data["missing"] = False
        return data
    except json.JSONDecodeError:
        # Atomic file write collision - return graceful fallback
        return {
            "running": True,
            "missing": False,
            "stale": True,
            "age_sec": 0.5,
            "notice": "Reading state mid-write",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed reading state.json: {e}")

# GET /api/log?lines=200
@app.get("/api/log")
async def get_log(lines: int = Query(200, ge=1, le=1000)):
    if MOCK_MODE:
        raw_lines = mock_simulator.log_lines[-lines:]
    else:
        if not LOG_FILE.is_file():
            return []
        try:
            with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                all_lines = f.readlines()
            raw_lines = [l.strip() for l in all_lines[-lines:] if l.strip()]
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed reading manager.log: {e}")

    log_pattern = re.compile(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[([A-Z0-9\-]+)\]\s+(.*)$")
    parsed = []
    for line in raw_lines:
        match = log_pattern.match(line)
        if match:
            parsed.append({
                "time": match.group(1),
                "level": match.group(2),
                "message": match.group(3),
            })
        else:
            parsed.append({
                "time": "",
                "level": "INFO",
                "message": line,
            })
    return parsed

# GET /api/config
@app.get("/api/config")
async def get_config():
    if MOCK_MODE:
        return mock_simulator.config
    return parse_manager_conf(CONF_FILE)

# PUT /api/config
@app.put("/api/config")
async def update_config(update: ConfigUpdateModel):
    current = mock_simulator.config if MOCK_MODE else parse_manager_conf(CONF_FILE)
    update_data = update.model_dump(exclude_unset=True)

    # Validate cross-field constraint: t_kill >= t_renice
    t_renice = update_data.get("t_renice", current.get("t_renice", 5))
    t_kill = update_data.get("t_kill", current.get("t_kill", 10))
    if t_kill < t_renice:
        raise HTTPException(
            status_code=400,
            detail=f"t_kill ({t_kill}) must be greater than or equal to t_renice ({t_renice})"
        )

    for k, v in update_data.items():
        if v is not None:
            current[k] = v

    if MOCK_MODE:
        mock_simulator.config = current
        mock_simulator.add_event("CONFIG", "manager.conf reloaded successfully via SIGUSR1 (mock)")
        return {
            "saved": True,
            "reloaded": True,
            "message": "Configuration saved and reloaded in mock manager",
            "config": current,
        }

    # Save atomically to manager.conf
    try:
        write_manager_conf_atomic(CONF_FILE, current)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write manager.conf: {e}")

    # Send SIGUSR1 to smart_rm if running
    reloaded = False
    message = "Configuration saved."

    manager_pid = None
    if STATE_FILE.is_file():
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                s = json.load(f)
                if s.get("running"):
                    manager_pid = s.get("pid")
        except Exception:
            pass

    if manager_pid and manager_pid > 0:
        if sys.platform != "win32" and SIGUSR1 is not None:
            try:
                os.kill(manager_pid, SIGUSR1)
                reloaded = True
                message = f"Configuration saved and SIGUSR1 signal sent to smart_rm (PID {manager_pid})."
            except ProcessLookupError:
                message = f"Configuration saved, but manager process (PID {manager_pid}) was not found."
            except Exception as e:
                message = f"Configuration saved, but signalling manager failed: {e}"
        else:
            message = "Configuration saved. (SIGUSR1 is not available on Windows; config will apply on next run)."
    else:
        message = "Configuration saved. Manager is not currently running; changes will apply on next launch."

    return {
        "saved": True,
        "reloaded": reloaded,
        "message": message,
        "config": current,
    }

# POST /api/demo/start
@app.post("/api/demo/start")
async def start_demo(demo: DemoStartModel):
    kind = demo.kind

    if MOCK_MODE:
        pid = mock_simulator.start_demo(kind)
        return {"started": True, "kind": kind, "pid": pid, "message": f"Started mock {kind} process (PID {pid})"}

    import subprocess
    cmd_map = {
        "cpu": ["yes"],
        "leak": ["./leak"],
        "stubborn": ["./stubborn"],
    }
    cmd = cmd_map[kind]

    # Verify binary exists in PROJECT_DIR for ./leak and ./stubborn
    if cmd[0].startswith("./"):
        bin_path = PROJECT_DIR / cmd[0][2:]
        if not bin_path.is_file():
            raise HTTPException(
                status_code=400,
                detail=f"Executable '{cmd[0]}' not found in project directory ({PROJECT_DIR}). Please compile it first."
            )
        if sys.platform != "win32" and not os.access(bin_path, os.X_OK):
            raise HTTPException(
                status_code=400,
                detail=f"Executable '{cmd[0]}' is not executable (chmod +x required)."
            )

    try:
        kwargs: Dict[str, Any] = {
            "cwd": str(PROJECT_DIR),
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if sys.platform != "win32":
            kwargs["start_new_session"] = True

        proc = subprocess.Popen(cmd, **kwargs)
        tracked_demo_processes.append({
            "pid": proc.pid,
            "kind": kind,
            "proc": proc,
            "start_time": time.time(),
        })
        return {"started": True, "kind": kind, "pid": proc.pid, "message": f"Started {kind} (PID {proc.pid})"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start demo process: {e}")

# POST /api/demo/stop
@app.post("/api/demo/stop")
async def stop_demo():
    if MOCK_MODE:
        count = mock_simulator.stop_all_demos()
        return {"stopped": True, "count": count, "message": f"Stopped {count} simulated demo processes"}

    stopped_count = 0
    for item in list(tracked_demo_processes):
        proc = item["proc"]
        pid = item["pid"]
        try:
            if proc.poll() is None:
                if sys.platform != "win32":
                    try:
                        os.killpg(os.getpgid(pid), SIGKILL)
                    except Exception:
                        proc.kill()
                else:
                    proc.kill()
                stopped_count += 1
        except Exception:
            pass

    tracked_demo_processes.clear()
    return {"stopped": True, "count": stopped_count, "message": f"Stopped {stopped_count} demo processes"}

# GET /api/demo
@app.get("/api/demo")
async def get_demo_status():
    if MOCK_MODE:
        running = []
        for pid, p in mock_simulator.simulated_processes.items():
            running.append({
                "pid": pid,
                "kind": p.get("kind"),
                "name": p.get("name"),
                "elapsed": p.get("elapsed", 0),
                "status": p.get("status"),
            })
        return {"running": running}

    running = []
    for item in list(tracked_demo_processes):
        proc = item["proc"]
        if proc.poll() is None:
            running.append({
                "pid": item["pid"],
                "kind": item["kind"],
                "name": item["kind"],
                "elapsed": int(time.time() - item["start_time"]),
            })
        else:
            tracked_demo_processes.remove(item)

    return {"running": running}

# Mount static files for assets
if STATIC_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
