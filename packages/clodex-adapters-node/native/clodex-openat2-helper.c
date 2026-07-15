#define _GNU_SOURCE

#include "sha256.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef SYS_openat2
#error "A Linux toolchain with openat2 syscall definitions is required"
#endif

#define CLODEX_ROOT_FD 4
#define MAX_CONTENT_BYTES (256ULL * 1024ULL * 1024ULL)
#define MAX_TREE_BYTES (1024ULL * 1024ULL * 1024ULL)
#define MAX_TREE_ENTRIES 100000ULL
#define MAX_TREE_DEPTH 128U
#define MAX_SELECTOR_BYTES (16U * 1024U)
#define CREATE_PERMISSIONS ((mode_t)0600U)
#define PERMISSION_BITS ((mode_t)07777U)

static bool effect_started = false;

struct file_snapshot {
  int fd;
  struct stat metadata;
  char content_sha256[65];
  char commitment[65];
};

struct parent_reference {
  int fd;
  char selector[MAX_SELECTOR_BYTES + 1U];
  char basename[NAME_MAX + 1U];
  struct stat metadata;
};

struct tree_limits {
  uint64_t entries;
  uint64_t bytes;
  dev_t root_device;
};

static void close_quietly(int descriptor) {
  if (descriptor >= 0) {
    (void)close(descriptor);
  }
}

static void fail_with(const char *code, const char *detail) {
  const char *classification = effect_started ? "UNCERTAIN" : code;
  (void)fprintf(stderr, "ERR\t%s\t%s\n", classification, detail);
  exit(effect_started ? 20 : 10);
}

static void fail_errno(const char *code) {
  char detail[32];
  const int saved_errno = errno;
  const int length = snprintf(detail, sizeof(detail), "%d", saved_errno);
  if (length < 0 || (size_t)length >= sizeof(detail)) {
    fail_with(code, "errno");
  }
  fail_with(code, detail);
}

static bool is_lowercase_digest(const char *value) {
  if (value == NULL || strlen(value) != 64U) {
    return false;
  }
  for (size_t index = 0; index < 64U; ++index) {
    const char byte = value[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) {
      return false;
    }
  }
  return true;
}

static uint64_t parse_u64(const char *value, uint64_t maximum) {
  if (
    value == NULL || *value == '\0' ||
    (value[0] == '0' && value[1] != '\0')
  ) {
    fail_with("ARGUMENT", "integer");
  }
  for (const char *cursor = value; *cursor != '\0'; ++cursor) {
    if (*cursor < '0' || *cursor > '9') {
      fail_with("ARGUMENT", "integer");
    }
  }
  errno = 0;
  char *end = NULL;
  const unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0' || parsed > maximum) {
    fail_with("ARGUMENT", "integer");
  }
  return (uint64_t)parsed;
}

static void validate_selector_path(const char *path, bool allow_empty) {
  if (path == NULL) {
    fail_with("ARGUMENT", "path");
  }
  const size_t length = strlen(path);
  if (length == 0U) {
    if (allow_empty) {
      return;
    }
    fail_with("ARGUMENT", "path");
  }
  if (
    length > MAX_SELECTOR_BYTES || path[0] == '/' ||
    path[length - 1U] == '/' || strchr(path, '\\') != NULL
  ) {
    fail_with("ARGUMENT", "path");
  }
  size_t component_length = 0U;
  const char *component_start = path;
  for (size_t index = 0; index <= length; ++index) {
    const unsigned char byte = (unsigned char)path[index];
    if (index < length && (byte < 0x20U || byte == 0x7fU)) {
      fail_with("ARGUMENT", "path");
    }
    if (index == length || byte == (unsigned char)'/') {
      if (
        component_length == 0U || component_length > NAME_MAX ||
        (component_length == 1U && component_start[0] == '.') ||
        (component_length == 2U && component_start[0] == '.' &&
          component_start[1] == '.')
      ) {
        fail_with("ARGUMENT", "path");
      }
      component_start = path + index + 1U;
      component_length = 0U;
    } else {
      ++component_length;
    }
  }
}

