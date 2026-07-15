#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'native helper smoke failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_digest() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] || fail "invalid digest in helper output"
}

parse_one_digest() {
  local output="$1"
  local status digest extra
  IFS=$'\t' read -r status digest extra <<<"$output"
  [[ "$status" == "OK" && -z "${extra:-}" ]] || \
    fail "invalid one-digest protocol record"
  require_digest "$digest"
  printf '%s\n' "$digest"
}

sha256_file() {
  local output
  output="$(sha256sum "$1")"
  printf '%s\n' "${output%% *}"
}

byte_count() {
  wc -c <"$1" | tr -d '[:space:]'
}

if [[ "$(uname -s)" != "Linux" ]]; then
  printf '%s\n' \
    'test-linux.sh requires Linux openat2, renameat2, procfs, and ELF tooling' >&2
  exit 2
fi

for command_name in cc cmp readelf sha256sum stat; do
  require_command "$command_name"
done

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
helper="${1:-$script_directory/clodex-openat2-helper}"
[[ -x "$helper" ]] || fail "helper is not executable: $helper"

elf_header="$(readelf -hW "$helper")"
program_headers="$(readelf -lW "$helper")"
dynamic_section="$(readelf -dW "$helper")"

grep -Eq 'Type:[[:space:]]+DYN' <<<"$elf_header" || \
  fail 'helper is not an ELF position-independent executable'
grep -q 'GNU_RELRO' <<<"$program_headers" || \
  fail 'helper has no GNU_RELRO segment'
grep -Eq 'BIND_NOW|FLAGS.*NOW' <<<"$dynamic_section" || \
  fail 'helper is not linked with immediate binding'
stack_flags="$(
  awk '$1 == "GNU_STACK" { print $(NF - 1); found = 1 } END { if (!found) exit 1 }' \
    <<<"$program_headers"
)" || fail 'helper has no GNU_STACK segment'
[[ "$stack_flags" != *E* ]] || fail 'helper stack is executable'
if grep -q 'TEXTREL' <<<"$dynamic_section"; then
  fail 'helper contains text relocations'
fi

temporary_directory="$(mktemp -d)"
root="$temporary_directory/root"
outside="$temporary_directory/outside"
mkdir -m 700 "$root" "$outside"

cleanup() {
  exec 4<&- || true
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

exec 4<"$root"
device="$(stat -Lc '%d' /proc/self/fd/4)"
inode="$(stat -Lc '%i' /proc/self/fd/4)"

invoke() {
  "$helper" --protocol-v1 "$1" "$device" "$inode" "$2" "$3" "$4" "$5" "$6"
}

failure_stdout="$temporary_directory/failure.stdout"
failure_stderr="$temporary_directory/failure.stderr"

set +e
(
  exec 4<&-
  "$helper" --protocol-v1 tree-commitment "$device" "$inode" '' - - - 0
) >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || fail 'missing root fd 4 did not fail pre-effect'
grep -Eq $'^ERR\tROOT\t[0-9]+$' "$failure_stderr" || \
  fail 'missing root fd 4 returned an invalid error record'
[[ ! -s "$failure_stdout" ]] || fail 'failed root check emitted stdout'

set +e
"$helper" --protocol-v1 tree-commitment "$device" "$((inode + 1))" '' - - - 0 \
  >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || fail 'root identity mismatch did not fail pre-effect'
grep -qx $'ERR\tROOT\tidentity' "$failure_stderr" || \
  fail 'root identity mismatch returned an invalid error record'

ln -s "$outside" "$root/link"
set +e
invoke inspect-create link/escape - - - 0 \
  >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || fail 'symlink traversal did not fail pre-effect'
grep -Eq $'^ERR\tRESOLUTION\t[0-9]+$' "$failure_stderr" || \
  fail 'symlink traversal returned an invalid error record'
[[ ! -e "$outside/escape" ]] || fail 'symlink traversal escaped the held root'
rm "$root/link"

create_input="$temporary_directory/create.input"
printf 'clodex-native-create-v1\n' >"$create_input"
create_digest="$(sha256_file "$create_input")"
create_bytes="$(byte_count "$create_input")"
create_pre="$(parse_one_digest "$(invoke inspect-create created.txt - - - 0)")"
create_output="$(
  invoke execute-create created.txt "$create_pre" - "$create_digest" "$create_bytes" \
    <"$create_input"
)"
IFS=$'\t' read -r create_status returned_create_pre create_post create_extra \
  <<<"$create_output"
