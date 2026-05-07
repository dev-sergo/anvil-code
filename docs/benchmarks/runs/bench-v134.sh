#!/usr/bin/env bash
# v1.34 bench runner — Phase C
# Usage: bash bench-v134.sh
# Requires: llama-swap running at 172.20.10.4:8080, API started separately

set -euo pipefail

API="http://localhost:3000"
SANDBOX="/Users/admin/Documents/work/rag-system-sandbox"
SANDBOX_ID="917e347a4b0f"
TARGET_ID="58f458a91933"
LOG="/tmp/rag-api-v134.log"

die() { echo "ERROR: $1" >&2; exit 1; }

wait_task() {
  local id="$1"
  local timeout=600
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status
    status=$(curl -sf "$API/task/$id" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")
    if [[ "$status" == "completed" || "$status" == "failed" ]]; then
      echo "$status"
      return
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "timeout"
}

submit_task() {
  local task="$1"
  local project_id="$2"
  local task_id
  task_id=$(curl -sf -X POST "$API/task" \
    -H "Content-Type: application/json" \
    -d "{\"task\": $(echo "$task" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip()))'), \"project\": \"$project_id\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['task_id'])")
  echo "$task_id"
}

index_project() {
  local project_id="$1"
  curl -sf -X POST "$API/index" \
    -H "Content-Type: application/json" \
    -d "{\"project\": \"$project_id\"}" > /dev/null
}

# ── health check ──────────────────────────────────────────────────────────────
echo "=== Health check ==="
curl -sf "$API/health" || die "API not running. Start it first."
echo ""

# ── index sandbox for L1.1/L4.1 ──────────────────────────────────────────────
echo ""
echo "=== Indexing sandbox ($SANDBOX) ==="
index_project "$SANDBOX_ID"
sleep 20
echo "Sandbox indexed."

# ── L1.1 x3 — regression guard ────────────────────────────────────────────────
echo ""
echo "=== L1.1 — Add GET /health (x3, regression guard) ==="
for i in 1 2 3; do
  echo "--- L1.1 run $i ---"
  cd "$SANDBOX" && git checkout main && git reset --hard 24ce9fa 2>/dev/null
  index_project "$SANDBOX_ID" && sleep 15
  START=$SECONDS
  ID=$(submit_task "Add a GET /health endpoint that returns {status: 'ok'}." "$SANDBOX_ID")
  echo "Task ID: $ID"
  STATUS=$(wait_task "$ID")
  WALL=$((SECONDS - START))
  RESULT=$(curl -sf "$API/task/$ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('result') or '')[:200])" 2>/dev/null || echo "")
  echo "Status: $STATUS | Wall: ${WALL}s"
  echo "Result snippet: $RESULT"
  echo "Retrieval (grep log):"
  grep "RAG Planner retrieval" "$LOG" | tail -1 | python3 -c "import sys,json; line=sys.stdin.read(); idx=line.find('{'); print(json.loads(line[idx:]).get('retrievedFiles','')[:300])" 2>/dev/null || echo "(not found in log)"
  echo ""
done

# ── L4.1 x3 — Fixer regression guard ─────────────────────────────────────────
echo ""
echo "=== L4.1 — Fix missing createdAt (x3, Fixer interceptToolCall) ==="
for i in 1 2 3; do
  echo "--- L4.1 run $i ---"
  cd "$SANDBOX" && git checkout bench-l41-baseline 2>/dev/null
  index_project "$SANDBOX_ID" && sleep 15
  START=$SECONDS
  ID=$(submit_task "The POST /users endpoint returns users without a createdAt field. The User interface requires createdAt as a string. Find and fix the bug. Don't change the User interface." "$SANDBOX_ID")
  echo "Task ID: $ID"
  STATUS=$(wait_task "$ID")
  WALL=$((SECONDS - START))
  RESULT=$(curl -sf "$API/task/$ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('result') or '')[:200])" 2>/dev/null || echo "")
  echo "Status: $STATUS | Wall: ${WALL}s"
  echo "Result snippet: $RESULT"
  echo "Untracked test files (should be empty):"
  cd "$SANDBOX" && git status --short | grep "??" || echo "(none)"
  echo ""
done

echo "=== Bench complete. Check $LOG for full retrieval logs. ==="
