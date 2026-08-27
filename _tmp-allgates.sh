#!/usr/bin/env bash
# Full gate sweep. Handles BOTH result formats in this repo: "RESULT: N pass,
# M fail" and a bare "GATE PASS" — grepping only for the first silently skipped
# _gate-overlay and reported nothing, which read as a failure and was not one.
cd "C:/Users/jorda/OneDrive/Documents/video-stream" || exit 1
pass=0; fail=0; unknown=0
for g in _gate-*.mjs; do
  [ "$g" = "_gate-helpers.mjs" ] && continue
  out=$(timeout 1500 node "$g" 2>&1)
  line=$(printf '%s\n' "$out" | grep -E "^RESULT:" | tail -1)
  if [ -z "$line" ]; then
    if printf '%s\n' "$out" | grep -q "GATE PASS"; then
      line="GATE PASS"
    else
      line="NO RESULT LINE"
    fi
  fi
  case "$line" in
    *", 0 fail"*|"GATE PASS") printf '%-34s %s\n' "$g" "$line"; pass=$((pass+1)) ;;
    "NO RESULT LINE")         printf '%-34s %s\n' "$g" "$line"; unknown=$((unknown+1))
                              printf '%s\n' "$out" | tail -4 | sed 's/^/      | /' ;;
    *)                        printf '%-34s %s   <-- FAIL\n' "$g" "$line"; fail=$((fail+1))
                              printf '%s\n' "$out" | grep -E "FAIL" | head -4 | sed 's/^/      | /' ;;
  esac
done
echo
echo "════ SWEEP: $pass green, $fail with failures, $unknown unclassified ════"