static bool stable_metadata(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev &&
    left->st_ino == right->st_ino &&
    left->st_mode == right->st_mode &&
    left->st_nlink == right->st_nlink &&
    left->st_uid == right->st_uid &&
    left->st_gid == right->st_gid &&
    left->st_size == right->st_size &&
    left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
    left->st_mtim.tv_nsec == right->st_mtim.tv_nsec &&
    left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
    left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static bool has_exact_permissions(
  const struct stat *metadata,
  mode_t expected_permissions
) {
  return (metadata->st_mode & PERMISSION_BITS) == expected_permissions;
}

static bool stable_directory_descriptor(
  int descriptor,
  const struct stat *expected_metadata
) {
  struct stat observed_metadata;
  return fstat(descriptor, &observed_metadata) == 0 &&
    S_ISDIR(observed_metadata.st_mode) &&
    stable_metadata(expected_metadata, &observed_metadata);
}

static int confined_openat2(
  int directory_fd,
  const char *path,
  uint64_t flags,
  uint64_t mode
) {
  const struct open_how how = {
    .flags = flags,
    .mode = mode,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
      RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
  };
  return (int)syscall(
    SYS_openat2,
    directory_fd,
    path,
    &how,
    sizeof(how)
  );
}

static void hash_u64_field(struct clodex_sha256 *hash, uint64_t value) {
  unsigned char encoded[8];
  for (size_t index = 0; index < sizeof(encoded); ++index) {
    encoded[sizeof(encoded) - 1U - index] =
      (unsigned char)(value >> (index * 8U));
  }
  clodex_sha256_update(hash, encoded, sizeof(encoded));
}

static void hash_field(
  struct clodex_sha256 *hash,
  const void *bytes,
  size_t length
) {
  hash_u64_field(hash, (uint64_t)length);
  clodex_sha256_update(hash, bytes, length);
}

static void hash_string_field(struct clodex_sha256 *hash, const char *value) {
  hash_field(hash, value, strlen(value));
}

static void hash_stat_fields(
  struct clodex_sha256 *hash,
  const struct stat *metadata
) {
  hash_u64_field(hash, (uint64_t)metadata->st_dev);
  hash_u64_field(hash, (uint64_t)metadata->st_ino);
  hash_u64_field(hash, (uint64_t)metadata->st_mode);
  hash_u64_field(hash, (uint64_t)metadata->st_nlink);
  hash_u64_field(hash, (uint64_t)metadata->st_uid);
  hash_u64_field(hash, (uint64_t)metadata->st_gid);
  hash_u64_field(hash, (uint64_t)metadata->st_size);
  hash_u64_field(hash, (uint64_t)metadata->st_mtim.tv_sec);
  hash_u64_field(hash, (uint64_t)metadata->st_mtim.tv_nsec);
  hash_u64_field(hash, (uint64_t)metadata->st_ctim.tv_sec);
  hash_u64_field(hash, (uint64_t)metadata->st_ctim.tv_nsec);
}

static void finish_hex(struct clodex_sha256 *hash, char output[65]) {
  unsigned char digest[32];
  clodex_sha256_final(hash, digest);
  clodex_sha256_hex(digest, output);
}

static void hash_fd_contents(
  int descriptor,
  uint64_t maximum_bytes,
  char output[65]
) {
  if (lseek(descriptor, 0, SEEK_SET) < 0) {
    fail_errno("IO");
  }
  struct clodex_sha256 hash;
  clodex_sha256_init(&hash);
  unsigned char buffer[64U * 1024U];
  uint64_t total = 0U;
  for (;;) {
    const ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      fail_errno("IO");
    }
    if (count == 0) {
      break;
    }
    const uint64_t count_u64 = (uint64_t)count;
    if (total > maximum_bytes - count_u64) {
      fail_with("LIMIT", "bytes");
    }
    total += count_u64;
    clodex_sha256_update(&hash, buffer, (size_t)count);
  }
  finish_hex(&hash, output);
}

static void build_file_commitment(
  const struct stat *root_metadata,
  const char *path,
  const struct stat *file_metadata,
  const char *content_sha256,
  char output[65]
) {
  struct clodex_sha256 hash;
  clodex_sha256_init(&hash);
  hash_string_field(&hash, "clodex.openat2-file-state.v1");
  hash_u64_field(&hash, (uint64_t)root_metadata->st_dev);
  hash_u64_field(&hash, (uint64_t)root_metadata->st_ino);
  hash_string_field(&hash, path);
  hash_string_field(&hash, "file");
  hash_stat_fields(&hash, file_metadata);
  hash_string_field(&hash, content_sha256);
  finish_hex(&hash, output);
}

