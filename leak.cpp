// Test helper: leaks 2 MB every second
#include <cstdlib>
#include <cstring>
#include <unistd.h>

int main() {
    while (true) {
        char *p = (char *)malloc(2 * 1024 * 1024);
        if (!p) break;
        memset(p, 1, 2 * 1024 * 1024);   // touch it so it really uses RAM
        sleep(1);
    }
}
