#!/bin/sh
# Prints Antigravity CLI's quota as one JSON line, {"quota": <reply>, "plan": "Pro"}, and exits.
#
# Starts `agy acp` with a CSRF token made here, sends initialize and session/list
# (which starts its local language server without creating a conversation), then
# asks that server for RetrieveUserQuotaSummary on its HTTP port. agy
# authenticates itself; this script reads no tokens of yours. The server is
# stopped before exiting.
#
# Exit: 0 = printed a reply, 127 = agy not found, 1 = agy found but no reply.
# Override the binary with HERDR_USAGE_AGY_BIN.

AGY=$(command -v "${HERDR_USAGE_AGY_BIN:-agy}" 2>/dev/null) || AGY="$HOME/.local/bin/agy"
[ -x "$AGY" ] || exit 127

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-ranch-agy.XXXXXX") || exit 1
trap 'exec 3>&- 2>/dev/null; [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$dir"' EXIT
token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
mkfifo "$dir/in" || exit 1
ANTIGRAVITY_CSRF_TOKEN="$token" "$AGY" acp --log-file "$dir/log" <"$dir/in" >"$dir/out" 2>/dev/null &
pid=$!
exec 3>"$dir/in"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' >&3
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"session/list","params":{}}' >&3

# The plain-HTTP port it logs: "Language server listening on random port at N for HTTP".
port=""
i=0
while [ "$i" -lt 75 ]; do
  port=$(grep 'for HTTP$' "$dir/log" 2>/dev/null | sed -n 's/.*port at \([0-9][0-9]*\) for HTTP$/\1/p' | head -1)
  [ -n "$port" ] && break
  kill -0 "$pid" 2>/dev/null || exit 1
  sleep 0.2
  i=$((i + 1))
done
[ -n "$port" ] || exit 1

# Its sign-in can take a moment after the port opens: ask again while it says so.
i=0
while [ "$i" -lt 10 ]; do
  reply=$(curl -s -m 10 -X POST "http://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary" \
    -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' -H "x-codeium-csrf-token: $token" -d '{}')
  case "$reply" in
    *'"response"'*) break ;;
    *'not logged into'*) sleep 0.5 ;;
    *) break ;;
  esac
  i=$((i + 1))
done
[ -n "$reply" ] || exit 1
# The plan's name only (GetUserStatus also carries your name and email: they're not kept).
plan=$(curl -s -m 5 -X POST "http://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/GetUserStatus" \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' -H "x-codeium-csrf-token: $token" -d '{}' \
  | sed -n 's/.*"planName":[ ]*"\([^"]*\)".*/\1/p' | head -1 | tr -cd 'A-Za-z0-9 ._-')
printf '{"quota":%s,"plan":"%s"}\n' "$reply" "$plan"
exit 0