[[ "$create_status" == "OK" && "$returned_create_pre" == "$create_pre" && \
  -z "${create_extra:-}" ]] || fail 'create returned an invalid protocol record'
require_digest "$create_post"
cmp -s "$create_input" "$root/created.txt" || fail 'create wrote unexpected bytes'
[[ "$(stat -c '%a' "$root/created.txt")" == "600" ]] || \
  fail 'create did not install mode 0600'

zero_digest="$(printf '0%.0s' {1..64})"
set +e
invoke execute-create rejected.txt "$zero_digest" - "$create_digest" "$create_bytes" \
  <"$create_input" >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || fail 'stale create commitment did not fail pre-effect'
grep -qx $'ERR\tSTATE\tcommitment' "$failure_stderr" || \
  fail 'stale create commitment returned an invalid error record'
[[ ! -e "$root/rejected.txt" ]] || fail 'stale create commitment mutated the root'

swap_preload="$temporary_directory/parent-swap-preload.so"
cc -std=c17 -O2 -fPIC -shared -Wall -Wextra -Wconversion -Werror \
  -Wformat=2 -Wshadow -Wstrict-prototypes \
  "$script_directory/tests/parent-swap-preload.c" -ldl -o "$swap_preload"

metadata_preload="$temporary_directory/child-metadata-drift-preload.so"
cc -std=c17 -O2 -fPIC -shared -Wall -Wextra -Wconversion -Werror \
  -Wformat=2 -Wshadow -Wstrict-prototypes \
  "$script_directory/tests/child-metadata-drift-preload.c" -ldl \
  -o "$metadata_preload"

mkdir_preopen_preload="$temporary_directory/mkdir-preopen-exchange-preload.so"
cc -std=c17 -O2 -fPIC -shared -Wall -Wextra -Wconversion -Werror \
  -Wformat=2 -Wshadow -Wstrict-prototypes \
  "$script_directory/tests/mkdir-preopen-exchange-preload.c" -ldl \
  -o "$mkdir_preopen_preload"

replace_unlink_preload="$temporary_directory/replace-unlink-exchange-preload.so"
cc -std=c17 -O2 -fPIC -shared -Wall -Wextra -Wconversion -Werror \
  -Wformat=2 -Wshadow -Wstrict-prototypes \
  "$script_directory/tests/replace-unlink-exchange-preload.c" -ldl \
  -o "$replace_unlink_preload"

swap_left="$root/swap-left"
swap_right="$root/swap-right"
mkdir -m 700 "$swap_left" "$swap_right"
swap_pre="$(
  parse_one_digest "$(invoke inspect-create swap-left/created.txt - - - 0)"
)"
set +e
CLODEX_TEST_SWAP_LEFT="$swap_left" \
  CLODEX_TEST_SWAP_RIGHT="$swap_right" \
  CLODEX_TEST_SWAP_ACTION='exchange-before-open' \
  CLODEX_TEST_SWAP_TRIGGER='created.txt' \
  LD_PRELOAD="$swap_preload" \
  "$helper" --protocol-v1 execute-create "$device" "$inode" \
    swap-left/created.txt "$swap_pre" - "$create_digest" "$create_bytes" \
    <"$create_input" >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'parent exchange was not classified as an uncertain post-effect failure'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'parent exchange returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || fail 'parent exchange returned false success'
cmp -s "$create_input" "$swap_right/created.txt" || \
  fail 'create did not stay relative to the originally captured parent'
[[ ! -e "$swap_left/created.txt" ]] || \
  fail 'create followed the exchanged visible parent path'

move_create_left="$root/move-create-left"
move_create_right="$root/move-create-right"
mkdir -m 700 "$move_create_left" "$move_create_right"
move_create_pre="$(
  parse_one_digest "$(invoke inspect-create move-create-left/created.txt - - - 0)"
)"
set +e
CLODEX_TEST_SWAP_LEFT="$move_create_left" \
  CLODEX_TEST_SWAP_RIGHT="$move_create_right" \
  CLODEX_TEST_SWAP_ACTION='move-created-then-exchange' \
  CLODEX_TEST_SWAP_ENTRY='created.txt' \
  LD_PRELOAD="$swap_preload" \
  "$helper" --protocol-v1 execute-create "$device" "$inode" \
    move-create-left/created.txt "$move_create_pre" - \
    "$create_digest" "$create_bytes" \
    <"$create_input" >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'move-then-exchange create did not fail uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'move-then-exchange create returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'move-then-exchange create returned false success'
