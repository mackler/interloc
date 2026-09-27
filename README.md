# Interloq

**Two brilliant minds. One flawless plan. Zero wasted afternoons.**

Imagine handing your next project to a dream team. One member is a visionary who drafts the
blueprint; the other is a critic who has never let a weak idea slip past. Interloq brings them
together. Before a single line of work begins, they sit you down, ask exactly the right questions
and capture what you really want. Then the visionary writes the plan, and the critic tests it round
after round until there is nothing left to improve.

Only then does the building start, and every stage is inspected the moment it's done. If anything
goes off course, the plan is refined, reviewed again and put back on track. You're never nagged:
Interloq speaks up only when a decision is truly yours. Watch it all unfold live in your browser,
from any seat in the house, and keep every word of the conversation on record. Less supervising,
more achieving. That's Interloq.

---

## What it does, in plain words

1. **Questions.** Claude Code proposes questions about your task, Codex reviews them, and you answer
   them in an interview.
2. **Plan.** Claude Code writes a plan, and Codex reviews it in rounds until a review raises no
   issue.
3. **Work.** Claude Code carries out the plan.
4. **Check.** After every stretch of work, Codex reviews what was done against the plan and your
   requirements.
5. **Revise.** If the work stops, or a review finds a problem, the plan is revised and reviewed
   again before the work goes on.

Interloq asks you only where a decision is needed, for example when the two agents disagree
repeatedly or a review reaches its round limit.

Behind the brand, the program's command and its records directory are both called `plan-review`.

## What you need

- **Docker** with Docker Compose.
- **The container image source** in the sibling directory `../claude-code-image`, which is used to
  build the image `claude-code-base`.
- **A Claude Code login token** in the environment variable `CLAUDE_CODE_OAUTH_TOKEN` on the host.
- **A logged-in Codex** whose credentials live in the external Docker volume
  `iou-notes-codex_codex-config`, which is mounted as `~/.codex` in the container.
- **Node.js 22.18 or later and git** inside the container. The image provides them.
- **Node.js 22.18 or later, npm and git on the host.** The installed copy (see below) is mounted
  read-only into containers, so its `npm ci` and `npm run build` have to run on the host.
- **Network access** for both agents.
- **Only if you change the program:** Chromium for the end-to-end tests. In the development
  container, run `npx playwright install chromium` as the user and
  `npx playwright install-deps chromium` as root.

## Your two copies

Interloq uses two clones of this repository on the host:

| Copy | Path on the host | Purpose |
|---|---|---|
| Installed copy | `~/work/plan-review` | What real runs use. Containers mount it read-only at `/opt/plan-review`. |
| Development copy | `~/work/plan-review-dev` | Where changes are made. Use `bin/dev-claude` to start its container. |

`bin/dev-claude` manages the development container (`compose.cc.yaml`). That container mounts the
development copy at `/workspace` and the installed copy at `/opt/plan-review`, holds both agents'
credentials, and publishes port 8090 for the web page.

| Command | What it does |
|---|---|
| `bin/dev-claude` or `bin/dev-claude run [args]` | Starts the container if needed, then starts Claude Code in it |
| `bin/dev-claude shell` | Opens a Bash shell in the container |
| `bin/dev-claude review "task" [project]` | Runs Interloq in the terminal inside the container |
| `bin/dev-claude build` | Builds the image from `../claude-code-image` |
| `bin/dev-claude down` | Stops and removes the container (the volumes are kept) |
| `bin/dev-claude help` | Shows the usage text |

## First-time setup

1. Clone the repository twice: once to `~/work/plan-review` (the installed copy) and once to
   `~/work/plan-review-dev` (the development copy).
2. On the host, in the installed copy, install the dependencies and build the page:

   ```sh
   cd ~/work/plan-review
   npm ci
   npm run build
   ```

3. In the development copy, install its own dependencies and turn on the type-check hook for
   commits:

   ```sh
   cd ~/work/plan-review-dev
   npm ci
   git config core.hooksPath .githooks
   ```

   If you intend to run `npm test`, install Chromium as described in "What you need".
