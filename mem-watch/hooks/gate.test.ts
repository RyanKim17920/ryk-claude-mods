// Kept byte-identical in mem-watch/hooks/gate.test.ts and storage-watch/hooks/gate.test.ts, like gate.ts (scripts/check-twins.sh).
import { expect, test } from 'claude-code/testing'

import { asStoredCulprits, classifyBash, culpritsLine, HEAVY_RULES, heavyWork, isFresh, isHelp, normalize, parse, parseLightSubcommands, parseMode, parsePatterns, parseSize, refusalReason, refusalToast, segments, STALE_INTERVALS, unwrap } from './gate'

/** The old gate: only commands matching a heavy-work rule are refused. */
const PATTERNS = { mode: 'patterns' } as const

// ---- patterns mode ----

const BLOCKED: readonly string[] = [
  'docker run --rm -it ubuntu bash',
  'docker container run x',
  'docker compose up -d',
  'docker-compose up',
  'docker compose -f ci.yml up --build',
  'docker build -t img .',
  'docker buildx build .',
  'docker pull python:3.12',
  'python train.py',
  'python3 -u scripts/run_eval.py --n 50',
  'uv run python eval.py',
  'uv run train.py',
  'python -m mytool.eval',
  'bash scripts/train.sh',
  'pytest -n 8',
  'uv run pytest -n auto tests/',
  'python -m pytest --numprocesses 4',
  'make',
  'make all',
  'npm run build',
  'pnpm build',
  'cargo build --release',
  'pip install torch',
  'uv pip install -r requirements.txt',
  'uv sync',
  'uv add numpy',
  'python -m pip install x',
  'curl -O https://example.com/big.tar',
  'curl -sSLO https://example.com/big.tar',
  'curl -L -o model.bin https://example.com/model',
  'wget https://example.com/big.tar',
  'huggingface-cli download org/model',
  'hf download org/model',
  'git clone https://github.com/x/y',
  'nohup python train.py > log 2>&1 &',
  'nohup docker run x &',
  'setsid docker run x',
  'screen -dmS job make',
  "tmux new -d -s job 'docker build .'",
  'python train_model.py',
  'python eval_run.py',
  'python scripts/train.py --epochs 3',
  './train.sh',
  'python -m pkg.finetune',
  'docker run -h myhost img',
  'cat <<EOF | docker run -i x\nhello\nEOF',
  'cat > a.sh <<EOF\npip install x\nEOF\nmake',
  'cat <<-EOF\n\tpip install x\n\tEOF\ndocker build .',
  'ls && docker run x',
  'cd repo; make',
  'git status || docker build .',
  'cat list | docker run -i x',
  'sudo docker run x',
  'sudo -n docker run x',
  'sudo -u ci make',
  'FOO=1 BAR=2 docker run x',
  'env FOO=1 docker run x',
  'timeout 600 docker run x',
  'time make',
  'nice -n 10 make',
  'bash -c "docker run x"',
  "sh -lc 'cd x && make'",
  '(cd x && docker compose up)',
  '/usr/bin/python3 train.py',
  // The known misses of 0.2: each now trips a rule.
  'docker run img -h',
  'docker run img --help',
  '(( x = 1 << 2 ))\nmake',
  'python -m train',
  'uv run python -m train --epochs 3',
  'echo "$(docker run x)"',
]

const ALLOWED: readonly string[] = [
  'ls -la',
  'ls build/',
  'cat docker-compose.yml',
  'cat Makefile',
  'grep make',
  'grep -r "docker run" .',
  'echo "docker run"',
  "echo 'make && docker build'",
  'ps aux',
  'top -l 1',
  'df -h',
  'du -sh ~/Library',
  'free -g',
  'vm_stat',
  'memory_pressure',
  'git status',
  'git log --oneline',
  'git diff HEAD',
  'git commit -m "docker run fix"',
  'docker ps',
  'docker stats --no-stream',
  'docker compose ps',
  'docker compose logs build-svc',
  'docker compose down',
  'kill 4242',
  'pkill -f train.py',
  'docker stop abc',
  'docker rm -f abc',
  'docker kill abc',
  'docker system prune -af',
  'docker image rm img',
  'docker image prune',
  'rm -rf build/',
  'rm train.py',
  'git worktree remove ../wt',
  'brew cleanup',
  'make clean',
  'make -n',
  'pytest tests/test_eval.py',
  'pytest -q',
  'python -c "import train"',
  'python retrieval.py',
  'eval "$(ssh-agent -s)"',
  'curl -s https://example.com/health',
  'curl -o /dev/null -w "%{http_code}" https://x',
  'npm test',
  // A tool the gate has no rule for runs in patterns mode, whatever its subcommand.
  'mytool status',
  'mytool run job-1',
  'mytool list mygroup',
  'sleep 5 &',
  'python serve.py &',
  'nohup python serve.py > log 2>&1 &',
  'setsid ./job',
  'screen -dmS job ./run.sh',
  'tmux new -d -s job ./run.sh',
  // Heredoc bodies are data: only the command line itself is read.
  "cat > setup.sh <<'EOF'\npip install torch\ndocker run x\nEOF",
  "python - <<'EOF'\nmake = {}\nprint(make)\nEOF",
  "git commit -F - <<'EOF'\nfix: make the gate allow heredocs\nEOF",
  'cat <<EOF > notes.md\ncurl -LO https://example.com/big.tar\nEOF',
  'cat <<"EOF"\nmake all\nEOF\nls',
  'cat <<-EOF\n\tmake\n\tEOF',
  // A script fed to a shell is skipped too: a rare miss, and allowing is the safe default.
  'bash <<EOF\ndocker run x\nEOF',
  'cat <<<"make all"',
  // Train/eval words must start the script basename or the module's last part.
  'python scripts/print_eval_summary.py',
  'python tools/sweep_cleanup.py',
  'uv run python -m mytool.evaluation.summary',
  'python ./scripts/eval_report.py --print',
  'python retrain_notes.py',
  // Help and version only print.
  'mytool eval --help',
  'docker run --help',
  'make -h',
  'pip --version',
  'tail -f log.txt &',
  'ls 2>&1',
  'ls &> out.txt',
  '# docker run in a comment',
  'cmake --version',
  '',
]

