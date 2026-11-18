# Smart Resource Manager Control Center

A modern, real-time web dashboard for monitoring and managing Linux system processes, built for university Operating Systems project demonstrations.

---

## Quick Start

### 1. Prerequisites
- Python 3.9+
- Linux (Ubuntu/Debian, WSL Ubuntu, or macOS) or Windows (in `MOCK=1` mode)

### 2. Setup Virtual Environment & Dependencies

#### Linux / WSL / macOS:
```bash
# 1. Create a virtual environment
python3 -m venv venv

# 2. Activate the virtual environment
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt
```

#### Windows (PowerShell):
```powershell
# 1. Create a virtual environment
python -m venv venv

# 2. Activate the virtual environment
.\venv\Scripts\Activate.ps1

# 3. Install dependencies
pip install -r requirements.txt
```

---

## Running the Server

### Real Mode (Linux / WSL with `smart_rm`)
Ensure `smart_rm` is running in your project folder. The dashboard reads `state.json`, `manager.log`, and `manager.conf` from the parent directory (or the path set in `PROJECT_DIR`).

```bash
# Activate your venv if not already active
source venv/bin/activate

# Optional: set custom project directory if not running in the default parent folder
# export PROJECT_DIR=/path/to/smart_rm_project

# Start the dashboard server
uvicorn server:app --host 127.0.0.1 --port 8000
```
Then open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your web browser.

---

### Mock Mode (For Offline Demos & Windows Development)
In Mock Mode, the server generates realistic fake state, simulated CPU hogs, memory leaks, stubborn processes, and escalation cycles completely in memory. No C++ binary or Linux environment is needed.

#### Linux / WSL:
```bash
MOCK=1 uvicorn server:app --host 127.0.0.1 --port 8000
```

#### Windows (PowerShell):
```powershell
$env:MOCK="1"
uvicorn server:app --host 127.0.0.1 --port 8000
```

#### Windows (Command Prompt):
```cmd
set MOCK=1
uvicorn server:app --host 127.0.0.1 --port 8000
```

---

## Features
- **Hero KPIs**: Dual animated radial gauges (System CPU & Memory) with dynamic threshold coloring and 120-sample sparklines.
- **Live Timeline Chart**: 2-5 minute history canvas with vertical action markers (RENICE, PAUSE, KILL, CONFIG) showing cause and effect.
- **Process Table**: Live top processes, state chips with OS tooltips, inline CPU usage bars, nice values, status pills, sorting, and search filter.
- **Action Feed & Counters**: Real-time event stream with toast notifications for critical actions and count-up counters.
- **"How It Works" Ladder**: Visual escalation ladder with active rules and OS concept explanations (scheduler & nice, SIGSTOP, SIGTERM vs SIGKILL, /proc).
- **Interactive Settings Drawer**: Adjust thresholds, dry-run mode, and protected process chips with atomic updates.
- **Demo Controls**: One-click triggers for CPU hog (`yes`), memory leak (`./leak`), and stubborn process (`./stubborn`).
- **Log Viewer**: Filterable, searchable `manager.log` viewer with download functionality.
- **Presentation Mode**: Fullscreen high-contrast kiosk mode (press `F` or click the projector icon).
- **Theme**: Dark-first mission control aesthetic with toggleable light mode.