4. Export your Claude Code token, then build the image:

   ```sh
   export CLAUDE_CODE_OAUTH_TOKEN=...
   bin/dev-claude build
   ```

5. Make sure that everything under "What you need" is in place, and that the Codex volume holds a
   login.

## Start the web server

1. Open a shell in the container, then start the server:

   ```sh
   bin/dev-claude shell
   node /opt/plan-review/src/web.ts
   ```

   The server listens on port 8090, which the container publishes to the host. To use another port,
   start the server with the port as its argument (`node /opt/plan-review/src/web.ts <port>`). Also
   add a matching `ports` line to `compose.cc.yaml`, run `bin/dev-claude down` and start the
   container again so that the line takes effect, and open `http://localhost:<port>/` instead.
2. On the host, open **http://localhost:8090/** in your browser.
3. Fill in the task and the project directory, then press Start. The project directory must be the
   top-level directory of a git repository. A subdirectory is refused.
4. Follow the run in the page, and answer its questions there. Any open tab can answer, and a
   second window shows the same run.
5. **Stop task** ends the current run (exit code 130). The server keeps running and is ready for the
   next task.
6. **Ctrl+C** in the server's terminal ends the server. Every open tab is told that the server is
   ending.

If the server reports that "the page has not been built", run `npm run build` on the host in
`~/work/plan-review`, then start the server again.

## Run from the terminal instead

Inside the container:

```sh
node /opt/plan-review/src/main.ts "task description" [project directory]
```

Or from the host, in the development copy:

```sh
bin/dev-claude review "task description" [project directory]
```

You answer the questions in the terminal. Ctrl+C interrupts the run (exit code 130); the records are
kept and the usage summary is printed.

## Deploying an update (after making a change)

A change reaches real runs only once it is in the installed copy. Every time you make a change, do
the following:

1. **Test and commit in the development copy.**

   ```sh
   cd ~/work/plan-review-dev   # or /workspace inside the development container
   npm test
   git commit ...
   ```

   The pre-commit hook runs `npm run check` and refuses a commit that has a type error. The
   end-to-end tests need the Chromium setup from "What you need".
2. **Pull into the installed copy, on the host.**

   ```sh
   cd ~/work/plan-review
   git pull ~/work/plan-review-dev main
   ```

3. **Check whether the dependencies changed.**

   ```sh
   git diff --name-only ORIG_HEAD HEAD | grep package-lock.json
   ```

4. **Reinstall the dependencies** if step 3 printed `package-lock.json`:

   ```sh
   npm ci
   ```

   If you're unsure, run it anyway; it does no harm.
5. **Rebuild the page, every time.** The page also contains code from outside `web/`, so rebuild it
   after every pull:

   ```sh
   npm run build
   ```
6. **Restart the web server.** It loads its code only at startup. Press Ctrl+C in its terminal, then
   start it again with `node /opt/plan-review/src/web.ts`.
7. **Reload every open browser tab.** A tab reconnects by itself, but it keeps running the old page
   until you reload it.
8. **Terminal runs** pick up the change the next time they start. No further step is needed.

## Settings

The settings are read in this order, and each one overrides the one before:

1. the built-in defaults;
2. `config.json` in the installed copy (applies to every project);
3. `<project>/plan-review/config.json` (applies to one project).

Useful keys are `claudeModel`, `codexModel` and `ignorePaths`. `ignorePaths` lists files that may
change during a run without being counted as a change to the project, for example
`.devcontainer/claude.json`. If a file holds invalid JSON, a wrong type or an unknown key, Interloq
stops before it calls any agent.

## Where the results go

Everything is recorded in `<project>/plan-review/`:

- `conversation.md`: the whole exchange in readable form, in order;
- `requirements.md`: your agreed requirements;
- `plan.md`: the plan;
- the review rounds, the issue logs and `usage.jsonl` (the cost of each agent call).

When a new run starts, the previous run's records are moved to `plan-review/archive-<time>/`
automatically.

## For developers

How the program works, the rules for changing it, the decided behaviour and the facts established
so far are in [CLAUDE.md](CLAUDE.md). The design history is in [docs/history.md](docs/history.md),
and the reviews are in [docs/](docs/).