static void open_parent_reference(
  int root_fd,
  const char *path,
  struct parent_reference *result
) {
  const char *separator = strrchr(path, '/');
  const char *basename = separator == NULL ? path : separator + 1;
  const size_t basename_length = strlen(basename);
  if (basename_length == 0U || basename_length > NAME_MAX) {
    fail_with("ARGUMENT", "basename");
  }
  memcpy(result->basename, basename, basename_length + 1U);

  if (separator == NULL) {
    memcpy(result->selector, ".", 2U);
    result->fd = fcntl(root_fd, F_DUPFD_CLOEXEC, 5);
  } else {
    const size_t parent_length = (size_t)(separator - path);
    if (parent_length > MAX_SELECTOR_BYTES) {
      fail_with("ARGUMENT", "parent");
    }
    memcpy(result->selector, path, parent_length);
    result->selector[parent_length] = '\0';
    result->fd = confined_openat2(
      root_fd,
      result->selector,
      (uint64_t)(O_RDONLY | O_DIRECTORY | O_CLOEXEC),
      0U
    );
  }
  if (result->fd < 0) {
    fail_errno(errno == ENOSYS ? "UNSUPPORTED" : "RESOLUTION");
  }
  if (fstat(result->fd, &result->metadata) < 0) {
    fail_errno("IO");
  }
  if (!S_ISDIR(result->metadata.st_mode)) {
    fail_with("RESOLUTION", "parent");
  }
}

static int reopen_verified_parent(
  int root_fd,
  const struct parent_reference *authorized_parent,
  const struct stat *post_effect_metadata,
  const char *failure_detail
) {
  const int visible_parent = confined_openat2(
    root_fd,
    authorized_parent->selector,
    (uint64_t)(O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW),
    0U
  );
  if (visible_parent < 0) {
    fail_with("UNCERTAIN", failure_detail);
  }
  struct stat visible_metadata;
  if (
    fstat(visible_parent, &visible_metadata) < 0 ||
    !S_ISDIR(visible_metadata.st_mode) ||
    !stable_metadata(post_effect_metadata, &visible_metadata)
  ) {
    close_quietly(visible_parent);
    fail_with("UNCERTAIN", failure_detail);
  }
  return visible_parent;
}

static void capture_post_effect_parent_metadata(
  const struct parent_reference *parent,
  struct stat *output,
  const char *failure_detail
) {
  if (
    fstat(parent->fd, output) < 0 ||
    !S_ISDIR(output->st_mode) ||
    output->st_dev != parent->metadata.st_dev ||
    output->st_ino != parent->metadata.st_ino
  ) {
    fail_with("UNCERTAIN", failure_detail);
  }
}

static void capture_absent_state(
  int root_fd,
  const struct stat *root_metadata,
  const char *path,
  struct parent_reference *parent,
  char output[65]
) {
  open_parent_reference(root_fd, path, parent);
  struct stat target;
  if (fstatat(parent->fd, parent->basename, &target, AT_SYMLINK_NOFOLLOW) == 0) {
    fail_with("STATE", "exists");
  }
  if (errno != ENOENT) {
    fail_errno("RESOLUTION");
  }
  struct stat parent_after;
  if (fstat(parent->fd, &parent_after) < 0) {
    fail_errno("IO");
  }
  if (!stable_metadata(&parent->metadata, &parent_after)) {
    fail_with("STATE", "parent-drift");
  }
  struct clodex_sha256 hash;
  clodex_sha256_init(&hash);
  hash_string_field(&hash, "clodex.openat2-absent-state.v1");
  hash_u64_field(&hash, (uint64_t)root_metadata->st_dev);
  hash_u64_field(&hash, (uint64_t)root_metadata->st_ino);
  hash_string_field(&hash, path);
  hash_string_field(&hash, "absent");
  hash_u64_field(&hash, (uint64_t)parent->metadata.st_dev);
  hash_u64_field(&hash, (uint64_t)parent->metadata.st_ino);
  finish_hex(&hash, output);
}

static void capture_open_file_state(
  const struct stat *root_metadata,
  const char *path,
  struct file_snapshot *snapshot
) {
  struct stat before;
  if (fstat(snapshot->fd, &before) < 0) {
    fail_errno("IO");
  }
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1U) {
    fail_with("STATE", "not-single-link-file");
  }
  if (before.st_size < 0 || (uint64_t)before.st_size > MAX_TREE_BYTES) {
    fail_with("LIMIT", "file-size");
  }
  hash_fd_contents(snapshot->fd, MAX_TREE_BYTES, snapshot->content_sha256);
  struct stat after;
  if (fstat(snapshot->fd, &after) < 0) {
    fail_errno("IO");
  }
  if (!stable_metadata(&before, &after)) {
    fail_with("STATE", "file-drift");
  }
  snapshot->metadata = after;
  build_file_commitment(
    root_metadata,
    path,
    &snapshot->metadata,
    snapshot->content_sha256,
    snapshot->commitment
  );
}

