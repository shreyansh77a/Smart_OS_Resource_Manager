#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <chrono>
#include <iomanip>
using namespace std;

struct CpuTimes { unsigned long long idle, total; };

bool readCpu(CpuTimes &t) {
    ifstream f("/proc/stat");
    string label;
    unsigned long long u, n, s, i, w, irq, sirq, st;
    if (!(f >> label >> u >> n >> s >> i >> w >> irq >> sirq >> st)) return false;
    t.idle  = i + w;
    t.total = u + n + s + i + w + irq + sirq + st;
    return true;
}

bool readMem(unsigned long &total, unsigned long &avail) {
    ifstream f("/proc/meminfo");
    string line;
    int got = 0;
    while (getline(f, line) && got < 2) {
        istringstream ss(line);
        string key; unsigned long val;
        ss >> key >> val;
        if (key == "MemTotal:") { total = val; got++; }
        else if (key == "MemAvailable:") { avail = val; got++; }
    }
    return got == 2;
}

int main() {
    CpuTimes a, b;
    unsigned long memTotal, memAvail;
    if (!readCpu(a)) { cerr << "cannot read /proc/stat\n"; return 1; }
    while (true) {
        this_thread::sleep_for(chrono::seconds(1));
        if (!readCpu(b) || !readMem(memTotal, memAvail)) {
            cerr << "failed to read /proc\n";
            return 1;
        }
        double cpu = 100.0 * (1.0 - double(b.idle - a.idle) / double(b.total - a.total));
        double mem = 100.0 * (1.0 - double(memAvail) / double(memTotal));
        cout << fixed << setprecision(1)
             << "CPU: " << cpu << "% | MEM: " << mem << "% ("
             << memAvail / 1024 << " MB free)\n";
        a = b;
    }
}