cmp -s "$create_input" "$move_create_left/created.txt" || \
  fail 'move-then-exchange create did not expose the moved inode'
[[ ! -e "$move_create_right/created.txt" ]] || \
  fail 'move-then-exchange create left the inode in the captured parent'

final_create_left="$root/final-create-left"
final_create_right="$root/final-create-right"
mkdir -m 700 "$final_create_left" "$final_create_right"
final_create_left_inode="$(stat -c '%i' "$final_create_left")"
final_create_right_inode="$(stat -c '%i' "$final_create_right")"
final_create_pre="$(
  parse_one_digest "$(invoke inspect-create final-create-left/created - - - 0)"
)"
set +e
CLODEX_TEST_SWAP_LEFT="$final_create_left" \
  CLODEX_TEST_SWAP_RIGHT="$final_create_right" \
  CLODEX_TEST_SWAP_ACTION='exchange-on-match' \
  CLODEX_TEST_SWAP_TRIGGER='created' \
  CLODEX_TEST_SWAP_MATCH='2' \
  LD_PRELOAD="$swap_preload" \
  "$helper" --protocol-v1 execute-create "$device" "$inode" \
    final-create-left/created "$final_create_pre" - \
    "$create_digest" "$create_bytes" \
    <"$create_input" >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'final-child create parent exchange did not fail uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'final-child create exchange returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'final-child create exchange returned false success'
[[ "$(stat -c '%i' "$final_create_left")" == \
  "$final_create_right_inode" ]] || \
  fail 'final-child create exchange did not replace the visible parent'
[[ "$(stat -c '%i' "$final_create_right")" == \
  "$final_create_left_inode" ]] || \
  fail 'final-child create exchange lost the authorized parent'
[[ ! -e "$final_create_left/created" ]] || \
  fail 'final-child create unexpectedly remained at the visible path'
cmp -s "$create_input" "$final_create_right/created" || \
  fail 'final-child create was not retained by the authorized parent'

metadata_create_parent="$root/metadata-create-parent"
mkdir -m 700 "$metadata_create_parent"
metadata_create_pre="$(
  parse_one_digest "$(
    invoke inspect-create metadata-create-parent/created - - - 0
  )"
)"
set +e
CLODEX_TEST_METADATA_TARGET="$metadata_create_parent/created" \
  CLODEX_TEST_METADATA_TRIGGER='created' \
  CLODEX_TEST_METADATA_MATCH='2' \
  LD_PRELOAD="$metadata_preload" \
  "$helper" --protocol-v1 execute-create "$device" "$inode" \
    metadata-create-parent/created "$metadata_create_pre" - \
    "$create_digest" "$create_bytes" \
    <"$create_input" >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'create child metadata drift did not fail uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'create child metadata drift returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'create child metadata drift returned false success'
[[ "$(stat -c '%a' "$metadata_create_parent/created")" == "777" ]] || \
  fail 'create child metadata drift hook did not mutate the created file'

mkdir_window_parent="$root/mkdir-window-parent"
mkdir_window_decoy="$root/mkdir-window-decoy"
mkdir_window_target="$mkdir_window_parent/created"
mkdir_window_hook_marker="$temporary_directory/mkdir-window-hooked"
mkdir -m 700 "$mkdir_window_parent" "$mkdir_window_decoy"
printf 'pre-existing decoy inode\n' >"$mkdir_window_decoy/marker"
mkdir_window_decoy_inode="$(stat -c '%i' "$mkdir_window_decoy")"
mkdir_window_pre="$(
  parse_one_digest "$(
    invoke inspect-mkdir mkdir-window-parent/created - - - 0
  )"
)"
set +e
CLODEX_TEST_MKDIR_TRIGGER='created' \
  CLODEX_TEST_MKDIR_TARGET="$mkdir_window_target" \
  CLODEX_TEST_MKDIR_DECOY="$mkdir_window_decoy" \
  CLODEX_TEST_MKDIR_EXCHANGE_MARKER="$mkdir_window_hook_marker" \
  LD_PRELOAD="$mkdir_preopen_preload" \
  "$helper" --protocol-v1 execute-mkdir "$device" "$inode" \
    mkdir-window-parent/created "$mkdir_window_pre" - - 0 \
    >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
