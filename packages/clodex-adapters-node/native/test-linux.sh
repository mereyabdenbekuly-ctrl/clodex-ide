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

mkdir_pre="$(parse_one_digest "$(invoke inspect-mkdir build - - - 0)")"
mkdir_output="$(invoke execute-mkdir build "$mkdir_pre" - - 0)"
IFS=$'\t' read -r mkdir_status returned_mkdir_pre mkdir_post mkdir_extra \
  <<<"$mkdir_output"
[[ "$mkdir_status" == "OK" && "$returned_mkdir_pre" == "$mkdir_pre" && \
  -z "${mkdir_extra:-}" ]] || fail 'mkdir returned an invalid protocol record'
require_digest "$mkdir_post"
[[ -d "$root/build" && "$(stat -c '%a' "$root/build")" == "700" ]] || \
  fail 'mkdir did not install a mode 0700 directory'

umask_mkdir_pre="$(
  parse_one_digest "$(invoke inspect-mkdir umask-build - - - 0)"
)"
umask_mkdir_output="$(
  (
    umask 0200
    invoke execute-mkdir umask-build "$umask_mkdir_pre" - - 0
  )
)"
IFS=$'\t' read -r umask_mkdir_status returned_umask_mkdir_pre \
  umask_mkdir_post umask_mkdir_extra <<<"$umask_mkdir_output"
[[ "$umask_mkdir_status" == "OK" && \
  "$returned_umask_mkdir_pre" == "$umask_mkdir_pre" && \
  -z "${umask_mkdir_extra:-}" ]] || \
  fail 'umask mkdir returned an invalid protocol record'
require_digest "$umask_mkdir_post"
[[ -d "$root/umask-build" && \
  "$(stat -c '%a' "$root/umask-build")" == "700" ]] || \
  fail 'mkdir did not correct inherited umask to mode 0700'

mkdir_swap_left="$root/mkdir-swap-left"
mkdir_swap_right="$root/mkdir-swap-right"
mkdir -m 700 "$mkdir_swap_left" "$mkdir_swap_right"
mkdir -m 700 "$mkdir_swap_right/created"
decoy_inode="$(stat -c '%i' "$mkdir_swap_right/created")"
mkdir_swap_pre="$(
  parse_one_digest "$(invoke inspect-mkdir mkdir-swap-left/created - - - 0)"
)"
set +e
CLODEX_TEST_SWAP_LEFT="$mkdir_swap_left" \
  CLODEX_TEST_SWAP_RIGHT="$mkdir_swap_right" \
  CLODEX_TEST_SWAP_ACTION='exchange-after-create' \
  CLODEX_TEST_SWAP_ENTRY='created' \
  LD_PRELOAD="$swap_preload" \
  "$helper" --protocol-v1 execute-mkdir "$device" "$inode" \
    mkdir-swap-left/created "$mkdir_swap_pre" - - 0 \
    >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'mkdir parent exchange was not classified as uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'mkdir parent exchange returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || fail 'mkdir parent exchange returned false success'
[[ "$(stat -c '%i' "$mkdir_swap_left/created")" == "$decoy_inode" ]] || \
  fail 'mkdir post-state did not expose the replacement-parent decoy'
[[ -d "$mkdir_swap_right/created" ]] || \
  fail 'mkdir effect was not retained by the originally captured parent'

move_mkdir_left="$root/move-mkdir-left"
move_mkdir_right="$root/move-mkdir-right"
mkdir -m 700 "$move_mkdir_left" "$move_mkdir_right"
move_mkdir_pre="$(
  parse_one_digest "$(invoke inspect-mkdir move-mkdir-left/created - - - 0)"
)"
set +e
CLODEX_TEST_SWAP_LEFT="$move_mkdir_left" \
  CLODEX_TEST_SWAP_RIGHT="$move_mkdir_right" \
  CLODEX_TEST_SWAP_ACTION='move-created-then-exchange' \
  CLODEX_TEST_SWAP_ENTRY='created' \
  LD_PRELOAD="$swap_preload" \
  "$helper" --protocol-v1 execute-mkdir "$device" "$inode" \
    move-mkdir-left/created "$move_mkdir_pre" - - 0 \
    >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'move-then-exchange mkdir did not fail uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'move-then-exchange mkdir returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'move-then-exchange mkdir returned false success'