static void capture_file_state(
  int root_fd,
  const struct stat *root_metadata,
  const char *path,
  struct file_snapshot *snapshot
) {
  snapshot->fd = confined_openat2(
    root_fd,
    path,
    (uint64_t)(O_RDONLY | O_CLOEXEC | O_NOFOLLOW),
    0U
  );
  if (snapshot->fd < 0) {
    fail_errno(errno == ENOSYS ? "UNSUPPORTED" : "RESOLUTION");
  }
  capture_open_file_state(root_metadata, path, snapshot);
}

static void write_exact_stdin(
  int destination_fd,
  uint64_t expected_bytes,
  const char *expected_sha256
) {
  struct clodex_sha256 hash;
  clodex_sha256_init(&hash);
  unsigned char buffer[64U * 1024U];
  uint64_t remaining = expected_bytes;
  while (remaining > 0U) {
    const size_t requested = remaining < (uint64_t)sizeof(buffer)
      ? (size_t)remaining
      : sizeof(buffer);
    const ssize_t count = read(STDIN_FILENO, buffer, requested);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      fail_errno("IO");
    }
    if (count == 0) {
      fail_with("CONTENT", "truncated");
    }
    clodex_sha256_update(&hash, buffer, (size_t)count);
    size_t written = 0U;
    while (written < (size_t)count) {
      const ssize_t write_count = write(
        destination_fd,
        buffer + written,
        (size_t)count - written
      );
      if (write_count < 0) {
        if (errno == EINTR) {
          continue;
        }
        fail_errno("IO");
      }
      if (write_count == 0) {
        fail_with("IO", "short-write");
      }
      written += (size_t)write_count;
    }
    remaining -= (uint64_t)count;
  }
  unsigned char trailing;
  for (;;) {
    const ssize_t count = read(STDIN_FILENO, &trailing, 1U);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count < 0) {
      fail_errno("IO");
    }
    if (count != 0) {
      fail_with("CONTENT", "trailing");
    }
    break;
  }
  char digest[65];
  finish_hex(&hash, digest);
  if (strcmp(digest, expected_sha256) != 0) {
    fail_with("CONTENT", "digest");
  }
}

static void sync_parent(const struct parent_reference *parent) {
  if (fsync(parent->fd) < 0) {
    fail_errno("IO");
  }
}

static void inspect_create_or_mkdir(
  int root_fd,
  const struct stat *root_metadata,
  const char *path
) {
  struct parent_reference parent = { .fd = -1 };
  char commitment[65];
  capture_absent_state(root_fd, root_metadata, path, &parent, commitment);
  close_quietly(parent.fd);
  (void)printf("OK\t%s\n", commitment);
}

static void inspect_replace(
  int root_fd,
  const struct stat *root_metadata,
  const char *path,
  const char *before_sha256
) {
  struct file_snapshot snapshot = { .fd = -1 };
  capture_file_state(root_fd, root_metadata, path, &snapshot);
  if (strcmp(snapshot.content_sha256, before_sha256) != 0) {
    close_quietly(snapshot.fd);
    fail_with("STATE", "content");
  }
  close_quietly(snapshot.fd);
  (void)printf(
    "OK\t%s\t%s\n",
    snapshot.commitment,
    snapshot.content_sha256
  );
}

