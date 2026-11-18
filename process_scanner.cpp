#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <algorithm>
#include <thread>
#include <chrono>
#include <iomanip>
#include <filesystem>
#include <unistd.h>
using namespace std;
namespace fs = std::filesystem;

struct Proc {
    int pid;
    string name;
    unsigned long long ticks;
    double cpu = 0;
    double memMB = 0;
};

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

    // after ") ": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
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

int main() {
    long cores = sysconf(_SC_NPROCESSORS_ONLN);
    while (true) {
        auto t1 = totalCpuTicks();
        auto before = scan();
        this_thread::sleep_for(chrono::seconds(1));
        auto t2 = totalCpuTicks();
        auto after = scan();

        double dt = double(t2 - t1);
        for (auto &a : after) {
            for (auto &b : before) {
                if (a.pid == b.pid) {
                    a.cpu = 100.0 * cores * double(a.ticks - b.ticks) / dt;
                    break;
                }
            }
        }
        sort(after.begin(), after.end(),
             [](const Proc &x, const Proc &y) { return x.cpu > y.cpu; });

        cout << "\033[2J\033[H";
        cout << left << setw(8) << "PID" << setw(21) << "NAME"
             << right << setw(8) << "CPU%" << setw(11) << "MEM(MB)" << "\n";
        cout << "-------------------------------------------------\n";
        for (size_t i = 0; i < 10 && i < after.size(); i++)
            cout << left << setw(8) << after[i].pid << setw(21) << after[i].name
                 << right << setw(8) << fixed << setprecision(1) << after[i].cpu
                 << setw(11) << after[i].memMB << "\n";
    }
}