test('patterns mode: every blocked example trips a rule', () => {
  for (const command of BLOCKED) {
    expect([command, classifyBash(command, PATTERNS)]).not.toEqual([command, null])
  }
})

test('patterns mode: every allowed example passes', () => {
  for (const command of ALLOWED) {
    expect([command, classifyBash(command, PATTERNS)]).toEqual([command, null])
  }
})

test('patterns mode: the rule named is the one tripped', () => {
  const rule = (command: string) => classifyBash(command, PATTERNS)
  expect(rule('ls && docker run x')).toBe('docker run')
  expect(rule('docker compose up')).toBe('docker compose up')
  expect(rule('nohup docker run x')).toBe('docker run')
  expect(rule('screen -dmS job make')).toBe('detached session: make')
  expect(rule('python train_model.py')).toBe('train/eval script')
  expect(rule('python -m pkg.train')).toBe('train/eval script')
  expect(rule('pip install x')).toBe('pip/uv install')
  expect(rule('(( n = 1 << 2 ))\nmake')).toBe('make')
})

test('every heavy rule has a distinct name and an anchored pattern', () => {
  expect(new Set(HEAVY_RULES.map(rule => rule.name)).size).toBe(HEAVY_RULES.length)
  for (const rule of HEAVY_RULES) {
    expect(rule.pattern.source.startsWith('^')).toBe(true)
  }
})

// ---- allowlist mode (the default) ----

/** Light under pressure: reading, inspecting, waiting, stopping, cleaning up, help. */
const LIGHT: readonly string[] = [
  '',
  'ls -la',
  'cat docker-compose.yml',
  'head -50 log.txt',
  'tail -f log.txt &',
  'grep -rn "docker run" .',
  'rg -l make',
  'find . -name "*.py" -newer x',
  'find /tmp -name "*.log" -exec rm {} \;',
  'find . -name "*.pyc" -delete',
  'wc -l a b',
  'ps aux | sort -nrk 4 | head -5',
  'ps -axo rss,pid,comm | sort -rn | head',
  'top -l 1 -n 10',
  'vm_stat',
  'memory_pressure',
  'sysctl -n vm.swapusage',
  'df -h',
  'du -sh ~/Library/Caches/* | sort -h | tail',
  'free -g',
  'uptime',
  'which python3',
  'command -v docker',
  'type make',
  'echo "docker run"',
  "echo 'make && docker build'",
  "echo '$(docker run x)'",
  'printf "%s\\n" a b',
  'pwd',
  'cd repo && git status',
  'git status',
  'git -C ~/repo --no-pager log --oneline -5',
  'git diff HEAD~1 -- src/',
  'git show abc123:file.ts',
  'git branch -a',
  'git branch -D old',
  'git worktree list',
  'git worktree remove ../wt',
  'git worktree prune',
  'git stash list',
  'git clean -fdx build/',
  'git rev-parse HEAD',
  'docker ps -a',
  'docker stats --no-stream',
  'docker images',
  'docker system df',
  'docker logs --tail 50 web',
  'docker inspect web',
  'docker stop $(docker ps -q)',
  'docker rm -f abc',
  'docker rmi img',
  'docker kill abc',
  'docker system prune -af',
  'docker image prune -a',
  'docker volume prune',
  'docker builder prune -f',
  'docker container ls',
  'docker --context colima ps',
  'docker compose ps',
  'docker compose -f ci.yml down -v',
  'docker-compose logs web',
  'podman ps',
  'kill 4242',
  'kill -9 $(pgrep -f train.py)',
  'pkill -f train.py',
  'killall python3',
  'rm -rf build/',
  'rm train.py',
  'rmdir empty',
  'brew cleanup',
  'npm cache clean --force',
  'pip cache purge',
  'uv cache clean',
  'pip list',
  'conda clean -a',
  'cargo clean',
  'make clean',
  'make -C sub clean',
  'make -n',
  'tmux ls',
  'tmux kill-session -t job',
  'screen -ls',
  'screen -S job -X quit',
  'gh run view 12 --log',
  'gh pr checks 7',
  'gh run cancel 12',
  'until gh run view 1 --exit-status; do sleep 30; done',
  'while ! test -f done.txt; do sleep 5; done',
  'for f in *.log; do wc -l "$f"; done',
  'for ((i = 0; i < 3; i++)); do echo $i; done',
  'if [ -f x ]; then cat x; else echo none; fi',
  '[[ -d build ]] && rm -rf build',
  '(( n = 1 << 2 ))',
  'echo $(( 1 << 4 ))',
  'x=$(git rev-parse HEAD); echo $x',
  'export FOO=1; env | grep FOO',
  'sudo -n kill 1',
  'time ls',
  'timeout 5 tail -f log',
  'nohup sleep 5 &',
  'ls | xargs -n1 rm',
  'diff <(sort a) <(sort b)',
  'sleep 30',
  'wait',
  'curl -s http://localhost:8080/health',
  'curl -o /dev/null -w "%{http_code}" https://x',
  'cat > notes.md <<\'EOF\'\ndocker run x\nmake\nEOF',
  'cat <<-EOF\n\tpip install x\n\tEOF',
  'bash -c "ls && df -h"',
  "sh -c 'docker ps'",
  'eval "echo hi"',
  'ls 2>&1',
  'ls &> out.txt',
  '2>/dev/null ls',
  '# docker run in a comment',
  'mkdir -p out && touch out/.keep',
  // Help and version only print.
  'docker run --help',
  'mytool eval --help',
  'docker compose up --help',
  'uv run --help',
  'make -h',
  'pip --version',
  'cmake --version',
]

