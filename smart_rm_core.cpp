// Smart Resource Manager - core engine (Steps 1-5)
// Modules: scanner, policy engine, action module, config, logger, state exporter
// Writes live data to state.json (read by the web dashboard) and events to manager.log
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
#include <filesystem>
#include <ctime>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <csignal>
#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/resource.h>
using namespace std;
namespace fs = std::filesystem;

const char *LOG_FILE = "manager.log";
const char *STATE_FILE = "state.json";

enum Action { ACT_NONE, ACT_WARN, ACT_RENICE, ACT_PAUSE, ACT_KILL };
const char *ACTION_NAME[] = {"NONE", "WARN", "RENICE", "PAUSE", "KILL"};

struct Proc {
    int pid = 0;
    string name;
    char state = '?';          // R running, S sleeping, T stopped, Z zombie ...
    int nice = 0;
    unsigned long long ticks = 0;
    double cpu = 0;
    double memMB = 0;
};

struct Track {
    int hot = 0, rise = 0;
    double lastMem = 0;
    Action level = ACT_NONE;
    int actedAt = 0;
    bool sigkillSent = false;
    bool seen = false;
};

struct Event { string time, level, msg; };

// ---- settings: defaults here, overridden by manager.conf ----
struct Config {
    bool dryRun = false;
    double cpuLimit = 70.0, memLimitMB = 500.0;
    int tRenice = 5, tKill = 10, leakSecs = 10, niceValue = 10, graceCycles = 3;
    int tableRows = 15;        // how many processes are exported to state.json
    set<string> prot = {"systemd", "init", "sshd", "bash", "zsh", "sh",
                        "node", "MainThread", "SessionLeader"};
};

Config cfg;
unordered_map<int, Track> tracks;
deque<Event> events;                    // last 30 events, exported to state.json
int counts[5] = {0, 0, 0, 0, 0};
int cycleNo = 0;
ofstream logFile;
volatile sig_atomic_t running = 1, reloadFlag = 0;

void onSignal(int) { running = 0; }
void onUsr1(int)   { reloadFlag = 1; }

string nowStr(const char *fmt) {
    time_t now = time(nullptr);
    tm tmv;
    char ts[40];
    localtime_r(&now, &tmv);
    strftime(ts, sizeof ts, fmt, &tmv);
    return ts;
}

// ------------------- LOGGER MODULE -------------------

void logMsg(const string &level, const string &msg) {
    if (!logFile.is_open()) return;
    logFile << nowStr("%Y-%m-%d %H:%M:%S") << " [" << level << "] " << msg << "\n" << flush;
}

// keep the event for the dashboard, write it to the log file, print it in the terminal
void record(const string &level, const string &msg) {
    Event e{nowStr("%Y-%m-%d %H:%M:%S"), level, msg};
    events.push_back(e);
    if (events.size() > 30) events.pop_front();
    logMsg(level, msg);
    printf("\r\033[K[%s] %-7s %s\n", e.time.c_str(), level.c_str(), msg.c_str());
}

// ------------------- CONFIG MODULE -------------------

