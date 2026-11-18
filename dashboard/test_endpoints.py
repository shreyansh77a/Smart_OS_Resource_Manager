import os
import sys
import asyncio

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

os.environ["MOCK"] = "1"

import httpx
from server import app

async def test_all():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        print("1. Testing GET / (Frontend Index)...", flush=True)
        res = await client.get("/")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}"
        assert "Smart Resource Manager" in res.text
        print("   ✓ GET / OK", flush=True)

        print("2. Testing Static Files...", flush=True)
        res_css = await client.get("/static/style.css")
        assert res_css.status_code == 200
        assert "root" in res_css.text or "palette" in res_css.text.lower()
        res_js = await client.get("/static/app.js")
        assert res_js.status_code == 200
        assert "pollState" in res_js.text
        print("   ✓ Static CSS/JS OK", flush=True)

        print("3. Testing GET /api/state in MOCK mode...", flush=True)
        res_state = await client.get("/api/state")
        assert res_state.status_code == 200
        state_data = res_state.json()
        assert state_data["running"] is True
        assert "system" in state_data
        assert "cpu_pct" in state_data["system"]
        assert "mem_pct" in state_data["system"]
        assert "processes" in state_data
        assert len(state_data["processes"]) > 0
        assert "totals" in state_data
        assert "rules" in state_data
        print(f"   ✓ State returned: CPU={state_data['system']['cpu_pct']}%, RAM={state_data['system']['mem_pct']}%, Top Procs={len(state_data['processes'])}", flush=True)

        print("4. Testing GET /api/config...", flush=True)
        res_cfg = await client.get("/api/config")
        assert res_cfg.status_code == 200
        cfg = res_cfg.json()
        assert "cpu_limit" in cfg
        assert "t_renice" in cfg
        assert "t_kill" in cfg
        print(f"   ✓ Config returned: CPU limit={cfg['cpu_limit']}, t_renice={cfg['t_renice']}, t_kill={cfg['t_kill']}", flush=True)

        print("5. Testing PUT /api/config (Validation & Update)...", flush=True)
        # Test invalid: t_kill < t_renice
        bad_res = await client.put("/api/config", json={"t_renice": 20, "t_kill": 10})
        assert bad_res.status_code == 400
        print("   ✓ Validation: t_kill < t_renice correctly rejected (400)", flush=True)

        # Test valid update
        good_res = await client.put("/api/config", json={"cpu_limit": 75.0, "dry_run": 1})
        assert good_res.status_code == 200
        res_json = good_res.json()
        assert res_json["saved"] is True
        assert res_json["config"]["cpu_limit"] == 75.0
        assert res_json["config"]["dry_run"] == 1
        print("   ✓ Config PUT successfully applied", flush=True)

        print("6. Testing GET /api/log...", flush=True)
        res_log = await client.get("/api/log?lines=50")
        assert res_log.status_code == 200
        logs = res_log.json()
        assert isinstance(logs, list)
        assert len(logs) > 0
        assert "level" in logs[0]
        assert "message" in logs[0]
        print(f"   ✓ Returned {len(logs)} parsed log lines", flush=True)

        print("7. Testing Demo Controls in MOCK mode...", flush=True)
        # Start CPU hog
        start_cpu = await client.post("/api/demo/start", json={"kind": "cpu"})
        assert start_cpu.status_code == 200
        cpu_pid = start_cpu.json()["pid"]
        print(f"   ✓ Started CPU demo with PID {cpu_pid}", flush=True)

        # Check demo status
        demo_status = await client.get("/api/demo")
        assert demo_status.status_code == 200
        running = demo_status.json()["running"]
        assert any(p["pid"] == cpu_pid for p in running)
        print(f"   ✓ Demo process PID {cpu_pid} confirmed running in /api/demo", flush=True)

        # Start Memory Leak
        start_leak = await client.post("/api/demo/start", json={"kind": "leak"})
        assert start_leak.status_code == 200
        leak_pid = start_leak.json()["pid"]
        print(f"   ✓ Started Leak demo with PID {leak_pid}", flush=True)

        # Stop all demo processes
        stop_res = await client.post("/api/demo/stop")
        assert stop_res.status_code == 200
        print(f"   ✓ Stopped all demo processes ({stop_res.json()['count']} stopped)", flush=True)

        print("\nALL BACKEND UNIT & INTEGRATION CHECKS PASSED SUCCESSFULLY!", flush=True)

if __name__ == "__main__":
    asyncio.run(test_all())