/** Everything else while gated, with what the refusal names. */
const HEAVY: readonly (readonly [string, string])[] = [
  ['docker run --rm ubuntu', 'docker run'],
  ['docker compose up -d', 'docker compose up'],
  ['docker-compose up', 'docker-compose up'],
  ['docker build -t img .', 'docker build'],
  ['docker pull python:3.12', 'docker pull'],
  ['docker exec -it web bash', 'docker exec'],
  // The known misses of 0.2.
  ['docker run img -h', 'docker run'],
  ['docker run img --help', 'docker run'],
  ['docker run -h myhost img', 'docker run'],
  ['(( x = 1 << 2 ))\nmake', 'make'],
  ['python -m train', 'python -m train'],
  ['python3 -u -m pkg.trainer --epochs 3', 'python3 -m pkg.trainer'],
  // Whatever the name: no list of heavy words to slip past.
  ['./run.sh', 'run.sh'],
  ['bash run.sh', 'bash run.sh'],
  ['bash scripts/go.sh', 'bash scripts/go.sh'],
  ['python serve.py', 'python serve.py'],
  ['python retrieval.py', 'python retrieval.py'],
  ['python train.py --help', 'python train.py'],
  ['python -c "import torch"', 'python'],
  ['node build.js', 'node build.js'],
  ['uv run pytest -q', 'uv run'],
  ['pytest tests/', 'pytest tests/'],
  ['npm test', 'npm test'],
  ['npm run build', 'npm run'],
  ['make', 'make'],
  ['make all', 'make all'],
  ['make clean all', 'make clean'],
  ['cargo build --release', 'cargo build'],
  ['pip install torch', 'pip install'],
  ['uv sync', 'uv sync'],
  ['wget https://x/big.tar', 'wget https://x/big.tar'],
  ['curl -LO https://x/big.tar', 'curl saving a file'],
  ['git clone https://github.com/x/y', 'git clone'],
  // A tool with no light subcommands configured is refused, whatever it is asked to do.
  ['mytool run -p tasks/x', 'mytool run'],
  ['mytool status', 'mytool status'],
  ['hf download org/model', 'hf download'],
  ['rsync -a a b', 'rsync'],
  // Compound commands: one part that is not light is enough.
  ['ls && make', 'make'],
  ['git status; docker run x', 'docker run'],
  ['cat list | xargs -n1 docker pull', 'docker pull'],
  ['ls | python3 process.py', 'python3 process.py'],
  ['(cd x && make)', 'make'],
  ['{ ls; make; }', 'make'],
  ['ls || ./train.sh', 'train.sh'],
  ['echo "$(docker run x)"', 'docker run'],
  ['echo `make`', 'make'],
  ['x=$(python3 -m train)', 'python3 -m train'],
  ['diff <(python a.py) b', 'python a.py'],
  ['kill $(docker run x)', 'docker run'],
  ['find . -name "*.py" -exec python {} \;', 'python {}'],
  ['ls | xargs -I{} docker run {}', 'docker run'],
  // Prefixes and wrappers are stripped first.
  ['sudo docker run x', 'docker run'],
  ['env FOO=1 make', 'make'],
  ['FOO=1 BAR=2 ./train', 'train'],
  ['time make', 'make'],
  ['nice -n 10 make', 'make'],
  ['timeout 600 python -m train', 'python -m train'],
  ['nohup python serve.py > log 2>&1 &', 'python serve.py'],
  ['caffeinate -i make', 'make'],
  ['command docker run x', 'docker run'],
  ['bash -c "ls && make"', 'make'],
  ["sh -lc 'cd x && docker compose up'", 'docker compose up'],
  ['bash -c "bash -c \\"make\\""', 'make'],
  ['eval "make all"', 'make all'],
  ['screen -dmS job ./run.sh', 'screen'],
  ['tmux new -d -s job ls', 'tmux new'],
  // A script fed to a shell or interpreter runs code the gate cannot read.
  ['bash <<EOF\nls\nEOF', 'bash'],
  ["python - <<'EOF'\nprint(1)\nEOF", 'python'],
  // A heredoc that a line after it follows: the line after is read.
  ["cat > a.sh <<'EOF'\nls\nEOF\n./a.sh", 'a.sh'],
  ['cat <<"EOF"\nok\nEOF\nmake', 'make'],
  ['for f in *.py; do python "$f"; done', 'python $f'],
  ['while true; do make; sleep 5; done', 'make'],
  ['if true; then docker run x; fi', 'docker run'],
  ['for ((i = 0; i < 3; i++)); do make; done', 'make'],
]

test('allowlist: light commands run, compound ones only when every part is light', () => {
  for (const command of LIGHT) {
    expect([command, classifyBash(command)]).toEqual([command, null])
  }
})

test('allowlist: everything else is refused, naming the first part that is not light', () => {
  for (const [command, named] of HEAVY) {
    expect([command, classifyBash(command)]).toEqual([command, `not on the light list: ${named}`])
  }
})

/**
 * Bypasses a model could hit by accident or by rewording a refused command: a light name that runs
 * code anyway, a path or PATH standing in for a light name, help that runs a script, and syntax that
 * hid a heavy part. Each must be refused.
 */
