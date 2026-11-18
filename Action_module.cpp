#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <deque>
#include <set>
#include <unordered_map>
#include <algorithm>
#include <thread>
#include <chrono>
#include <iomanip>
#include <filesystem>
#include <cstdio>
#include <cstring>
#include <cerrno>
#include <csignal>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/resource.h>
using namespace std;
namespace fs = std::filesystem;

// ---- settings (moved to a config file in Step 5) ----
const bool   DRY_RUN = false;     // true = only print decisions, false = really act
const double CPU_LIMIT = 70.0;    // % of one core
const double MEM_LIMIT_MB = 500.0;
const int T_RENICE = 5;           // seconds above CPU_LIMIT -> lower priority
const int T_KILL = 10;            // seconds above CPU_LIMIT -> terminate
const int LEAK_SECS = 10;         // seconds of continuous memory growth -> pause
const int NICE_VALUE = 10;        // new nice value for renice
const int GRACE_CYCLES = 3;       // seconds to wait after SIGTERM before SIGKILL

enum Action { ACT_NONE, ACT_WARN, ACT_RENICE, ACT_PAUSE, ACT_KILL };
const char *ACTION_NAME[] = {"NONE", "WARN", "RENICE", "PAUSE", "KILL"};

struct Proc {
    int pid = 0;
    string name;
    unsigned long long ticks = 0;
    double cpu = 0;
    double memMB = 0;
};

struct Track {
    int hot = 0, rise = 0;
    double lastMem = 0;
    Action level = ACT_NONE;
    int actedAt = 0;            // cycle number when SIGTERM was sent
    bool sigkillSent = false;
    bool seen = false;
};

unordered_map<int, Track> tracks;
deque<string> events;
int cycleNo = 0;
volatile sig_atomic_t running = 1;

const set<string> PROTECTED = {"systemd", "init", "sshd", "bash", "zsh", "sh",
                               "node", "MainThread", "SessionLeader"};

void onSignal(int) { running = 0; }

void pushEvent(const string &s) {
    events.push_back(s);
    if (events.size() > 6) events.pop_front();
}

bool isProtected(const Proc &p) {
    return p.pid <= 1 || p.pid == getpid() ||
           PROTECTED.count(p.name) || p.name.rfind("Relay", 0) == 0;
}

// ------------------- ACTION MODULE -------------------

bool ownedByMe(int pid) {
    struct stat st;
    string path = "/proc/" + to_string(pid);
    return stat(path.c_str(), &st) == 0 && st.st_uid == getuid();
}

// returns true on success; 'msg' explains the result
bool execute(Action a, int pid, string &msg) {
    if (DRY_RUN) { msg = "dry-run"; return true; }
    if (a == ACT_WARN) { msg = "logged"; return true; }
    if (!ownedByMe(pid)) { msg = "skipped (not your process)"; return false; }

    int rc = -1;
    errno = 0;
    switch (a) {
    case ACT_RENICE: rc = setpriority(PRIO_PROCESS, pid, NICE_VALUE); break;
    case ACT_PAUSE:  rc = kill(pid, SIGSTOP); break;
    case ACT_KILL:   rc = kill(pid, SIGTERM); break;
    default: break;
    }
    msg = (rc == 0) ? "done" : string("FAILED: ") + strerror(errno);
    return rc == 0;
}

void resumePaused() {
    for (auto &kv : tracks)
        if (kv.second.level == ACT_PAUSE) kill(kv.first, SIGCONT);
}

// ------------------- POLICY MODULE -------------------

void evaluate(const Proc &p) {
    if (isProtected(p)) return;
    auto it = tracks.find(p.pid);
    if (it == tracks.end()) {
        Track fresh;
        fresh.lastMem = p.memMB;
        it = tracks.emplace(p.pid, fresh).first;
    }
    Track &t = it->second;
    t.seen = true;

    t.hot  = (p.cpu > CPU_LIMIT) ? t.hot + 1 : 0;
    t.rise = (p.memMB > t.lastMem + 0.5) ? t.rise + 1 : 0;
    t.lastMem = p.memMB;

    char buf[200];

    // SIGTERM ignored? escalate to SIGKILL after the grace period
    if (t.level == ACT_KILL && !t.sigkillSent && !DRY_RUN &&
        cycleNo - t.actedAt >= GRACE_CYCLES) {
        int rc = kill(p.pid, SIGKILL);
        t.sigkillSent = true;
        snprintf(buf, sizeof buf, "KILL-9   pid=%d (%s): ignored SIGTERM -> SIGKILL %s",
                 p.pid, p.name.c_str(), rc == 0 ? "done" : "FAILED");
        pushEvent(buf);
        return;
    }

    Action want = ACT_NONE;
    const char *why = "";
    if (p.memMB > MEM_LIMIT_MB) { want = ACT_WARN;   why = "memory above limit"; }
    if (t.hot >= T_RENICE)      { want = ACT_RENICE; why = "high CPU usage"; }
    if (t.rise >= LEAK_SECS)    { want = ACT_PAUSE;  why = "possible memory leak"; }
    if (t.hot >= T_KILL)        { want = ACT_KILL;   why = "CPU hog for too long"; }

    if (want > t.level) {
        t.level = want;
        string result;
        execute(want, p.pid, result);
        if (want == ACT_KILL) t.actedAt = cycleNo;
        snprintf(buf, sizeof buf, "%-8s pid=%d (%s): %s -> %s",
                 ACTION_NAME[want], p.pid, p.name.c_str(), why, result.c_str());
        pushEvent(buf);
    }
}