if [[ "$exit_code" -eq 0 ]]; then
  [[ -e "$mkdir_window_hook_marker" ]] || \
    fail 'mkdir pre-open exchange hook did not run in the false-success case'
  [[ -f "$mkdir_window_target/marker" ]] || \
    fail 'mkdir false success did not adopt the pre-existing decoy inode'
  fail 'mkdir pre-open exchange returned false success for the decoy inode'
fi
[[ "$exit_code" -eq 10 ]] || \
  fail 'mkdir pre-open exchange schedule was not rejected pre-effect'
grep -qx $'ERR\tUNSUPPORTED\tmkdir-exact-inode' "$failure_stderr" || \
  fail 'mkdir pre-open exchange returned an invalid error record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'mkdir pre-open exchange emitted unexpected stdout'
[[ ! -e "$mkdir_window_hook_marker" ]] || \
  fail 'disabled mkdir entered the vulnerable mkdirat-to-first-open window'
[[ ! -e "$mkdir_window_target" ]] || \
  fail 'disabled mkdir installed or adopted a target inode'
[[ "$(stat -c '%i' "$mkdir_window_decoy")" == \
  "$mkdir_window_decoy_inode" ]] || \
  fail 'disabled mkdir exchanged the pre-existing decoy inode'
[[ -f "$mkdir_window_decoy/marker" ]] || \
  fail 'disabled mkdir mutated the nonempty decoy directory'

mkdir_pre="$(parse_one_digest "$(invoke inspect-mkdir build - - - 0)")"
set +e
invoke execute-mkdir build "$mkdir_pre" - - 0 \
  >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || \
  fail 'mkdir without a private staging boundary was not rejected pre-effect'
grep -qx $'ERR\tUNSUPPORTED\tmkdir-exact-inode' "$failure_stderr" || \
  fail 'disabled mkdir returned an invalid error record'
[[ ! -s "$failure_stdout" ]] || fail 'disabled mkdir returned false success'
[[ ! -e "$root/build" ]] || fail 'disabled mkdir mutated the workspace'

umask_mkdir_pre="$(
  parse_one_digest "$(invoke inspect-mkdir umask-build - - - 0)"
)"
set +e
(
  umask 0777
  invoke execute-mkdir umask-build "$umask_mkdir_pre" - - 0
) >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || \
  fail 'umask 0777 mkdir was not rejected safely before mutation'
grep -qx $'ERR\tUNSUPPORTED\tmkdir-exact-inode' "$failure_stderr" || \
  fail 'umask 0777 mkdir returned an invalid error record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'umask 0777 mkdir returned false success'
[[ ! -e "$root/umask-build" ]] || \
  fail 'umask 0777 mkdir left a mode-000 effect'

replace_inspect="$(invoke inspect-replace created.txt - "$create_digest" - 0)"
IFS=$'\t' read -r replace_status replace_pre returned_before replace_extra \
  <<<"$replace_inspect"
[[ "$replace_status" == "OK" && "$returned_before" == "$create_digest" && \
  -z "${replace_extra:-}" ]] || fail 'replace inspection returned an invalid record'
require_digest "$replace_pre"

replace_input="$temporary_directory/replace.input"
printf 'clodex-native-replace-v1\n' >"$replace_input"
replace_digest="$(sha256_file "$replace_input")"
replace_bytes="$(byte_count "$replace_input")"

replace_target="$root/unlink-replace-target.txt"
replace_victim="$root/unlink-replace-victim.txt"
replace_unlink_marker="$temporary_directory/replace-unlink-hooked"
printf 'authorized old target\n' >"$replace_target"
printf 'unrelated sibling victim\n' >"$replace_victim"
chmod 0600 "$replace_target" "$replace_victim"
replace_target_before="$(sha256_file "$replace_target")"
replace_target_inode="$(stat -c '%i' "$replace_target")"
replace_victim_before="$(sha256_file "$replace_victim")"
replace_victim_inode="$(stat -c '%i' "$replace_victim")"
replace_unlink_inspect="$(
  invoke inspect-replace unlink-replace-target.txt - \
    "$replace_target_before" - 0
)"
IFS=$'\t' read -r replace_unlink_status replace_unlink_pre \
  replace_unlink_returned_before replace_unlink_extra \
  <<<"$replace_unlink_inspect"