const BYPASSES: readonly string[] = [
  // Light tools whose options run a program.
  "awk 'BEGIN{system(\"make -j16\")}'",
  "awk 'BEGIN { print \"x\" | \"sh\" }'",
  "gawk '{ \"make\" | getline v }' f",
  'awk -f prog.awk f',
  'fd -x make',
  'fd . -X ./train.sh',
  'fd -e py --exec python {}',
  'fd --exec-batch make',
  'rg --pre ./x pattern .',
  'rg --pre=./x pattern',
  'sort --compress-program=./x big.txt',
  'sort --compress-program ./x big.txt',
  "gsed -n '1e make' f",
  "sed -n '1e make' f",
  "sed 's/x/make/e' f",
  "sed -i '' '1e make' f",
  'sed -f script.sed f',
  "trap 'docker run img' EXIT",
  'trap -- "make" INT',
  "env -S 'make -j8'",
  "env --split-string='docker run img'",
  "env -S'make'",
  "env --split-string 'make -j8'",
  "git -c core.fsmonitor='./train.sh' status",
  'git -c diff.external=./x diff',
  'git -ccore.pager=./x log',
  'git --config-env=core.pager=X log',
  'git --exec-path=./bin status',
  'git grep -O x',
  'git grep -iO x',
  'git grep --open-files-in-pager=./x x',
  'hash -p /usr/bin/make ls; ls',
  "alias ls='make -j8'\nls",
  "less +'!make' f",
  'docker --tlscacert ps run img',
  'tar tf a.tar --to-command=./x',
  'tar -tf a.tar -I ./x',
  '/usr/bin/env PATH=./bin ls',
  '/usr/bin/env make',
  "python3 -c 'import subprocess; subprocess.run([\"make\"])'",
  "python3 -c 'import os; os.system(\"make\")'",
  'python -c "import torch"',
  // An assignment that changes what a light name runs.
  'GIT_EXTERNAL_DIFF=./x git diff',
  "LESSOPEN='|./x %s' less f",
  'PATH=./bin ls',
  'env PATH=./bin ls',
  'GIT_PAGER=./x git log',
  'PAGER=./x git log',
  'EDITOR=./x git commit',
  'BASH_ENV=./x bash -c ls',
  'DYLD_INSERT_LIBRARIES=x.dylib ls',
  'LD_PRELOAD=x.so ls',
  'export PATH=./bin; ls',
  'PATH=./bin\nls',
  // A path standing in for a light name.
  'ln -sf /usr/bin/make /tmp/cat && /tmp/cat -j8',
  './bin/ls',
  '~/bin/cat x',
  '/tmp/sh -c ls',
  // Help that runs a script.
  './train.sh --help',
  './train -h',
  'sh train --version',
  'bash train --help',
  'node train --help',
  'npx pkg --help',
  'python3 train --help',
  'uvx pkg --version',
  'pnpm dlx pkg --help',
  // Syntax that hid a heavy part.
  'echo ${x/<<EOF/}\ndocker run img',
  'echo ${x:-$(make)}',
  'echo "${x:-$(docker run img)}"',
  'echo $(( $(docker run img) ))',
  '(( $(docker run img) ))',
  'echo $(( `make` + 1 ))',
  'for (( i = $(make); i < 3; i++ )); do :; done',
  'case $x in a) make;; esac',
  'case $x in a) ls;; b) docker run img;; esac',
  // A version or help flag that a shell or interpreter reads as a mode, then runs its stdin or a script.
  'bash -v <<EOF\nmake\nEOF',
  'cat run.sh | sh -h',
  'echo make | zsh -v',
  'python3 -v < train.py',
  "python3 -v <<'EOF'\nimport os\nEOF",
  'python3 -m pip install x --version',
  'python3 -m mypkg --version',
  // An awk pipe after a string with a | in it.
  'awk \'{ print "a|b" | "sh" }\' f',
  "awk 'BEGIN { FS=\"|\"; \"make\" | getline v }'",
  'awk \'/"/ { print | "sh" } /"/\' f',
  // A heredoc body that closes the substitution early in a naive reader: what follows is still read.
  "git commit -m \"$(cat <<'EOF'\nfix: 1) a\nEOF\n)\" && make",
  "git commit -m \"$(cat <<'EOF'\nfix: (y\nEOF\n)\"; docker run img",
  'echo "$(echo \')\'; make)"',
  'echo "$(echo "(" ; make)"',
  'echo $(ls `make`)',
  // PATH with a relative or empty part puts the working folder first.
  'PATH=bin:$PATH ls',
  'export PATH=:$PATH',
  'PATH=$PATH: ls',
  'export PATH=".:$PATH"',
  'PATH=$PWD/bin:$PATH ls',
  'PATH=/usr/bin::/bin ls',
  'PATH=$HOMEX/bin ls',
  'PATH+=::/bin; ls',
  'PATH+=bin; ls',
  // git config keys that run a program, or any key off the safe list.
  'git -c core.sshCommand=./x fetch',
  "git -c alias.st='!make' st",
  'git -c core.hooksPath=./h commit -m x',
  'git -c core.pager=./x log',
  'git -c core.editor=./x commit',
  'git -c credential.helper=./x fetch',
  'git -c Core.FsMonitor=./x status',
  'git -c user.cmd=./x log',
  'git -c color.command=./x log',
  'git -c user.name=x -c diff.external=./x diff',
  'git -c',
  // python -c that imports anything off the safe list, or runs a program however it is reached.
  "python3 -c 'import numpy as np; a = np.zeros((50000, 50000))'",
  "python3 -c \"from datasets import load_dataset; load_dataset('x')\"",
  "python3 -c \"from huggingface_hub import snapshot_download; snapshot_download('org/m')\"",
  "python3 -c 'import json, torch'",
  "python3 -c 'from os import system; system(\"make\")'",
  "python3 -c 'import os as o; o.system(\"make\")'",
  "python3 -c 'from os import system as s; s(\"make\")'",
  "python3 -c 'from os import *; system(\"make\")'",
  "python3 -c 'import os; f = os.popen; f(\"make\")'",
  "python3 -c 'import json\nimport torch'",
  "python3 -c 'import os; os.execvp(\"make\", [\"make\"])'",
  "python3 -c 'exec(\"print(1)\")'",
  "python3 -c \"eval('1')\"",
  "python3 -c 'compile(\"1\", \"f\", \"eval\")'",
  "python3 -c '__import__(\"os\")'",
  "python3 -c 'import importlib'",
  "python3 -c 'from . import x'",
]

