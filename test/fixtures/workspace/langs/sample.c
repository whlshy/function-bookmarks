#include <stdio.h>
#define MAX(a, b) ((a) > (b) ? (a) : (b))

struct point {
    int x, y;
};

struct point origin = { 0, 0 };
static int counter(void);

/* int fake(void) { } */
static inline int add(int a, int b)
{
    const char *s = "int not_me(void) {";
    char c = '{';
    if (a > b) {
        return a;
    }
    return a + b;
}

struct point *make_point(int x, int y) {
    struct point *p = malloc(sizeof *p);
    return p;
}

enum color { RED, GREEN };

int main(int argc, char **argv) {
    for (int i = 0; i < argc; i++) {
        printf("%d\n", add(i, 1));
    }
    return 0;
}