// ------------------- SCANNER MODULE -------------------

unsigned long long totalCpuTicks() {
    ifstream f("/proc/stat");
    string label;
    unsigned long long v, sum = 0;
    f >> label;
    for (int i = 0; i < 8 && (f >> v); i++) sum += v;
    return sum;
}

bool readProc(int pid, Proc &p) {
    ifstream f("/proc/" + to_string(pid) + "/stat");
    string line;
    if (!getline(f, line)) return false;

    size_t open = line.find('(');
    size_t close = line.rfind(')');
    if (open == string::npos || close == string::npos) return false;
    p.name = line.substr(open + 1, close - open - 1);

    istringstream ss(line.substr(close + 2));
    string tok;
    unsigned long long utime = 0, stime = 0;
    for (int i = 3; i <= 15; i++) {
        if (!(ss >> tok)) return false;
        if (i == 14) utime = stoull(tok);
        if (i == 15) stime = stoull(tok);
    }
    p.pid = pid;
    p.ticks = utime + stime;

    ifstream m("/proc/" + to_string(pid) + "/statm");
    unsigned long size, rss;
    if (!(m >> size >> rss)) return false;
    p.memMB = rss * (sysconf(_SC_PAGESIZE) / 1024.0) / 1024.0;
    return true;
}

vector<Proc> scan() {
    vector<Proc> list;
    for (auto &e : fs::directory_iterator("/proc")) {
        string name = e.path().filename().string();
        if (name.empty() || !isdigit((unsigned char)name[0])) continue;
        Proc p;
        if (readProc(stoi(name), p)) list.push_back(p);
    }
    return list;
}

// ------------------- MAIN LOOP -------------------

int main() {
    long cores = sysconf(_SC_NPROCESSORS_ONLN);
    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);

    while (running) {
        auto t1 = totalCpuTicks();
        auto before = scan();
        this_thread::sleep_for(chrono::seconds(1));
        if (!running) break;
        auto t2 = totalCpuTicks();
        auto after = scan();
        cycleNo++;

        double dt = double(t2 - t1);
        for (auto &a : after) {
            for (auto &b : before) {
                if (a.pid == b.pid) {
                    a.cpu = 100.0 * cores * double(a.ticks - b.ticks) / dt;
                    break;
                }
            }
            evaluate(a);
        }

        for (auto it = tracks.begin(); it != tracks.end();) {
            if (!it->second.seen) it = tracks.erase(it);
            else { it->second.seen = false; ++it; }
        }

        sort(after.begin(), after.end(),
             [](const Proc &x, const Proc &y) { return x.cpu > y.cpu; });

        cout << "\033[2J\033[H";
        cout << "SMART RESOURCE MANAGER  [" << (DRY_RUN ? "DRY-RUN" : "LIVE") << "]\n";
        cout << left << setw(8) << "PID" << setw(21) << "NAME"
             << right << setw(8) << "CPU%" << setw(11) << "MEM(MB)" << "\n";
        cout << "-------------------------------------------------\n";
        for (size_t i = 0; i < 10 && i < after.size(); i++)
            cout << left << setw(8) << after[i].pid << setw(21) << after[i].name
                 << right << setw(8) << fixed << setprecision(1) << after[i].cpu
                 << setw(11) << after[i].memMB << "\n";

        cout << "\nACTIONS TAKEN (CPU>" << CPU_LIMIT << "%: " << T_RENICE
             << "s=renice, " << T_KILL << "s=kill)\n";
        cout << "-------------------------------------------------\n";
        for (auto &e : events) cout << e << "\n";
        cout.flush();
    }

    resumePaused();   // never leave a process frozen when we exit
    cout << "\nManager stopped. Paused processes resumed.\n";
    return 0;
}