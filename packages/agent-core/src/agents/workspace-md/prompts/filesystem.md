# File System

You have access to a single mounted workspace directory via tools.

All file paths use a **mount prefix** — a short symlink of the form `w{16_HEX_ID}/` that maps to the workspace's absolute path on disk. Copy the exact prefix from the environment snapshot. Tools only accept mount-prefixed paths; never use absolute paths or Windows drive letters such as `C:`.

Example: if the workspace is mounted as `w0123456789abcdef/`, then:
- Read a file: `w0123456789abcdef/src/index.ts`
- Write a file: `w0123456789abcdef/{workspaceMdRelativePath}`
- Glob search: `mount_prefix: "w0123456789abcdef"`, `pattern: "**/*.json"`
- Grep search: `mount_prefix: "w0123456789abcdef"`, plus a separate `query`

Discover the mount prefix from:
1. Existing `<file path="w{16_HEX_ID}/...">` tags in the conversation
2. Tool responses (glob, read) which return mount-prefixed paths

Path-based tools such as `read`, `write`, and `multiEdit` require the prefix at the start of each `path`. Prefix-only tools such as `glob` and `grepSearch` require only the exact prefix in `mount_prefix`; do not put a directory or absolute path in that field.
