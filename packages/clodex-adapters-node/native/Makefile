CC ?= cc
CFLAGS ?= -O2 -pipe
CPPFLAGS ?=
UNAME_S := $(shell uname -s 2>/dev/null || printf Unknown)

override CFLAGS += -std=c17 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
	-Wall -Wextra -Wconversion -Werror -Wformat=2 -Wshadow -Wstrict-prototypes
override LDFLAGS += -pie -Wl,-z,relro,-z,now,-z,noexecstack

.PHONY: all check-linux clean test

all: clodex-openat2-helper

check-linux:
	@if [ "$(UNAME_S)" != "Linux" ]; then \
		printf '%s\n' \
			'clodex-openat2-helper is Linux-only (openat2, renameat2, and procfs are required)' >&2; \
		exit 2; \
	fi

clodex-openat2-helper: clodex-openat2-helper.c sha256.c sha256.h | check-linux
	$(CC) $(CPPFLAGS) $(CFLAGS) clodex-openat2-helper.c sha256.c \
		$(LDFLAGS) -o $@

test: clodex-openat2-helper
	./test-linux.sh ./clodex-openat2-helper

clean:
	rm -f clodex-openat2-helper
