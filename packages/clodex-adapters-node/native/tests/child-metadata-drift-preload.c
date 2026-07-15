#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <limits.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef long (*syscall_function)(long number, ...);

static syscall_function next_syscall = NULL;
static unsigned int trigger_matches = 0U;
static bool metadata_mutated = false;

__attribute__((constructor)) static void resolve_next_syscall(void) {
  void *symbol = dlsym(RTLD_NEXT, "syscall");
  _Static_assert(sizeof(symbol) == sizeof(next_syscall), "dlsym size");
  memcpy(&next_syscall, &symbol, sizeof(next_syscall));
  if (next_syscall == NULL) {
    _exit(125);
  }
}

static unsigned int parse_match_count(const char *value) {
  if (value == NULL || *value == '\0') {
    _exit(126);
  }
  errno = 0;
  char *end = NULL;
  const unsigned long parsed = strtoul(value, &end, 10);
  if (
    errno != 0 || end == NULL || *end != '\0' || parsed == 0UL ||
    parsed > (unsigned long)UINT_MAX
  ) {
    _exit(126);
  }
  return (unsigned int)parsed;
}

static void mutate_child_metadata(const char *openat2_path) {
  const char *trigger = getenv("CLODEX_TEST_METADATA_TRIGGER");
  const char *target = getenv("CLODEX_TEST_METADATA_TARGET");
  if (
    metadata_mutated || trigger == NULL || *trigger == '\0' ||
    target == NULL || *target == '\0' || openat2_path == NULL ||
    strcmp(openat2_path, trigger) != 0
  ) {
    return;
  }
  const unsigned int wanted = parse_match_count(
    getenv("CLODEX_TEST_METADATA_MATCH")
  );
  if (++trigger_matches != wanted) {
    return;
  }
  if (chmod(target, (mode_t)0777U) < 0) {
    _exit(127);
  }
  metadata_mutated = true;
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
    mutate_child_metadata(path);
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