/** Routine cheap work that must still run while gated. */
const ROUTINE: readonly string[] = [
  'cp a b',
  'cp -r src/ dst/',
  'mv a b',
  'mkdir -p out',
  'touch x',
  'ln -s a b',
  'tar tzf x.tgz',
  'tar -tf x.tar',
  'tar --list -f x.tar',
  'open report.html',
  'open -a Preview x.pdf',
  'git add -A',
  'git add . && git commit -m "fix: x"',
  'git commit -am "docker run fix"',
  'git stash',
  'git stash pop',
  'git checkout -b feat',
  'git checkout main -- file.ts',
  'git switch main',
  'git restore --staged file',
  'git fetch',
  'git fetch origin main',
  'git pull --ff-only',
  'git push -u origin feat',
  'git merge feat',
  'git rebase main',
  'git tag v1.0',
  'git worktree add ../wt -b feat',
  'cd repo && git add -A && git commit -m x && git push',
  'gh pr view 12',
  'gh pr list --state open',
  'gh pr create --title x --body y',
  'gh issue view 3',
  'gh run list',
  'gh api repos/o/r/pulls',
  "python3 -c 'print(1)'",
  'python3 -c "import json,sys; print(json.load(sys.stdin)[0])" < f.json',
  'cat f.json | python -c "import json, sys; print(len(json.load(sys.stdin)))"',
  'cat f.json | python3 -m json.tool',
  "/usr/bin/env python3 -c 'print(1)'",
  '/usr/bin/time ls',
  'jq .x f.json',
  "jq -r '.[] | .name' f.json",
  "sed -n '1,20p' f",
  "sed -i '' 's/a/b/' f",
  "sed -e 's/e/x/g' -e 's/foo/bar/' f",
  'diff a b',
  'diff -u a b',
  "awk '{print $1}' f",
  "awk -F'|' '{print $2}' f",
  "awk '/a|b/ {n++} END {print n}' f",
  "awk '$1 > 0 || $2 > 0' f",
  'case $x in a) echo a;; b) echo b;; esac',
  'case "$f" in *.py|*.sh) echo code;; *) echo other;; esac',
  'case $x in\n  a) ls ;;\n  b) pwd ;;\nesac',
  'GIT_PAGER=cat git log -5',
  'PAGER=cat git diff',
  'GIT_TERMINAL_PROMPT=0 git fetch',
  'GIT_EDITOR=true git rebase --continue',
  'LESS=-R less f',
  'FOO=1 ls',
  '/usr/bin/grep x f',
  '/bin/ls',
  '/opt/homebrew/bin/rg x',
  'ls --help',
  'rg --help',
  'git --version',
  "trap 'rm -f /tmp/x' EXIT",
  'trap - EXIT',
  'hash -r',
  "env -S 'ls -la'",
  "alias ll='ls -la'",
  'fd -e py',
  'fd -e log -x rm {}',
  'sort -u f',
  'less f',
  'less +F log',
  'git grep -n foo',
  'git -C repo status',
  'echo ${HOME}/x',
  'echo ${#arr[@]}',
  'echo "${x/<<EOF/}"',
  'echo $(( x + 1 ))',
  // Version and help of an interpreter or shell.
  'python3 --version',
  'python3 -V',
  'python3 -h',
  'node -v',
  'node --help',
  'bun --version',
  'bun -v',
  'bash --version',
  'zsh --help',
  'ruby -v',
  'perl -v',
  'deno -V',
  'python3 -m pip --version',
  'python -m pip -V',
  // Loop control and arithmetic builtins.
  'for f in *; do [ -d "$f" ] && continue; echo "$f"; done',
  'for f in *; do if [ -f "$f" ]; then echo "$f"; break; fi; done',
  'while read -r l; do [ -z "$l" ] && break; echo "$l"; done < f',
  'let i=i+1',
  'while getopts ab o; do echo $o; done',
  // A | inside an awk string is text, not a pipe.
  'awk \'{printf "%s | %s\\n",$1,$2}\' f',
  'awk \'{print $1 "|" $2}\' f',
  'awk \'BEGIN{FS="|"} {print $2}\' f',
  'awk \'BEGIN{FS="\\"|"} {print $2}\' f',
  // The standard commit and PR form: a quoted heredoc inside "$(...)", whatever its body holds.
  "git commit -m \"$(cat <<'EOF'\nfix: steps\n1) a\n2) b\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: smile :)\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: x (y\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: it's \"quoted\" (really)\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: handle `foo` and `make`\nEOF\n)\"",
  "git commit -m \"$(cat <<'EOF'\nfix: 1) see \"x\" it's `y` (z\nmore\nEOF\n)\" && git push",
  "gh pr create --title x --body \"$(cat <<'EOF'\n## Summary\n- a) b (c\nEOF\n)\"",
  'echo "$(echo \')\')"',
  'echo $(echo "(")',
  // PATH set to absolute parts and itself.
  'export PATH="$HOME/.local/bin:$PATH"',
  'PATH=/opt/homebrew/bin:$PATH jq .x f.json',
  'export PATH=~/bin:${PATH}',
  'export PATH="${HOME}/go/bin:$PATH"',
  'PATH=/usr/bin:/bin ls',
  'PATH+=:/opt/homebrew/bin; ls',
  "LESS='-R -F' less f",
  // git config keys that run nothing.
  'git -c user.name=x -c user.email=y commit -m z',
  'git -c color.ui=always log',
  'git -c core.pager=cat log',
  'git -c core.pager=less log',
  'git -c advice.detachedHead=false checkout abc',
  "git -c safe.directory='*' status",
  'git -c init.defaultBranch=main status',
  'git -c commit.gpgsign=false commit -m x',
  'git -c core.quotepath=off status',
  'git -c log.showSignature=false log',
  'git -c format.pretty=oneline log',
  // python -c importing only standard modules that run nothing.
  "python3 -c \"import json; d = json.load(open('r.json')); print(d['eval'])\"",
  "python3 -c \"import re; print(re.compile('x').match('x'))\"",
  "python3 -c 'import os.path; print(os.path.exists(\"x\"))'",
  "python3 -c 'from pathlib import Path; print(Path(\".\").resolve())'",
  "python3 -c 'import sys, json as j; print(sys.version)'",
  "python3 -c 'import os; print(os.getcwd(), os.sep)'",
  "python3 -c 'from collections import Counter; print(Counter(\"aab\"))'",
  "python3 -c 'import platform; print(platform.system())'",
  "python3 -c 'from os import path, getcwd; print(getcwd())'",
]

test('allowlist: every bypass is refused', () => {
  for (const command of BYPASSES) {
    expect([command, classifyBash(command) === null ? 'let through' : 'refused']).toEqual([command, 'refused'])
  }
})

test('allowlist: routine cheap work runs', () => {
  for (const command of ROUTINE) {
    expect([command, classifyBash(command)]).toEqual([command, null])
  }
})

test('allowlist is the default mode; "patterns" is the only other', () => {
  expect(parseMode(undefined)).toBe('allowlist')
  expect(parseMode('allowlist')).toBe('allowlist')
  expect(parseMode('patterns')).toBe('patterns')
  expect(parseMode('bogus')).toBe('allowlist')
  expect(classifyBash('python serve.py')).not.toBeNull()
  expect(classifyBash('python serve.py', PATTERNS)).toBeNull()
})