string trim(const string &s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

void loadConfig(const string &path) {
    cfg = Config();   // start from defaults
    ifstream f(path);
    if (!f) {
        logMsg("INFO", "config file '" + path + "' not found, using defaults");
        return;
    }
    string line;
    int lineno = 0;
    while (getline(f, line)) {
        lineno++;
        size_t hash = line.find('#');
        if (hash != string::npos) line.erase(hash);   // strip comments
        line = trim(line);
        if (line.empty()) continue;
        size_t eq = line.find('=');
        if (eq == string::npos) {
            logMsg("WARN", "config line " + to_string(lineno) + " ignored (no '=')");
            continue;
        }
        string key = trim(line.substr(0, eq)), val = trim(line.substr(eq + 1));

        if      (key == "dry_run")      cfg.dryRun = atoi(val.c_str()) != 0;
        else if (key == "cpu_limit")    cfg.cpuLimit = atof(val.c_str());
        else if (key == "mem_limit_mb") cfg.memLimitMB = atof(val.c_str());
        else if (key == "t_renice")     cfg.tRenice = atoi(val.c_str());
        else if (key == "t_kill")       cfg.tKill = atoi(val.c_str());
        else if (key == "leak_secs")    cfg.leakSecs = atoi(val.c_str());
        else if (key == "nice_value")   cfg.niceValue = atoi(val.c_str());
        else if (key == "grace_cycles") cfg.graceCycles = atoi(val.c_str());
        else if (key == "table_rows")   cfg.tableRows = atoi(val.c_str());
        else if (key == "protected") {
            cfg.prot.clear();
            istringstream ss(val);
            string tok;
            while (getline(ss, tok, ',')) {
                tok = trim(tok);
                if (!tok.empty()) cfg.prot.insert(tok);
            }
        } else {
            logMsg("WARN", "config line " + to_string(lineno) + ": unknown key '" + key + "'");
        }
    }

    // sanity checks so a typo can't break the manager
    cfg.tRenice = max(cfg.tRenice, 1);
    cfg.tKill = max(cfg.tKill, cfg.tRenice);
    cfg.leakSecs = max(cfg.leakSecs, 2);
    cfg.graceCycles = max(cfg.graceCycles, 1);
    cfg.niceValue = min(max(cfg.niceValue, 1), 19);
    cfg.tableRows = min(max(cfg.tableRows, 3), 50);

    char buf[300];
    snprintf(buf, sizeof buf,
             "config loaded from %s: dry_run=%d cpu_limit=%.0f mem_limit=%.0fMB "
             "renice=%ds kill=%ds leak=%ds nice=%d protected=%zu names",
             path.c_str(), cfg.dryRun, cfg.cpuLimit, cfg.memLimitMB,
             cfg.tRenice, cfg.tKill, cfg.leakSecs, cfg.niceValue, cfg.prot.size());
    logMsg("INFO", buf);
}

bool isProtected(const Proc &p) {
    return p.pid <= 1 || p.pid == getpid() ||
           cfg.prot.count(p.name) || p.name.rfind("Relay", 0) == 0;
}

// ------------------- ACTION MODULE -------------------

bool ownedByMe(int pid) {
    struct stat st;
    string path = "/proc/" + to_string(pid);
    return stat(path.c_str(), &st) == 0 && st.st_uid == getuid();
}

bool execute(Action a, int pid, string &msg) {
    if (cfg.dryRun) { msg = "dry-run"; return true; }
    if (a == ACT_WARN) { msg = "logged"; return true; }
    if (!ownedByMe(pid)) { msg = "skipped (not your process)"; return false; }

    int rc = -1;
    errno = 0;
    switch (a) {
    case ACT_RENICE: rc = setpriority(PRIO_PROCESS, pid, cfg.niceValue); break;
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

    t.hot  = (p.cpu > cfg.cpuLimit) ? t.hot + 1 : 0;
    t.rise = (p.memMB > t.lastMem + 0.5) ? t.rise + 1 : 0;
    t.lastMem = p.memMB;

    char buf[200];

    // SIGTERM ignored? escalate to SIGKILL after the grace period
    if (t.level == ACT_KILL && !t.sigkillSent && !cfg.dryRun &&
        cycleNo - t.actedAt >= cfg.graceCycles) {
        int rc = kill(p.pid, SIGKILL);
        t.sigkillSent = true;
        snprintf(buf, sizeof buf, "pid=%d (%s): ignored SIGTERM -> SIGKILL %s",
                 p.pid, p.name.c_str(), rc == 0 ? "done" : "FAILED");
        record("KILL-9", buf);
        return;
    }

    Action want = ACT_NONE;
    const char *why = "";
    if (p.memMB > cfg.memLimitMB) { want = ACT_WARN;   why = "memory above limit"; }
    if (t.hot >= cfg.tRenice)     { want = ACT_RENICE; why = "high CPU usage"; }
    if (t.rise >= cfg.leakSecs)   { want = ACT_PAUSE;  why = "possible memory leak"; }
    if (t.hot >= cfg.tKill)       { want = ACT_KILL;   why = "CPU hog for too long"; }

    if (want > t.level) {
        t.level = want;
        counts[want]++;
        string result;
        execute(want, p.pid, result);
        if (want == ACT_KILL) t.actedAt = cycleNo;
        snprintf(buf, sizeof buf, "pid=%d (%s): %s -> %s",
                 p.pid, p.name.c_str(), why, result.c_str());
        record(ACTION_NAME[want], buf);
    }
}

// ------------------- SCANNER MODULE -------------------

struct CpuTimes { unsigned long long idle = 0, total = 0; };

bool readCpu(CpuTimes &t) {
    ifstream f("/proc/stat");
    string label;
    unsigned long long v[8] = {0};
    if (!(f >> label)) return false;
    for (int i = 0; i < 8; i++)
        if (!(f >> v[i])) return false;
    t.idle = v[3] + v[4];                 // idle + iowait
    t.total = 0;
    for (int i = 0; i < 8; i++) t.total += v[i];
    return true;
}

bool readMem(unsigned long &total, unsigned long &avail) {
    ifstream f("/proc/meminfo");
    string line;
    int got = 0;
    while (getline(f, line) && got < 2) {
        istringstream ss(line);
        string key;
        unsigned long val;
        ss >> key >> val;
        if (key == "MemTotal:") { total = val; got++; }
        else if (key == "MemAvailable:") { avail = val; got++; }
    }
    return got == 2;
}

bool readProc(int pid, Proc &p) {
    ifstream f("/proc/" + to_string(pid) + "/stat");
    string line;
    if (!getline(f, line)) return false;

    size_t open = line.find('(');
    size_t close = line.rfind(')');
    if (open == string::npos || close == string::npos) return false;
    p.name = line.substr(open + 1, close - open - 1);

    // fields after ") ": 3=state ... 14=utime 15=stime ... 19=nice
    istringstream ss(line.substr(close + 2));
    string tok;
    unsigned long long utime = 0, stime = 0;
    for (int i = 3; i <= 19; i++) {
        if (!(ss >> tok)) return false;
        if (i == 3) p.state = tok[0];
        if (i == 14) utime = stoull(tok);
        if (i == 15) stime = stoull(tok);
        if (i == 19) p.nice = stoi(tok);
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
        try {
            if (readProc(stoi(name), p)) list.push_back(p);
        } catch (...) { /* process vanished while reading: skip it */ }
    }
    return list;
}

// ------------------- STATE EXPORT MODULE -------------------

string jsonEscape(const string &s) {
    string o;
    for (unsigned char c : s) {
        switch (c) {
        case '"':  o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default:
            if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
            else if (c >= 0x80) o += '?';      // keep the JSON valid UTF-8
            else o += (char)c;
        }
    }
    return o;
}

// what the manager is doing with this process right now
string statusOf(const Proc &p) {
    if (isProtected(p)) return "protected";
    auto it = tracks.find(p.pid);
    if (it == tracks.end()) return "ok";
    switch (it->second.level) {
    case ACT_WARN:   return "warned";
    case ACT_RENICE: return "reniced";
    case ACT_PAUSE:  return "paused";
    case ACT_KILL:   return "killed";
    default:         return "ok";
    }
}

string buildState(const vector<Proc> &procs, double sysCpu, unsigned long memTotalKB,
                  unsigned long memAvailKB, long cores, const string &conf) {
    ostringstream o;
    char b[512];
    double l1 = 0, l2 = 0, l3 = 0;
    { ifstream lf("/proc/loadavg"); lf >> l1 >> l2 >> l3; }
    double memPct = 100.0 * (1.0 - double(memAvailKB) / double(memTotalKB));

    o << "{\n";
    o << "  \"running\": true,\n";
    o << "  \"timestamp\": \"" << nowStr("%Y-%m-%dT%H:%M:%S") << "\",\n";
    o << "  \"epoch\": " << (long long)time(nullptr) << ",\n";
    o << "  \"pid\": " << getpid() << ",\n";
    o << "  \"uptime_sec\": " << cycleNo << ",\n";
    o << "  \"mode\": \"" << (cfg.dryRun ? "DRY-RUN" : "LIVE") << "\",\n";
    o << "  \"cores\": " << cores << ",\n";
    o << "  \"config_file\": \"" << jsonEscape(conf) << "\",\n";

    snprintf(b, sizeof b,
             "  \"system\": {\"cpu_pct\": %.1f, \"mem_pct\": %.1f, \"mem_total_mb\": %lu, "
             "\"mem_free_mb\": %lu, \"load\": [%.2f, %.2f, %.2f], \"process_count\": %zu},\n",
             sysCpu, memPct, memTotalKB / 1024, memAvailKB / 1024, l1, l2, l3, procs.size());
    o << b;

    snprintf(b, sizeof b,
             "  \"rules\": {\"cpu_limit\": %.1f, \"mem_limit_mb\": %.1f, \"t_renice\": %d, "
             "\"t_kill\": %d, \"leak_secs\": %d, \"nice_value\": %d, \"grace_cycles\": %d},\n",
             cfg.cpuLimit, cfg.memLimitMB, cfg.tRenice, cfg.tKill, cfg.leakSecs,
             cfg.niceValue, cfg.graceCycles);
    o << b;

    snprintf(b, sizeof b,
             "  \"totals\": {\"warn\": %d, \"renice\": %d, \"pause\": %d, \"kill\": %d},\n",
             counts[ACT_WARN], counts[ACT_RENICE], counts[ACT_PAUSE], counts[ACT_KILL]);
    o << b;

    o << "  \"processes\": [";
    for (size_t i = 0; i < (size_t)cfg.tableRows && i < procs.size(); i++) {
        const Proc &p = procs[i];
        snprintf(b, sizeof b,
                 "%s\n    {\"pid\": %d, \"name\": \"%s\", \"state\": \"%s\", \"nice\": %d, "
                 "\"cpu_pct\": %.1f, \"mem_mb\": %.1f, \"status\": \"%s\"}",
                 i ? "," : "", p.pid, jsonEscape(p.name).c_str(),
                 jsonEscape(string(1, p.state)).c_str(), p.nice, p.cpu, p.memMB,
                 statusOf(p).c_str());
        o << b;
    }
    o << "\n  ],\n";

    o << "  \"events\": [";
    bool first = true;
    for (auto &e : events) {
        o << (first ? "" : ",") << "\n    {\"time\": \"" << jsonEscape(e.time)
          << "\", \"level\": \"" << jsonEscape(e.level)
          << "\", \"message\": \"" << jsonEscape(e.msg) << "\"}";
        first = false;
    }
    o << "\n  ]\n}\n";
    return o.str();
}

// write to a temp file, then rename: readers never see a half-written file
void writeState(const string &json) {
    string tmp = string(STATE_FILE) + ".tmp";
    {
        ofstream out(tmp, ios::trunc);
        if (!out) return;
        out << json;
    }
    rename(tmp.c_str(), STATE_FILE);
}

// ------------------- MAIN LOOP -------------------

int main(int argc, char **argv) {
    string conf = (argc > 1) ? argv[1] : "manager.conf";
    long cores = sysconf(_SC_NPROCESSORS_ONLN);

    logFile.open(LOG_FILE, ios::app);
    if (!logFile) cerr << "warning: cannot open " << LOG_FILE << ", logging disabled\n";
    loadConfig(conf);
    logMsg("INFO", "manager started (pid=" + to_string(getpid()) + ", mode=" +
                   (cfg.dryRun ? "DRY-RUN" : "LIVE") + ")");

    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);
    signal(SIGUSR1, onUsr1);     // pkill -USR1 smart_rm reloads the config

    printf("Smart Resource Manager started (pid %d, mode %s)\n", getpid(),
           cfg.dryRun ? "DRY-RUN" : "LIVE");
    printf("Live data: %s | log: %s | Ctrl+C to stop\n\n", STATE_FILE, LOG_FILE);

    string lastState;
    while (running) {
        if (reloadFlag) {
            reloadFlag = 0;
            loadConfig(conf);
            record("CONFIG", "reloaded from " + conf + " (dry_run=" +
                             to_string(cfg.dryRun) + ")");
        }

        CpuTimes c1, c2;
        readCpu(c1);
        auto before = scan();
        this_thread::sleep_for(chrono::seconds(1));
        if (!running) break;
        readCpu(c2);
        auto after = scan();
        cycleNo++;

        double dt = double(c2.total - c1.total);
        if (dt <= 0) dt = 1;
        double sysCpu = 100.0 * (1.0 - double(c2.idle - c1.idle) / dt);

        unsigned long memTotal = 1, memAvail = 0;
        readMem(memTotal, memAvail);

        for (auto &a : after) {
            for (auto &b : before) {
                if (a.pid == b.pid) {
                    a.cpu = 100.0 * cores * double(a.ticks - b.ticks) / dt;
                    break;
                }
            }
            evaluate(a);
        }

        // forget processes that no longer exist
        for (auto it = tracks.begin(); it != tracks.end();) {
            if (!it->second.seen) it = tracks.erase(it);
            else { it->second.seen = false; ++it; }
        }

        // busiest first; processes tied on CPU are ordered by memory
        sort(after.begin(), after.end(), [](const Proc &x, const Proc &y) {
            if (x.cpu != y.cpu) return x.cpu > y.cpu;
            return x.memMB > y.memMB;
        });

        lastState = buildState(after, sysCpu, memTotal, memAvail, cores, conf);
        writeState(lastState);

        printf("\r\033[Kuptime %ds | CPU %.1f%% | MEM %.1f%% | procs %zu | warn=%d renice=%d pause=%d kill=%d",
               cycleNo, sysCpu, 100.0 * (1.0 - double(memAvail) / double(memTotal)),
               after.size(), counts[ACT_WARN], counts[ACT_RENICE], counts[ACT_PAUSE],
               counts[ACT_KILL]);
        fflush(stdout);
    }

    resumePaused();   // never leave a process frozen when we exit
    logMsg("INFO", "manager stopped: warn=" + to_string(counts[ACT_WARN]) +
                   " renice=" + to_string(counts[ACT_RENICE]) +
                   " pause=" + to_string(counts[ACT_PAUSE]) +
                   " kill=" + to_string(counts[ACT_KILL]));

    // final state tells the dashboard the manager has stopped
    size_t pos = lastState.find("\"running\": true");
    if (pos != string::npos) {
        lastState.replace(pos, 15, "\"running\": false");
        writeState(lastState);
    }
    printf("\r\033[K\nManager stopped. Paused processes resumed. See %s\n", LOG_FILE);
    return 0;
}