#ifndef CLODEX_SHA256_H
#define CLODEX_SHA256_H

#include <stddef.h>
#include <stdint.h>

struct clodex_sha256 {
  uint32_t state[8];
  uint64_t bit_count;
  unsigned char block[64];
  size_t block_length;
};

void clodex_sha256_init(struct clodex_sha256 *context);
void clodex_sha256_update(
  struct clodex_sha256 *context,
  const void *bytes,
  size_t length
);
void clodex_sha256_final(
  struct clodex_sha256 *context,
  unsigned char digest[32]
);
void clodex_sha256_hex(const unsigned char digest[32], char output[65]);

#endif