test('allowlist: user patterns allow a part or refuse a light one; a broken pattern is skipped', () => {
  const overrides = { extraBlock: parsePatterns('^rm -rf / ;; ^(oops'), extraAllow: parsePatterns('^make lint\\b ;; ^ops brief$') }
  expect(classifyBash('make all && make lint', { overrides })).toBe('not on the light list: make all')
  expect(classifyBash('git status && make lint', { overrides })).toBeNull()
  expect(classifyBash('sudo ops brief', { overrides })).toBeNull()
  expect(classifyBash('ls; rm -rf /', { overrides })).toBe('custom rule /^rm -rf \\//')
  expect(classifyBash('rm -rf build', { overrides })).toBeNull()
})

test('allowlist: a mod\'s own segment rule sees every part the gate reads, nested ones too, before the user\'s allows', () => {
  const extraSegment = (words: readonly string[]) => (words.includes('secret') ? 'mod rule' : null)
  const overrides = { extraBlock: [], extraAllow: [/^ls\b/], extraSegment }
  for (const command of ['ls secret', 'bash -c "ls secret"', 'echo $(ls secret)', 'find . -exec ls secret \\;', 'eval "ls secret"', 'pwd && sudo ls secret']) {
    expect([command, classifyBash(command, { overrides })]).toEqual([command, 'mod rule'])
  }
  expect(classifyBash('ls other', { overrides })).toBeNull()
  expect(classifyBash('ls secret', { mode: 'patterns', overrides })).toBeNull()
})

test('allowlist mode: gateLightSubcommands makes a tool subcommand light, and nothing else', () => {
  const lightSubcommands = parseLightSubcommands('mytool status ;; mytool list\nmytool jobs show ;; othertool ;; ./bin/x status ;; git bisect')
  expect([...lightSubcommands.keys()]).toEqual(['mytool', 'git'])
  const overrides = { extraBlock: [], extraAllow: [], lightSubcommands }
  for (const command of ['mytool status', 'mytool --verbose list mygroup', 'mytool jobs show 3', 'sudo mytool status && ls', 'git bisect log']) {
    expect([command, classifyBash(command, { overrides })]).toEqual([command, null])
  }
  expect(classifyBash('mytool run job-1', { overrides })).toBe('not on the light list: mytool run')
  expect(classifyBash('mytool jobs start', { overrides })).toBe('not on the light list: mytool jobs')
  expect(classifyBash('othertool status', { overrides })).toBe('not on the light list: othertool status')
  expect(classifyBash('./mytool status', { overrides })).toBe('not on the light list: mytool status')
  expect(classifyBash('mytool status', {})).toBe('not on the light list: mytool status')
  // The built-in table still applies beside the user's entries.
  expect(classifyBash('git status', { overrides })).toBeNull()
  expect(parseLightSubcommands(undefined).size).toBe(0)
  expect(parseLightSubcommands('').size).toBe(0)
})

test('patterns mode: user overrides add blocks and allows; a broken pattern is skipped', () => {
  const overrides = { extraBlock: parsePatterns('^rsync\\b ;; ^(oops'), extraAllow: parsePatterns('^docker run hello-world') }
  expect(overrides.extraBlock).toHaveLength(1)
  expect(classifyBash('rsync -a a b', { mode: 'patterns', overrides })).toBe('custom rule /^rsync\\b/')
  expect(classifyBash('docker run hello-world', { mode: 'patterns', overrides })).toBeNull()
  expect(classifyBash('docker run other', { mode: 'patterns', overrides })).toBe('docker run')
  expect(parsePatterns(undefined)).toEqual([])
  expect(parsePatterns('a\nb')).toHaveLength(2)
})

test('help: --help or --version last, after plain subcommand words only; -h only alone', () => {
  expect(isHelp(['docker', 'run', '--help'])).toBe(true)
  expect(isHelp(['docker', 'compose', 'up', '--help'])).toBe(true)
  expect(isHelp(['make', '-h'])).toBe(true)
  expect(isHelp(['git', '--version'])).toBe(true)
  expect(isHelp(['docker', 'run', 'img', '--help'])).toBe(false)
  expect(isHelp(['docker', 'run', 'img', '-h'])).toBe(false)
  expect(isHelp(['docker', 'run', '-h', 'host'])).toBe(false)
  expect(isHelp(['python', 'train.py', '--help'])).toBe(false)
  expect(isHelp(['python', '-m', 'train', '--help'])).toBe(false)
  expect(isHelp(['uv', 'run', 'train', '--help'])).toBe(false)
  expect(isHelp(['ls', '--help', 'x'])).toBe(false)
  expect(isHelp(['--help'])).toBe(false)
  // Only a bare name that is not a shell, interpreter or runner: anything else runs the script it is handed.
  expect(isHelp(['./train.sh', '--help'])).toBe(false)
  expect(isHelp(['./train', '-h'])).toBe(false)
  expect(isHelp(['/tmp/cat', '--version'])).toBe(false)
  for (const head of ['sh', 'bash', 'zsh', 'node', 'python3', 'python3.12', 'ruby', 'perl', 'npx', 'uvx', 'bunx', 'deno', 'bun', 'source', '.']) {
    expect([head, isHelp([head, 'train', '--help'])]).toEqual([head, false])
    expect([head, isHelp([head, 'train', '--version'])]).toEqual([head, false])
  }
  // Alone, an interpreter's own help or version flag prints and exits. A shell's -h or -v, and python's -v,
  // set a mode and then run the script on stdin, so only --help and --version count for them.
  for (const head of ['sh', 'bash', 'zsh', 'dash', 'fish', 'python3', 'node', 'bun', 'deno', 'ruby', 'perl']) {
    expect([head, isHelp([head, '--version']), isHelp([head, '--help'])]).toEqual([head, true, true])
  }
  for (const [head, flag] of [['sh', '-h'], ['bash', '-v'], ['zsh', '-V'], ['python3', '-v'], ['source', '-h'], ['.', '-v']] as const) {
    expect([head, flag, isHelp([head, flag])]).toEqual([head, flag, false])
  }
  expect(isHelp(['python3', '-V'])).toBe(true)
  expect(isHelp(['node', '-v'])).toBe(true)
  expect(isHelp(['python3', '-m', 'pip', '--version'])).toBe(true)
  expect(isHelp(['python3', '-m', 'train', '--version'])).toBe(false)
  expect(isHelp(['python3', '-m', 'pip', 'install', '--version'])).toBe(false)
  expect(isHelp(['pnpm', 'dlx', 'pkg', '--help'])).toBe(false)
  expect(isHelp(['rg', '--help'])).toBe(true)
  expect(isHelp(['uv', 'run', '--help'])).toBe(true)
})