static void execute_create(
  int root_fd,
  const struct stat *root_metadata,
  const char *path,
  const char *expected_commitment,
  const char *content_sha256,
  uint64_t content_bytes
) {
  struct parent_reference parent = { .fd = -1 };
  char pre_commitment[65];
  capture_absent_state(
    root_fd,
    root_metadata,
    path,
    &parent,
    pre_commitment
  );
  if (strcmp(pre_commitment, expected_commitment) != 0) {
    close_quietly(parent.fd);
    fail_with("STATE", "commitment");
  }

  effect_started = true;
  const int destination = confined_openat2(
    parent.fd,
    parent.basename,
    (uint64_t)(O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW),
    CREATE_PERMISSIONS
  );
  if (destination < 0) {
    close_quietly(parent.fd);
    fail_errno(errno == ENOSYS ? "UNSUPPORTED" : "IO");
  }
  write_exact_stdin(destination, content_bytes, content_sha256);
  if (fchmod(destination, CREATE_PERMISSIONS) < 0 || fsync(destination) < 0) {
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_errno("IO");
  }
  struct stat created_metadata;
  struct stat committed_parent_entry;
  if (
    fstat(destination, &created_metadata) < 0 ||
    !S_ISREG(created_metadata.st_mode) || created_metadata.st_nlink != 1U ||
    !has_exact_permissions(&created_metadata, CREATE_PERMISSIONS) ||
    fstatat(
      parent.fd,
      parent.basename,
      &committed_parent_entry,
      AT_SYMLINK_NOFOLLOW
    ) < 0 ||
    !S_ISREG(committed_parent_entry.st_mode) ||
    committed_parent_entry.st_nlink != 1U ||
    !has_exact_permissions(&committed_parent_entry, CREATE_PERMISSIONS) ||
    !stable_metadata(&created_metadata, &committed_parent_entry)
  ) {
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_with("UNCERTAIN", "create-parent-drift");
  }
  sync_parent(&parent);

  struct stat parent_post_effect_metadata;
  capture_post_effect_parent_metadata(
    &parent,
    &parent_post_effect_metadata,
    "create-parent-post-state"
  );

  const int visible_parent = reopen_verified_parent(
    root_fd,
    &parent,
    &parent_post_effect_metadata,
    "create-final-parent-drift"
  );
  struct file_snapshot post = { .fd = -1 };
  post.fd = confined_openat2(
    visible_parent,
    parent.basename,
    (uint64_t)(O_RDONLY | O_CLOEXEC | O_NOFOLLOW),
    0U
  );
  if (post.fd < 0) {
    close_quietly(visible_parent);
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_with("UNCERTAIN", "create-final-child-resolution");
  }
  capture_open_file_state(root_metadata, path, &post);
  struct stat held_created_metadata;
  if (
    fstat(destination, &held_created_metadata) < 0 ||
    !S_ISREG(held_created_metadata.st_mode) ||
    held_created_metadata.st_nlink != 1U ||
    !has_exact_permissions(&held_created_metadata, CREATE_PERMISSIONS) ||
    !has_exact_permissions(&post.metadata, CREATE_PERMISSIONS) ||
    !stable_metadata(&created_metadata, &held_created_metadata) ||
    !stable_metadata(&created_metadata, &post.metadata) ||
    strcmp(post.content_sha256, content_sha256) != 0
  ) {
    close_quietly(post.fd);
    close_quietly(visible_parent);
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_with("UNCERTAIN", "create-final-child-drift");
  }

  if (
    !stable_directory_descriptor(
      parent.fd,
      &parent_post_effect_metadata
    ) ||
    !stable_directory_descriptor(
      visible_parent,
      &parent_post_effect_metadata
    )
  ) {
    close_quietly(post.fd);
    close_quietly(visible_parent);
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_with("UNCERTAIN", "create-final-parent-drift");
  }

  const int final_visible_parent = reopen_verified_parent(
    root_fd,
    &parent,
    &parent_post_effect_metadata,
    "create-final-parent-drift"
  );
  const int final_child = confined_openat2(
    final_visible_parent,
    parent.basename,
    (uint64_t)(O_RDONLY | O_CLOEXEC | O_NOFOLLOW),
    0U
  );
  if (final_child < 0) {
    close_quietly(final_visible_parent);
    close_quietly(post.fd);
    close_quietly(visible_parent);
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_with("UNCERTAIN", "create-final-child-resolution");
  }
  struct stat final_child_metadata;
  if (
    fstat(final_child, &final_child_metadata) < 0 ||
    !S_ISREG(final_child_metadata.st_mode) ||
    final_child_metadata.st_nlink != 1U ||
    !has_exact_permissions(&final_child_metadata, CREATE_PERMISSIONS) ||
    !stable_metadata(&created_metadata, &final_child_metadata) ||
    !stable_metadata(&post.metadata, &final_child_metadata) ||
    !stable_directory_descriptor(
      parent.fd,
      &parent_post_effect_metadata
    ) ||
    !stable_directory_descriptor(
      visible_parent,
      &parent_post_effect_metadata
    ) ||
    !stable_directory_descriptor(
      final_visible_parent,
      &parent_post_effect_metadata
    )
  ) {
    close_quietly(final_child);
    close_quietly(final_visible_parent);
    close_quietly(post.fd);
    close_quietly(visible_parent);
    close_quietly(destination);
    close_quietly(parent.fd);
    fail_with("UNCERTAIN", "create-final-binding-drift");
  }
  close_quietly(final_child);
  close_quietly(final_visible_parent);
  close_quietly(post.fd);
  close_quietly(visible_parent);
  close_quietly(destination);
  close_quietly(parent.fd);
  (void)printf("OK\t%s\t%s\n", pre_commitment, post.commitment);
}

