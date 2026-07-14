#include "sha256.h"

#include <string.h>

static const uint32_t round_constants[64] = {
  0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
  0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
  0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
  0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
  0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
  0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
  0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
  0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
  0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
  0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
  0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
  0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
  0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
  0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
  0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
  0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

static uint32_t rotate_right(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32U - count));
}

static uint32_t load_be32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24U) |
    ((uint32_t)bytes[1] << 16U) |
    ((uint32_t)bytes[2] << 8U) |
    (uint32_t)bytes[3];
}

static void store_be64(unsigned char output[8], uint64_t value) {
  for (unsigned int index = 0; index < 8U; ++index) {
    output[7U - index] = (unsigned char)(value >> (index * 8U));
  }
}

static void transform(struct clodex_sha256 *context) {
  uint32_t words[64];
  for (size_t index = 0; index < 16U; ++index) {
    words[index] = load_be32(context->block + index * 4U);
  }
  for (size_t index = 16U; index < 64U; ++index) {
    const uint32_t s0 = rotate_right(words[index - 15U], 7U) ^
      rotate_right(words[index - 15U], 18U) ^
      (words[index - 15U] >> 3U);
    const uint32_t s1 = rotate_right(words[index - 2U], 17U) ^
      rotate_right(words[index - 2U], 19U) ^
      (words[index - 2U] >> 10U);
    words[index] = words[index - 16U] + s0 + words[index - 7U] + s1;
  }

  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];

  for (size_t index = 0; index < 64U; ++index) {
    const uint32_t upper_e = rotate_right(e, 6U) ^
      rotate_right(e, 11U) ^ rotate_right(e, 25U);
    const uint32_t choose = (e & f) ^ ((~e) & g);
    const uint32_t temporary1 = h + upper_e + choose +
      round_constants[index] + words[index];
    const uint32_t upper_a = rotate_right(a, 2U) ^
      rotate_right(a, 13U) ^ rotate_right(a, 22U);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temporary2 = upper_a + majority;

    h = g;
    g = f;
    f = e;
    e = d + temporary1;
    d = c;
    c = b;
    b = a;
    a = temporary1 + temporary2;
  }

  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

void clodex_sha256_init(struct clodex_sha256 *context) {
  static const uint32_t initial_state[8] = {
    0x6a09e667U,
    0xbb67ae85U,
    0x3c6ef372U,
    0xa54ff53aU,
    0x510e527fU,
    0x9b05688cU,
    0x1f83d9abU,
    0x5be0cd19U,
  };
  memcpy(context->state, initial_state, sizeof(initial_state));
  context->bit_count = 0U;
  context->block_length = 0U;
  memset(context->block, 0, sizeof(context->block));
}

void clodex_sha256_update(
  struct clodex_sha256 *context,
  const void *bytes_value,
  size_t length
) {
  const unsigned char *bytes = bytes_value;
  if (length == 0U) {
    return;
  }
  context->bit_count += (uint64_t)length * 8U;
  while (length > 0U) {
    const size_t available = sizeof(context->block) - context->block_length;
    const size_t copy_length = length < available ? length : available;
    memcpy(context->block + context->block_length, bytes, copy_length);
    context->block_length += copy_length;
    bytes += copy_length;
    length -= copy_length;
    if (context->block_length == sizeof(context->block)) {
      transform(context);
      context->block_length = 0U;
    }
  }
}

void clodex_sha256_final(
  struct clodex_sha256 *context,
  unsigned char digest[32]
) {
  const uint64_t bit_count = context->bit_count;
  const unsigned char one = 0x80U;
  const unsigned char zero = 0U;
  clodex_sha256_update(context, &one, 1U);
  while (context->block_length != 56U) {
    clodex_sha256_update(context, &zero, 1U);
  }
  unsigned char encoded_length[8];
  store_be64(encoded_length, bit_count);
  clodex_sha256_update(context, encoded_length, sizeof(encoded_length));
  for (size_t index = 0; index < 8U; ++index) {
    digest[index * 4U] = (unsigned char)(context->state[index] >> 24U);
    digest[index * 4U + 1U] =
      (unsigned char)(context->state[index] >> 16U);
    digest[index * 4U + 2U] =
      (unsigned char)(context->state[index] >> 8U);
    digest[index * 4U + 3U] = (unsigned char)context->state[index];
  }
  memset(context, 0, sizeof(*context));
}

void clodex_sha256_hex(const unsigned char digest[32], char output[65]) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0; index < 32U; ++index) {
    output[index * 2U] = alphabet[digest[index] >> 4U];
    output[index * 2U + 1U] = alphabet[digest[index] & 0x0fU];
  }
  output[64] = '\0';
}