test('quotes and redirections are not read as commands or operators', () => {
  expect(segments('echo "a && docker run" ; ls')).toEqual([['echo', 'a && docker run'], ['ls']])
  expect(segments('cmd 2>&1 &')).toEqual([['cmd', '2>&1']])
  expect(segments('a $(b; c) d')).toEqual([['a', '$(b; c)', 'd']])
})

test('substitutions are recorded unquoted, in double quotes, in arithmetic and in ${...}, never in single quotes', () => {
  expect(parse('a $(b; c) "x $(d) `e`" \'$(f)\' $((1 + 2)) <(g) >(h)').substitutions).toEqual(['b; c', 'd', 'e', 'g', 'h'])
  expect(parse('echo $(a $(b))').substitutions).toEqual(['a $(b)'])
  expect(parse('echo $(( $(a) + `b` ))').substitutions).toEqual(['a', 'b'])
  expect(parse('(( n = $(a) ))').substitutions).toEqual(['a'])
  expect(parse('for (( i = $(a); i < 3; i++ )); do :; done').substitutions).toEqual(['a'])
  expect(parse('echo ${x:-$(a)} "${y:-`b`}"').substitutions).toEqual(['a', 'b'])
})

test('a $(...) ends where bash ends it: quotes, heredoc bodies, comments and nested substitutions hold no closing )', () => {
  const body = "cat <<'EOF'\nfix: 1) a :) (y it's \"q\" `b`\nEOF\n"
  expect(parse(`git commit -m "$(${body})" && ls`)).toEqual({ segments: [['git', 'commit', '-m', `$(${body})`], ['ls']], substitutions: [body] })
  expect(parse("echo $(echo ')' \"(\" \\)) x").substitutions).toEqual(["echo ')' \"(\" \\)"])
  expect(parse('echo $(a $(b ")") `c )`) d').substitutions).toEqual(['a $(b ")") `c )`'])
  expect(parse('echo $(ls # a ) comment\n) x').substitutions).toEqual(['ls # a ) comment\n'])
  expect(parse('echo `a \\` b` c').substitutions).toEqual(['a \\` b'])
  expect(parse('echo $(( (1 + 2) * 3 )) $(a)').substitutions).toEqual(['a'])
})

test('a long run of (( and $( is read in linear time', () => {
  const started = Date.now()
  for (const command of ['(('.repeat(20_000), '$('.repeat(20_000), 'echo $(('.repeat(10_000), '"$('.repeat(10_000)]) {
    classifyBash(command)
  }
  expect(Date.now() - started).toBeLessThan(2000)
})

test('${...} is one matched pair: a << inside it opens no heredoc, a } inside a nested one does not end it', () => {
  expect(segments('echo ${x/<<EOF/}\nmake')).toEqual([['echo', '${x/<<EOF/}'], ['make']])
  expect(segments('echo "${x/<<EOF/}"\nmake')).toEqual([['echo', '${x/<<EOF/}'], ['make']])
  expect(segments('echo ${a:-${b}} ; ls')).toEqual([['echo', '${a:-${b}}'], ['ls']])
})

test('case: the pattern words before each ) are not commands; the bodies are', () => {
  expect(segments('case $x in a) echo a;; b) echo b;; esac')).toEqual([['case', '$x', 'in'], ['echo', 'a'], ['echo', 'b'], ['esac']])
  expect(segments('case "$f" in\n  (*.py|*.sh) ls ;;\n  *) pwd ;;\nesac')).toEqual([['case', '$f', 'in'], ['ls'], ['pwd'], ['esac']])
  expect(segments('case $x in a) case $y in b) ls;; esac;; c) pwd;; esac')).toEqual([['case', '$x', 'in'], ['case', '$y', 'in'], ['ls'], ['esac'], ['pwd'], ['esac']])
  expect(parse('case $x in $(a)) ls;; esac').substitutions).toEqual(['a'])
})

test('an arithmetic command is one word: its << opens no heredoc', () => {
  expect(segments('(( x = 1 << 2 ))\nmake')).toEqual([['(( x = 1 << 2 ))'], ['make']])
  expect(segments('((cd a) && b)')).toEqual([['cd', 'a'], ['b']])
  expect(segments('for ((i=0; i<3; i++)); do ls; done')).toEqual([['for', '((i=0; i<3; i++))'], ['do', 'ls'], ['done']])
})

test('a heredoc body is skipped through its terminator; the lines after it are read again', () => {
  expect(segments("cat > x.sh <<'EOF' && ls\npip install x\nEOF\ndocker run y")).toEqual([['cat', '>', 'x.sh'], ['ls'], ['docker', 'run', 'y']])
  expect(segments('a <<A <<B\n1\nA\n2\nB\nc')).toEqual([['a'], ['c']])
  expect(segments('cat <<EOF\nmake\nEOFX\nmake')).toEqual([['cat']])
  expect(segments('cat <<<word')).toEqual([['cat', '<<<word']])
})

test('wrappers are stripped by unwrap; runners and interpreters too by normalize', () => {
  expect(unwrap(['sudo', '-E', 'FOO=1', 'docker', 'run'])).toEqual(['docker', 'run'])
  expect(unwrap(['2>/dev/null', 'nice', '-n', '5', 'timeout', '30', 'make'])).toEqual(['make'])
  expect(unwrap(['>', 'out', 'ls'])).toEqual(['ls'])
  expect(unwrap(['command', '-v', 'docker'])).toEqual(['command', '-v', 'docker'])
  expect(unwrap(['xargs', '-n', '1', '-P', '4', 'rm'])).toEqual(['rm'])
  expect(normalize(['uv', 'run', '--with', 'x', 'python', '-u', 'train.py'])).toEqual(['train.py'])
  expect(normalize(['python3', '-m', 'pytest', '-n', '4'])).toEqual(['pytest', '-n', '4'])
  expect(normalize(['timeout', '30', 'make'])).toEqual(['make'])
})