static void execute_mkdir(
  int root_fd,
  const struct stat *root_metadata,
  const char *path,
  const char *expected_commitment
) {
  (void)root_fd;
  (void)root_metadata;
  (void)path;
  (void)expected_commitment;
  /*
   * mkdirat(2) returns no descriptor.  In an attacker-writable parent, any
   * lookup after mkdirat can therefore adopt a decoy inode installed between
   * the syscall return and the first open.  The v1 helper has no separately
   * provisioned, same-filesystem staging directory owned by a distinct
   * Guardian principal, so it cannot make the exact-created-inode guarantee.
   * Keep execution fail-closed and pre-effect until that trust boundary is an
   * explicit pinned input; inspection remains available for policy planning.
   */
  fail_with("UNSUPPORTED", "mkdir-exact-inode");
}

static void execute_replace(
  int root_fd,
  const struct stat *root_metadata,
  const char *path,
  const char *expected_commitment,
  const char *before_sha256,
  const char *content_sha256,
  uint64_t content_bytes
) {
  (void)root_fd;
  (void)root_metadata;
  (void)path;
  (void)expected_commitment;
  (void)before_sha256;
  (void)content_sha256;
  (void)content_bytes;
  /*
   * The v1 helper exchanges the old target into a name in the same mutable
   * parent before disposing it.  unlinkat(2) addresses only that name, not the
   * inode previously validated there, so a concurrent writer can exchange a
   * sibling victim into the disposal name after validation and make the helper
   * unlink the wrong inode.  Re-stat'ing the name cannot close the final
   * lookup-to-unlink window.
   *
   * A sound implementation requires a pinned, private same-filesystem staging
   * directory that the competing workspace principal cannot rename into.  No
   * such directory/principal is part of protocol v1.  Reject execution before
   * reading stdin or creating a staging file; inspect-replace remains available
   * only for non-authorizing policy planning.
   */
  fail_with("UNSUPPORTED", "replace-private-staging");
}

static int compare_names(const void *left_value, const void *right_value) {
  const char *const *left = left_value;
  const char *const *right = right_value;
  return strcmp(*left, *right);
}

static char *join_tree_path(const char *prefix, const char *name) {
  const size_t prefix_length = strlen(prefix);
  const size_t name_length = strlen(name);
  const size_t separator_length = prefix_length == 0U ? 0U : 1U;
  if (
    prefix_length > MAX_SELECTOR_BYTES ||
    name_length > MAX_SELECTOR_BYTES ||
    prefix_length + separator_length + name_length > MAX_SELECTOR_BYTES
  ) {
    fail_with("LIMIT", "tree-path");
  }
  char *result = malloc(
    prefix_length + separator_length + name_length + 1U
  );
  if (result == NULL) {
    fail_errno("IO");
  }
  memcpy(result, prefix, prefix_length);
  size_t offset = prefix_length;
  if (separator_length != 0U) {
    result[offset++] = '/';
  }
  memcpy(result + offset, name, name_length + 1U);
  return result;
}

static void update_tree_entry(
  struct clodex_sha256 *hash,
  const char *path,
  const char *kind,
  const struct stat *metadata,
  const char *content_sha256
) {
  hash_string_field(hash, path);
  hash_string_field(hash, kind);
  hash_stat_fields(hash, metadata);
  if (content_sha256 != NULL) {
    hash_string_field(hash, content_sha256);
  }
}