[[ -d "$move_mkdir_left/created" ]] || \
  fail 'move-then-exchange mkdir did not expose the moved inode'
[[ ! -e "$move_mkdir_right/created" ]] || \
  fail 'move-then-exchange mkdir left the inode in the captured parent'

final_mkdir_left="$root/final-mkdir-left"
final_mkdir_right="$root/final-mkdir-right"
mkdir -m 700 "$final_mkdir_left" "$final_mkdir_right"
final_mkdir_left_inode="$(stat -c '%i' "$final_mkdir_left")"
final_mkdir_right_inode="$(stat -c '%i' "$final_mkdir_right")"
final_mkdir_pre="$(
  parse_one_digest "$(invoke inspect-mkdir final-mkdir-left/created - - - 0)"
)"
set +e
CLODEX_TEST_SWAP_LEFT="$final_mkdir_left" \
  CLODEX_TEST_SWAP_RIGHT="$final_mkdir_right" \
  CLODEX_TEST_SWAP_ACTION='exchange-on-match' \
  CLODEX_TEST_SWAP_TRIGGER='created' \
  CLODEX_TEST_SWAP_MATCH='1' \
  LD_PRELOAD="$swap_preload" \
  "$helper" --protocol-v1 execute-mkdir "$device" "$inode" \
    final-mkdir-left/created "$final_mkdir_pre" - - 0 \
    >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'final-child mkdir parent exchange did not fail uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'final-child mkdir exchange returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'final-child mkdir exchange returned false success'
[[ "$(stat -c '%i' "$final_mkdir_left")" == \
  "$final_mkdir_right_inode" ]] || \
  fail 'final-child mkdir exchange did not replace the visible parent'
[[ "$(stat -c '%i' "$final_mkdir_right")" == \
  "$final_mkdir_left_inode" ]] || \
  fail 'final-child mkdir exchange lost the authorized parent'
[[ ! -e "$final_mkdir_left/created" ]] || \
  fail 'final-child mkdir unexpectedly remained at the visible path'
[[ -d "$final_mkdir_right/created" ]] || \
  fail 'final-child mkdir was not retained by the authorized parent'

metadata_mkdir_parent="$root/metadata-mkdir-parent"
mkdir -m 700 "$metadata_mkdir_parent"
metadata_mkdir_pre="$(
  parse_one_digest "$(
    invoke inspect-mkdir metadata-mkdir-parent/created - - - 0
  )"
)"
set +e
CLODEX_TEST_METADATA_TARGET="$metadata_mkdir_parent/created" \
  CLODEX_TEST_METADATA_TRIGGER='created' \
  CLODEX_TEST_METADATA_MATCH='1' \
  LD_PRELOAD="$metadata_preload" \
  "$helper" --protocol-v1 execute-mkdir "$device" "$inode" \
    metadata-mkdir-parent/created "$metadata_mkdir_pre" - - 0 \
    >"$failure_stdout" 2>"$failure_stderr"
exit_code=$?
set -e
[[ "$exit_code" -eq 20 ]] || \
  fail 'mkdir child metadata drift did not fail uncertain'
grep -Eq $'^ERR\tUNCERTAIN\t[^[:space:]]+$' "$failure_stderr" || \
  fail 'mkdir child metadata drift returned an invalid uncertainty record'
[[ ! -s "$failure_stdout" ]] || \
  fail 'mkdir child metadata drift returned false success'
[[ "$(stat -c '%a' "$metadata_mkdir_parent/created")" == "777" ]] || \
  fail 'mkdir child metadata drift hook did not mutate the created directory'

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
replace_output="$(
  invoke execute-replace created.txt "$replace_pre" "$create_digest" \
    "$replace_digest" "$replace_bytes" <"$replace_input"
)"
IFS=$'\t' read -r replace_execute_status returned_replace_pre replace_post \
  captured_before replace_execute_extra <<<"$replace_output"
[[ "$replace_execute_status" == "OK" && \
  "$returned_replace_pre" == "$replace_pre" && \
  "$captured_before" == "$create_digest" && \
  -z "${replace_execute_extra:-}" ]] || \
  fail 'replace execution returned an invalid record'
require_digest "$replace_post"
cmp -s "$replace_input" "$root/created.txt" || fail 'replace wrote unexpected bytes'

ln "$root/created.txt" "$root/created.alias"
set +e
invoke inspect-replace created.txt - "$replace_digest" - 0 \
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
