#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef long (*syscall_function)(long number, ...);

static syscall_function next_syscall = NULL;
static bool exchanged = false;

__attribute__((constructor)) static void resolve_next_syscall(void) {
  void *symbol = dlsym(RTLD_NEXT, "syscall");
  _Static_assert(sizeof(symbol) == sizeof(next_syscall), "dlsym size");
  memcpy(&next_syscall, &symbol, sizeof(next_syscall));
  if (next_syscall == NULL) {
    _exit(125);
  }
}

static void exchange_test_directories(const char *openat2_path) {
  const char *left = getenv("CLODEX_TEST_SWAP_LEFT");
  const char *right = getenv("CLODEX_TEST_SWAP_RIGHT");
  const char *trigger = getenv("CLODEX_TEST_SWAP_TRIGGER");
  if (
    left == NULL || *left == '\0' || right == NULL || *right == '\0' ||
    trigger == NULL || *trigger == '\0' || openat2_path == NULL
  ) {
    _exit(126);
  }
  if (exchanged || strcmp(openat2_path, trigger) != 0) {
    return;
  }
  exchanged = true;
  if (
    next_syscall(
      SYS_renameat2,
      AT_FDCWD,
      left,
      AT_FDCWD,
      right,
      RENAME_EXCHANGE
    ) < 0
  ) {
    _exit(127);
  }
}

long syscall(long number, ...) {
  if (next_syscall == NULL) {
    _exit(125);
  }

  va_list arguments;
  va_start(arguments, number);
  long result;

  if (number == SYS_openat2) {
    const int directory_fd = va_arg(arguments, int);
    const char *path = va_arg(arguments, const char *);
    const void *how = va_arg(arguments, const void *);
    const size_t size = va_arg(arguments, size_t);
    exchange_test_directories(path);
    result = next_syscall(number, directory_fd, path, how, size);
  } else if (number == SYS_renameat2) {
    const int old_directory_fd = va_arg(arguments, int);
    const char *old_path = va_arg(arguments, const char *);
    const int new_directory_fd = va_arg(arguments, int);
    const char *new_path = va_arg(arguments, const char *);
    const unsigned int flags = va_arg(arguments, unsigned int);
    result = next_syscall(
      number,
      old_directory_fd,
      old_path,
      new_directory_fd,
      new_path,
      flags
    );
  } else if (number == SYS_getrandom) {
    void *buffer = va_arg(arguments, void *);
    const size_t length = va_arg(arguments, size_t);
    const unsigned int flags = va_arg(arguments, unsigned int);
    result = next_syscall(number, buffer, length, flags);
  } else {
    errno = ENOSYS;
    result = -1;
  }

  va_end(arguments);
  return result;
}
