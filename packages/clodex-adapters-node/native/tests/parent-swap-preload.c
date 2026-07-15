#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef long (*syscall_function)(long number, ...);

static syscall_function next_syscall = NULL;
static bool exchanged = false;
static unsigned int trigger_matches = 0U;

__attribute__((constructor)) static void resolve_next_syscall(void) {
  void *symbol = dlsym(RTLD_NEXT, "syscall");
  _Static_assert(sizeof(symbol) == sizeof(next_syscall), "dlsym size");
  memcpy(&next_syscall, &symbol, sizeof(next_syscall));
  if (next_syscall == NULL) {
    _exit(125);
  }
}

static void build_entry_path(
  char output[PATH_MAX],
  const char *directory,
  const char *entry
) {
  const int length = snprintf(output, PATH_MAX, "%s/%s", directory, entry);
  if (length < 0 || (size_t)length >= PATH_MAX) {
    _exit(127);
  }
}

static void exchange_test_directories(const char *left, const char *right) {
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
    _exit(128);
  }
  exchanged = true;
}

static bool entry_exists(const char *path) {
  struct stat metadata;
  const int saved_errno = errno;
  if (
    next_syscall(
      SYS_newfstatat,
      AT_FDCWD,
      path,
      &metadata,
      AT_SYMLINK_NOFOLLOW
    ) == 0
  ) {
    errno = saved_errno;
    return true;
  }
  if (errno == ENOENT) {
    errno = saved_errno;
    return false;
  }
  _exit(129);
}

static const char *leaf_name(const char *path) {
  const char *separator = strrchr(path, '/');
  return separator == NULL ? path : separator + 1;
}

static unsigned int parse_match_count(const char *value) {
  if (value == NULL || *value == '\0') {
    _exit(126);
  }
  errno = 0;
  char *end = NULL;
  const unsigned long parsed = strtoul(value, &end, 10);
  if (
    errno != 0 || end == NULL || *end != '\0' ||
    parsed == 0UL || parsed > (unsigned long)UINT_MAX
  ) {
    _exit(126);
  }
  return (unsigned int)parsed;
}

static void mutate_test_namespace(const char *openat2_path) {
  const char *left = getenv("CLODEX_TEST_SWAP_LEFT");
  const char *right = getenv("CLODEX_TEST_SWAP_RIGHT");
  const char *action = getenv("CLODEX_TEST_SWAP_ACTION");
  if (
    left == NULL || *left == '\0' || right == NULL || *right == '\0' ||
    action == NULL || *action == '\0' || openat2_path == NULL
  ) {
    _exit(126);
  }
  if (exchanged) {
    return;
  }

  if (strcmp(action, "exchange-before-open") == 0) {
    const char *trigger = getenv("CLODEX_TEST_SWAP_TRIGGER");
    if (
      trigger == NULL || *trigger == '\0' ||
      strcmp(leaf_name(openat2_path), trigger) != 0
    ) {
      return;
    }
    exchange_test_directories(left, right);
    return;
  }

  if (strcmp(action, "exchange-on-match") == 0) {
    const char *trigger = getenv("CLODEX_TEST_SWAP_TRIGGER");
    const unsigned int wanted = parse_match_count(
      getenv("CLODEX_TEST_SWAP_MATCH")
    );
    if (
      trigger == NULL || *trigger == '\0' ||
      strcmp(openat2_path, trigger) != 0
    ) {
      return;
    }
    if (++trigger_matches == wanted) {
      exchange_test_directories(left, right);
    }
    return;
  }

  const char *entry = getenv("CLODEX_TEST_SWAP_ENTRY");
  if (entry == NULL || *entry == '\0') {
    _exit(126);
  }
  char left_entry[PATH_MAX];
  char right_entry[PATH_MAX];
  build_entry_path(left_entry, left, entry);
  build_entry_path(right_entry, right, entry);

  if (strcmp(action, "exchange-after-create") == 0) {
    if (!entry_exists(left_entry)) {
      return;
    }
    exchange_test_directories(left, right);
    return;
  }

  if (strcmp(action, "move-created-then-exchange") != 0) {
    _exit(126);
  }
  const int saved_errno = errno;
  if (
    next_syscall(
      SYS_renameat2,
      AT_FDCWD,
      left_entry,
      AT_FDCWD,
      right_entry,
      RENAME_NOREPLACE
    ) < 0
  ) {
    if (errno == ENOENT) {
      errno = saved_errno;
      return;
    }
    _exit(130);
  }
  errno = saved_errno;
  exchange_test_directories(left, right);
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
    const struct open_how *how = va_arg(
      arguments,
      const struct open_how *
    );
    const size_t size = va_arg(arguments, size_t);
    mutate_test_namespace(path);
    result = next_syscall(number, directory_fd, path, how, size);
  } else if (number == SYS_renameat2) {
    const int old_directory_fd = va_arg(arguments, int);
    char *old_path = va_arg(arguments, char *);
    const int new_directory_fd = va_arg(arguments, int);
    char *new_path = va_arg(arguments, char *);
    const int flags = va_arg(arguments, int);
    result = next_syscall(
      number,
      old_directory_fd,
      old_path,
      new_directory_fd,
      new_path,
      flags
    );
  } else if (number == SYS_getrandom) {
    unsigned char *buffer = va_arg(arguments, unsigned char *);
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
