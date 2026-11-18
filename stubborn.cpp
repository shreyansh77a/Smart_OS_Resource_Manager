// Test helper: burns CPU and ignores SIGTERM, so only SIGKILL can stop it
#include <csignal>

int main() {
    signal(SIGTERM, SIG_IGN);
    volatile unsigned long x = 0;
    while (true) x++;
}
