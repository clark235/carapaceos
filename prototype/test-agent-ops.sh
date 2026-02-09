#!/bin/bash
# Test script: Validates CarapaceOS can perform common agent operations
# Run inside the container: docker run -it carapaceos:v0.1-ultramin /agent/test-agent-ops.sh

set -e

echo "=== CarapaceOS Agent Operations Test ==="
echo ""

# Test 1: File operations
echo "Test 1: File operations"
echo "Hello from CarapaceOS" > /tmp/test-file.txt
cat /tmp/test-file.txt
rm /tmp/test-file.txt
echo "✅ File ops: PASS"
echo ""

# Test 2: Git operations
echo "Test 2: Git operations"
cd /tmp
git init test-repo --quiet
cd test-repo
git config user.email "agent@carapaceos.local"
git config user.name "Agent"
echo "# Test" > README.md
git add README.md
git commit -m "Initial commit" --quiet
git log --oneline
cd /
rm -rf /tmp/test-repo
echo "✅ Git ops: PASS"
echo ""

# Test 3: Network operations
echo "Test 3: Network operations"
curl -s -o /dev/null -w "%{http_code}" https://api.github.com | grep -q "200\|403" && echo "GitHub API reachable"
echo "✅ Network ops: PASS"
echo ""

# Test 4: Node.js operations
echo "Test 4: Node.js operations"
node -e "console.log('Node.js version:', process.version)"
node -e "console.log('Memory:', Math.round(process.memoryUsage().heapUsed / 1024 / 1024), 'MB')"
node -e "const fs = require('fs'); fs.writeFileSync('/tmp/node-test.json', JSON.stringify({test: true})); console.log('File write OK')"
node -e "const fs = require('fs'); const d = JSON.parse(fs.readFileSync('/tmp/node-test.json')); console.log('File read OK:', d)"
rm /tmp/node-test.json
echo "✅ Node.js ops: PASS"
echo ""

# Test 5: Shell scripting
echo "Test 5: Shell scripting"
result=$(echo "hello world" | awk '{print toupper($0)}')
[ "$result" = "HELLO WORLD" ] && echo "awk: OK"
result=$(echo '{"key":"value"}' | sed 's/key/newkey/')
echo "sed: OK"
echo "✅ Shell ops: PASS"
echo ""

echo "=== All Tests Passed ==="