static void walk_tree(
  struct clodex_sha256 *hash,
  int directory_fd,
  const char *prefix,
  unsigned int depth,
  struct tree_limits *limits
) {
  if (depth > MAX_TREE_DEPTH) {
    fail_with("LIMIT", "tree-depth");
  }
  struct stat directory_before;
  if (fstat(directory_fd, &directory_before) < 0) {
    fail_errno("IO");
  }
  if (
    !S_ISDIR(directory_before.st_mode) ||
    directory_before.st_dev != limits->root_device
  ) {
    fail_with("STATE", "tree-directory");
  }

  /*
   * A dup shares the directory stream offset with the held capability fd and
   * would make repeated or concurrent commitments observe EOF.  Open the
   * already-held directory itself to obtain an independent file description,
   * then rewind fail-closed before handing it to fdopendir.
   */
  const int iteration_fd = openat(
    directory_fd,
    ".",
    O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW
  );
  if (iteration_fd < 0) {
    fail_errno("IO");
  }
  if (lseek(iteration_fd, 0, SEEK_SET) < 0) {
    close_quietly(iteration_fd);
    fail_errno("IO");
  }
  DIR *directory = fdopendir(iteration_fd);
  if (directory == NULL) {
    close_quietly(iteration_fd);
    fail_errno("IO");
  }
  char **names = NULL;
  size_t names_length = 0U;
  size_t names_capacity = 0U;
  errno = 0;
  for (;;) {
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      if (errno != 0) {
        (void)closedir(directory);
        fail_errno("IO");
      }
      break;
    }
    if (
      strcmp(entry->d_name, ".") == 0 ||
      strcmp(entry->d_name, "..") == 0
    ) {
      continue;
    }
    if (
      limits->entries >= MAX_TREE_ENTRIES ||
      (uint64_t)names_length >= MAX_TREE_ENTRIES - limits->entries
    ) {
      (void)closedir(directory);
      fail_with("LIMIT", "tree-entries");
    }
    const size_t name_length = strlen(entry->d_name);
    if (name_length == 0U || name_length > NAME_MAX) {
      (void)closedir(directory);
      fail_with("STATE", "tree-name");
    }
    for (size_t index = 0U; index < name_length; ++index) {
      const unsigned char byte = (unsigned char)entry->d_name[index];
      if (byte < 0x20U || byte == 0x7fU || byte == (unsigned char)'\\') {
        (void)closedir(directory);
        fail_with("STATE", "tree-name");
      }
    }
    if (names_length == names_capacity) {
      const size_t next_capacity = names_capacity == 0U
        ? 32U
        : names_capacity * 2U;
      char **next = realloc(names, next_capacity * sizeof(*next));
      if (next == NULL) {
        (void)closedir(directory);
        fail_errno("IO");
      }
      names = next;
      names_capacity = next_capacity;
    }
    names[names_length] = strdup(entry->d_name);
    if (names[names_length] == NULL) {
      (void)closedir(directory);
      fail_errno("IO");
    }
    ++names_length;
  }
  if (closedir(directory) < 0) {
    fail_errno("IO");
  }
  qsort(names, names_length, sizeof(*names), compare_names);

  for (size_t index = 0U; index < names_length; ++index) {
    if (++limits->entries > MAX_TREE_ENTRIES) {
      fail_with("LIMIT", "tree-entries");
    }
    char *child_path = join_tree_path(prefix, names[index]);
    struct stat metadata;
    if (
      fstatat(directory_fd, names[index], &metadata, AT_SYMLINK_NOFOLLOW) < 0
    ) {
      free(child_path);
      fail_errno("IO");
    }
    if (metadata.st_dev != limits->root_device) {
      free(child_path);
      fail_with("STATE", "mount-crossing");
    }
    if (S_ISREG(metadata.st_mode)) {
      if (metadata.st_nlink != 1U || metadata.st_size < 0) {
        free(child_path);
        fail_with("STATE", "tree-file-alias");
      }
      const uint64_t file_size = (uint64_t)metadata.st_size;
      if (limits->bytes > MAX_TREE_BYTES - file_size) {
        free(child_path);
        fail_with("LIMIT", "tree-bytes");
      }
      limits->bytes += file_size;
      const int file_fd = confined_openat2(
        directory_fd,
        names[index],
        (uint64_t)(O_RDONLY | O_CLOEXEC | O_NOFOLLOW),
        0U
      );
      if (file_fd < 0) {
        free(child_path);
        fail_errno(errno == ENOSYS ? "UNSUPPORTED" : "RESOLUTION");
      }
      struct stat before;
      if (fstat(file_fd, &before) < 0) {
        close_quietly(file_fd);
        free(child_path);
        fail_errno("IO");
      }
      char content_sha256[65];
      hash_fd_contents(file_fd, MAX_TREE_BYTES, content_sha256);
      struct stat after;
      if (fstat(file_fd, &after) < 0 || !stable_metadata(&before, &after)) {
        close_quietly(file_fd);
        free(child_path);
        fail_with("STATE", "tree-file-drift");
      }
      update_tree_entry(
        hash,
        child_path,
        "file",
        &after,
        content_sha256
      );
      close_quietly(file_fd);
    } else if (S_ISDIR(metadata.st_mode)) {
      const int child_fd = confined_openat2(
        directory_fd,
        names[index],
        (uint64_t)(O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW),
        0U
      );
      if (child_fd < 0) {
        free(child_path);
        fail_errno(errno == ENOSYS ? "UNSUPPORTED" : "RESOLUTION");
      }
      struct stat opened_metadata;
      if (fstat(child_fd, &opened_metadata) < 0) {
        close_quietly(child_fd);
        free(child_path);
        fail_errno("IO");
      }
      if (
        opened_metadata.st_dev != metadata.st_dev ||
        opened_metadata.st_ino != metadata.st_ino
      ) {
        close_quietly(child_fd);
        free(child_path);
        fail_with("STATE", "tree-directory-drift");
      }
      update_tree_entry(
        hash,
        child_path,
        "directory",
        &opened_metadata,
        NULL
      );
      walk_tree(hash, child_fd, child_path, depth + 1U, limits);
      close_quietly(child_fd);
    } else {
      free(child_path);
      fail_with("STATE", "tree-special-file");
    }
    free(child_path);
    free(names[index]);
  }
  free(names);

  struct stat directory_after;
  if (
    fstat(directory_fd, &directory_after) < 0 ||
    !stable_metadata(&directory_before, &directory_after)
  ) {
    fail_with("STATE", "tree-directory-drift");
  }
}