[[ "$replace_unlink_status" == "OK" && \
  "$replace_unlink_returned_before" == "$replace_target_before" && \
  -z "${replace_unlink_extra:-}" ]] || \
  fail 'unlink-race replace inspection returned an invalid record'
require_digest "$replace_unlink_pre"
set +e
CLODEX_TEST_REPLACE_UNLINK_VICTIM="$replace_victim" \
  CLODEX_TEST_REPLACE_UNLINK_MARKER="$replace_unlink_marker" \
  LD_PRELOAD="$replace_unlink_preload" \
  "$helper" --protocol-v1 execute-replace "$device" "$inode" \
    unlink-replace-target.txt "$replace_unlink_pre" "$replace_target_before" \
    "$replace_digest" "$replace_bytes" \
    <"$replace_input" >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
if [[ "$exit_code" -eq 0 ]]; then
  [[ -e "$replace_unlink_marker" ]] || \
    fail 'replace unlink false success did not enter the vulnerable window'
  [[ "$(stat -c '%i' "$replace_victim")" == "$replace_target_inode" ]] || \
    fail 'replace unlink false success did not relocate the old target inode'
  fail 'replace unlink race deleted a sibling inode and returned false success'
fi
[[ "$exit_code" -eq 10 ]] || \
  fail 'replace without a private staging boundary was not rejected pre-effect'
grep -qx $'ERR\tUNSUPPORTED\treplace-private-staging' "$failure_stderr" || \
  fail 'disabled replace returned an invalid error record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'disabled replace emitted unexpected stdout'
[[ ! -e "$replace_unlink_marker" ]] || \
  fail 'disabled replace entered the vulnerable unlinkat window'
[[ "$(stat -c '%i' "$replace_target")" == "$replace_target_inode" ]] || \
  fail 'disabled replace changed the authorized target inode'
[[ "$(sha256_file "$replace_target")" == "$replace_target_before" ]] || \
  fail 'disabled replace changed the authorized target bytes'
[[ "$(stat -c '%i' "$replace_victim")" == "$replace_victim_inode" ]] || \
  fail 'disabled replace changed the sibling victim inode'
[[ "$(sha256_file "$replace_victim")" == "$replace_victim_before" ]] || \
  fail 'disabled replace changed the sibling victim bytes'
if compgen -G "$root/.clodex-replace-v1-*" >/dev/null; then
  fail 'disabled replace created a staging artifact'
fi

ln "$root/created.txt" "$root/created.alias"
set +e
invoke inspect-replace created.txt - "$create_digest" - 0 \
  >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 10 ]] || fail 'hard-linked file did not fail pre-effect'
grep -qx $'ERR\tSTATE\tnot-single-link-file' "$failure_stderr" || \
  fail 'hard-link rejection returned an invalid error record'
rm "$root/created.alias"

tree_first="$(parse_one_digest "$(invoke tree-commitment '' - - - 0)")"
tree_second="$(parse_one_digest "$(invoke tree-commitment '' - - - 0)")"
[[ "$tree_first" == "$tree_second" ]] || fail 'tree commitment is not repeatable'

held_root="$temporary_directory/held-root"
mv "$root" "$held_root"
mkdir -m 700 "$root"
held_pre="$(parse_one_digest "$(invoke inspect-create held-only.txt - - - 0)")"
held_input="$temporary_directory/held.input"
printf 'held-root-object\n' >"$held_input"
held_digest="$(sha256_file "$held_input")"
held_bytes="$(byte_count "$held_input")"
invoke execute-create held-only.txt "$held_pre" - "$held_digest" "$held_bytes" \
  <"$held_input" >/dev/null
[[ -f "$held_root/held-only.txt" && ! -e "$root/held-only.txt" ]] || \
  fail 'helper followed a replaced root path instead of held fd 4'

printf '%s\n' 'native helper Linux smoke passed'
