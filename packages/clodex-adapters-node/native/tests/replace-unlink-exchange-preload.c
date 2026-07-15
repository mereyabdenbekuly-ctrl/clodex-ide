#define _GNU_SOURCE

#include <dlfcn.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef int (*unlinkat_function)(int directory_fd, const char *path, int flags);

static unlinkat_function next_unlinkat = NULL;
static bool exchanged = false;

__attribute__((constructor)) static void resolve_next_unlinkat(void) {
  void *symbol = dlsym(RTLD_NEXT, "unlinkat");
  _Static_assert(sizeof(symbol) == sizeof(next_unlinkat), "dlsym size");
  memcpy(&next_unlinkat, &symbol, sizeof(next_unlinkat));
  if (next_unlinkat == NULL) {
    _exit(125);
  }
}

static void record_exchange(void) {
  const char *marker = getenv("CLODEX_TEST_REPLACE_UNLINK_MARKER");
  if (marker == NULL || *marker == '\0') {
    _exit(126);
  }
  const int descriptor = open(
    marker,
    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
    (mode_t)0600U
  );
  if (descriptor < 0 || close(descriptor) < 0) {
    _exit(127);
  }
}

int unlinkat(int directory_fd, const char *path, int flags) {
  if (next_unlinkat == NULL) {
    _exit(125);
  }

  static const char staging_prefix[] = ".clodex-replace-v1-";
  if (
    exchanged || flags != 0 ||
    strncmp(path, staging_prefix, sizeof(staging_prefix) - 1U) != 0
  ) {
    return next_unlinkat(directory_fd, path, flags);
  }

  const char *victim = getenv("CLODEX_TEST_REPLACE_UNLINK_VICTIM");
  if (victim == NULL || *victim == '\0') {
    _exit(126);
  }
  if (
    syscall(
      SYS_renameat2,
      directory_fd,
      path,
      AT_FDCWD,
      victim,
      RENAME_EXCHANGE
    ) < 0
  ) {
    _exit(128);
  }
  exchanged = true;
  record_exchange();
  return next_unlinkat(directory_fd, path, flags);
}