test('run_in_background changes nothing: a background command is judged like any other', () => {
  expect(heavyWork({ tool: 'Bash', command: 'tail -f log', run_in_background: true })).toBeNull()
  expect(heavyWork({ tool: 'Bash', command: 'sleep 60', run_in_background: true })).toBeNull()
  expect(heavyWork({ tool: 'Bash', command: 'docker run x', run_in_background: true })).toBe('not on the light list: docker run')
  const patterns = { mode: 'patterns', overrides: { extraBlock: [], extraAllow: [] } } as const
  for (const command of ['npm test', 'git fetch', 'python serve.py', 'until gh run view 1 --exit-status; do sleep 30; done']) {
    expect([command, heavyWork({ tool: 'Bash', command, run_in_background: true }, patterns)]).toEqual([command, null])
  }
  expect(heavyWork({ tool: 'Bash', command: 'until false; do make; sleep 5; done', run_in_background: true }, patterns)).toBe('make')
})

test('the Agent tool is refused; every other tool but Bash is allowed', () => {
  expect(heavyWork({ tool: 'Agent' })).toBe('spawning a subagent')
  for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'SendMessage', 'TaskStop', 'mcp__x__run']) {
    expect(heavyWork({ tool, command: 'docker run x' })).toBeNull()
  }
  expect(heavyWork({ tool: 'Bash', command: 'docker run x' })).toBe('not on the light list: docker run')
  expect(heavyWork({ tool: 'Bash', command: 'ls' })).toBeNull()
  expect(heavyWork({ tool: 'Bash' })).toBeNull()
})

test('a deeply nested command is refused rather than read forever', () => {
  const nested = 'bash -c "bash -c \\"bash -c \\\\\\"bash -c \\\\\\\\\\\\\\"bash -c ls\\\\\\\\\\\\\\"\\\\\\"\\""'
  expect(classifyBash(nested)).not.toBeNull()
  expect(classifyBash('echo $(echo $(echo $(echo $(echo $(ls)))))')).not.toBeNull()
  expect(classifyBash('echo $(echo $(ls))')).toBeNull()
})

test('a reading gates only while fresh: missing or older than three intervals fails open', () => {
  const interval = 60_000
  expect(STALE_INTERVALS).toBe(3)
  expect(isFresh(1000, 1000, interval)).toBe(true)
  expect(isFresh(0, 3 * interval, interval)).toBe(true)
  expect(isFresh(0, 3 * interval + 1, interval)).toBe(false)
  expect(isFresh(undefined, 0, interval)).toBe(false)
  expect(isFresh('soon', 0, interval)).toBe(false)
  expect(isFresh(Number.NaN, 0, interval)).toBe(false)
})

const REFUSAL = { plugin: 'mem-watch', condition: 'Memory is low', figure: 'free 12% · swap 5G', limit: 'free at least 28%', recovery: 'memory recovers', rule: 'not on the light list: docker run' }

test('the refusal gives the figure and limit, what still runs, and that it lifts itself', () => {
  const reason = refusalReason(REFUSAL)
  for (const part of ['this command was not run', 'free 12% · swap 5G', 'free at least 28%', 'not on the light list: docker run', 'stopping and cleanup', 'reading and inspecting', '--help', 'lifts by itself when memory recovers', 'Do not retry this command in a loop or reword it']) {
    expect(reason).toContain(part)
  }
  expect(reason.split('\n')).toHaveLength(3)
  expect(refusalToast(REFUSAL)).toBe('paused docker run: free 12% · swap 5G')
  expect(refusalToast({ ...REFUSAL, rule: 'custom rule /^x/' })).toBe('paused custom rule /^x/: free 12% · swap 5G')
})

test('the refusal names the culprits when known, and says nothing was stopped', () => {
  const reason = refusalReason({ ...REFUSAL, culprits: ['python3 (pid 4242) 9.0 GB', 'docker: web 3.1 GiB'] })
  expect(reason.split('\n')).toHaveLength(4)
  expect(reason).toContain('Largest users of memory now: python3 (pid 4242) 9.0 GB; docker: web 3.1 GiB. Nothing has been stopped')
  expect(refusalReason({ ...REFUSAL, culprits: ['Docker images 40 GB'], resource: 'disk space' })).toContain('Largest users of disk space now: Docker images 40 GB.')
  expect(refusalReason({ ...REFUSAL, culprits: [] })).toBe(refusalReason(REFUSAL))
  expect(culpritsLine(undefined)).toEqual([])
})

test('a refused Agent call says the subagent was not started; a Bash refusal keeps "this command was not run"', () => {
  const r = { ...REFUSAL, rule: 'spawning a subagent' }
  const agent = refusalReason({ ...r, tool: 'Agent' })
  expect(agent).toContain('mem-watch: this subagent was not started.')
  expect(agent).toContain('Do not retry starting it in a loop')
  expect(agent).not.toContain('command was not run')
  const bash = refusalReason({ ...r, tool: 'Bash' })
  expect(bash).toContain('this command was not run.')
  expect(bash).toContain('Do not retry this command in a loop')
  expect(refusalReason(r)).toBe(bash)
})

test('sizes parse as Docker prints them', () => {
  expect(parseSize('1.5GiB')).toBe(1.5 * 1024 ** 3)
  expect(parseSize('512MB')).toBe(512e6)
  expect(parseSize('0B')).toBe(0)
  expect(parseSize('12.3kB')).toBe(12300)
  expect(parseSize(' 2 TB ')).toBe(2e12)
  expect(parseSize('lots')).toBeNull()
  expect(parseSize('')).toBeNull()
})

test('stored culprits are read defensively', () => {
  expect(asStoredCulprits({ at: 5, lines: ['a'] })).toEqual({ at: 5, lines: ['a'] })
  expect(asStoredCulprits({ at: 5, lines: [1] })).toBeNull()
  expect(asStoredCulprits({ at: Number.NaN, lines: [] })).toBeNull()
  expect(asStoredCulprits({ lines: [] })).toBeNull()
  expect(asStoredCulprits(null)).toBeNull()
})
