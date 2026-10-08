#!/bin/sh
# poll.sh <session> <status-to-stop-on>... — quiet status poller for manual testing
S=$1; shift
for i in $(seq 1 ${POLLS:-25}); do
  st=$(curl -s -m 5 localhost:7788/api/sessions/$S | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["status"])
except Exception: print("unreachable")')
  for want in "$@"; do [ "$st" = "$want" ] && echo "status=$st" && exit 0; done
  sleep 4
done
echo "status=$st (gave up)"; exit 1