static void tree_commitment(int root_fd, const struct stat *root_metadata) {
  struct clodex_sha256 hash;
  clodex_sha256_init(&hash);
  hash_string_field(&hash, "clodex.openat2-tree-state.v1");
  hash_stat_fields(&hash, root_metadata);
  struct tree_limits limits = {
    .entries = 0U,
    .bytes = 0U,
    .root_device = root_metadata->st_dev,
  };
  walk_tree(&hash, root_fd, "", 0U, &limits);
  hash_u64_field(&hash, limits.entries);
  hash_u64_field(&hash, limits.bytes);
  char commitment[65];
  finish_hex(&hash, commitment);
  (void)printf("OK\t%s\n", commitment);
}

int main(int argc, char **argv) {
  if (argc != 10 || strcmp(argv[1], "--protocol-v1") != 0) {
    fail_with("ARGUMENT", "protocol");
  }
  const char *operation = argv[2];
  const uint64_t expected_device = parse_u64(argv[3], UINT64_MAX);
  const uint64_t expected_inode = parse_u64(argv[4], UINT64_MAX);
  const char *path = argv[5];
  const char *expected_commitment = argv[6];
  const char *before_sha256 = argv[7];
  const char *content_sha256 = argv[8];
  const uint64_t content_bytes = parse_u64(argv[9], MAX_CONTENT_BYTES);

  const bool is_tree = strcmp(operation, "tree-commitment") == 0;
  validate_selector_path(path, is_tree);
  struct stat root_metadata;
  if (fstat(CLODEX_ROOT_FD, &root_metadata) < 0) {
    fail_errno("ROOT");
  }
  if (
    !S_ISDIR(root_metadata.st_mode) ||
    (uint64_t)root_metadata.st_dev != expected_device ||
    (uint64_t)root_metadata.st_ino != expected_inode
  ) {
    fail_with("ROOT", "identity");
  }

  if (strcmp(operation, "inspect-create") == 0) {
    inspect_create_or_mkdir(CLODEX_ROOT_FD, &root_metadata, path);
  } else if (strcmp(operation, "inspect-mkdir") == 0) {
    inspect_create_or_mkdir(CLODEX_ROOT_FD, &root_metadata, path);
  } else if (strcmp(operation, "inspect-replace") == 0) {
    if (!is_lowercase_digest(before_sha256)) {
      fail_with("ARGUMENT", "before-digest");
    }
    inspect_replace(
      CLODEX_ROOT_FD,
      &root_metadata,
      path,
      before_sha256
    );
  } else if (strcmp(operation, "execute-create") == 0) {
    if (
      !is_lowercase_digest(expected_commitment) ||
      !is_lowercase_digest(content_sha256)
    ) {
      fail_with("ARGUMENT", "digest");
    }
    execute_create(
      CLODEX_ROOT_FD,
      &root_metadata,
      path,
      expected_commitment,
      content_sha256,
      content_bytes
    );
  } else if (strcmp(operation, "execute-mkdir") == 0) {
    if (!is_lowercase_digest(expected_commitment) || content_bytes != 0U) {
      fail_with("ARGUMENT", "mkdir");
    }
    execute_mkdir(
      CLODEX_ROOT_FD,
      &root_metadata,
      path,
      expected_commitment
    );
  } else if (strcmp(operation, "execute-replace") == 0) {
    if (
      !is_lowercase_digest(expected_commitment) ||
      !is_lowercase_digest(before_sha256) ||
      !is_lowercase_digest(content_sha256)
    ) {
      fail_with("ARGUMENT", "digest");
    }
    execute_replace(
      CLODEX_ROOT_FD,
      &root_metadata,
      path,
      expected_commitment,
      before_sha256,
      content_sha256,
      content_bytes
    );
  } else if (is_tree) {
    if (content_bytes != 0U) {
      fail_with("ARGUMENT", "tree");
    }
    tree_commitment(CLODEX_ROOT_FD, &root_metadata);
  } else {
    fail_with("ARGUMENT", "operation");
  }

  if (fflush(stdout) != 0) {
    fail_errno("IO");
  }
  return 0;
}
