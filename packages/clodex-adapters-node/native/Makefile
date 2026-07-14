CC ?= cc
CFLAGS ?= -O2 -pipe
CPPFLAGS ?=

override CFLAGS += -std=c17 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
	-Wall -Wextra -Wconversion -Werror -Wformat=2 -Wshadow -Wstrict-prototypes
override LDFLAGS += -pie -Wl,-z,relro,-z,now,-z,noexecstack

.PHONY: all clean

all: clodex-openat2-helper

clodex-openat2-helper: clodex-openat2-helper.c sha256.c sha256.h
	$(CC) $(CPPFLAGS) $(CFLAGS) clodex-openat2-helper.c sha256.c \
		$(LDFLAGS) -o $@

clean:
	rm -f clodex-openat2-helper
