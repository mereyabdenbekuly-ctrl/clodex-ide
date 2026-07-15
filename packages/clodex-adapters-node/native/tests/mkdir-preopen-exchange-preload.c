#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef int (*mkdirat_function)(int directory_fd, const char *path, mode_t mode);

static mkdirat_function next_mkdirat = NULL;
static bool exchanged = false;

__attribute__((constructor)) static void resolve_next_mkdirat(void) {
  void *symbol = dlsym(RTLD_NEXT, "mkdirat");
  _Static_assert(sizeof(symbol) == sizeof(next_mkdirat), "dlsym size");
  memcpy(&next_mkdirat, &symbol, sizeof(next_mkdirat));
  if (next_mkdirat == NULL) {
    _exit(125);
  }
}

static void record_exchange(void) {
  const char *marker = getenv("CLODEX_TEST_MKDIR_EXCHANGE_MARKER");
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

int mkdirat(int directory_fd, const char *path, mode_t mode) {
  if (next_mkdirat == NULL) {
    _exit(125);
  }
  const int result = next_mkdirat(directory_fd, path, mode);
  if (result < 0 || exchanged) {
    return result;
  }

  const char *trigger = getenv("CLODEX_TEST_MKDIR_TRIGGER");
  const char *target = getenv("CLODEX_TEST_MKDIR_TARGET");
  const char *decoy = getenv("CLODEX_TEST_MKDIR_DECOY");
  if (
    trigger == NULL || *trigger == '\0' || target == NULL || *target == '\0' ||
    decoy == NULL || *decoy == '\0' || strcmp(path, trigger) != 0
  ) {
    return result;
  }

  if (
    syscall(
      SYS_renameat2,
      AT_FDCWD,
      target,
      AT_FDCWD,
      decoy,
      RENAME_EXCHANGE
    ) < 0
  ) {
    _exit(128);
  }
  exchanged = true;
  record_exchange();
  return result;
}
