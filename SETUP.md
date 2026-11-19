# Setup guide — VS Code, Git, GitHub, and Claude

This walks through getting the project into VS Code, putting it under version control on GitHub, and using Claude inside VS Code to keep iterating on it.

## 1. Open the folder in VS Code

If you don't have VS Code yet, install it from <https://code.visualstudio.com/>.

Two ways to open this folder:

- **From Finder:** right-click the `Textbook` folder → *Open With → Visual Studio Code*.
- **From VS Code:** *File → Open Folder…* → select `Textbook`.

You should see the file tree on the left: `index.html`, `paper.html`, `contribute.html`, `papers/`, `js/`, `scripts/`, `.github/`, etc.

> **A note on OneDrive.** This folder lives in OneDrive, which is fine for editing in VS Code. Git operations will work, but commits can occasionally be slow if OneDrive is syncing at the same moment. If you ever see "permission denied" errors during a commit, pause OneDrive sync, retry, then resume.

## 2. Initialize Git and make the first commit

VS Code has a built-in Git panel (the branch icon in the left sidebar). The easiest first run is from the terminal inside VS Code — *View → Terminal* (or `` Ctrl+` ``):

```bash
git init
git add .
git commit -m "Initial commit: walking skeleton + RIS import automation"
```

You should also add a `.gitignore` so OS clutter doesn't get tracked:

```bash
cat > .gitignore <<'EOF'
.DS_Store
node_modules/
*.log
.vscode/settings.json
EOF
git add .gitignore && git commit -m "Add .gitignore"
```

## 3. Create the GitHub repo and push

1. On GitHub: <https://github.com/new>. Name it whatever you like — `annotated-bibliography` or similar. Leave it **empty** (don't add a README or .gitignore — you already have those).
2. Back in the VS Code terminal:

   ```bash
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git branch -M main
   git push -u origin main
   ```

   On first push GitHub will prompt you to authenticate. Easiest path: install the **GitHub CLI** (`brew install gh`), run `gh auth login`, choose HTTPS + a browser login. After that, pushes from VS Code or the terminal Just Work.

## 4. Wire up the site to your repo

Edit `js/github-api.js` and replace the placeholders:

```js
const GH_OWNER = "your-github-username";  // your GitHub login
const GH_REPO  = "your-repo-name";        // the repo you just created
```

Commit and push:

```bash
git add js/github-api.js
git commit -m "Wire site to GitHub repo"
git push
```

## 5. Enable GitHub Pages

On your repo: *Settings → Pages*.
Under *Build and deployment*, set **Source** to *Deploy from a branch*, **Branch** to `main`, folder `/ (root)`. Save.

After a minute the site is live at `https://<your-username>.github.io/<your-repo>/`.

## 6. Confirm the automation works

The first time a colleague (or you) does either of these:

- Adds a `papers/<id>.json` file via PR, **without** an `issue` field.
- Drops a real `.ris` file into `imports/`.

…the Actions defined in `.github/workflows/` will fire. Watch them under your repo's **Actions** tab.

If the action that creates issues errors with a 403, go to *Settings → Actions → General → Workflow permissions* and switch to **Read and write permissions**.

## 7. Day-to-day workflow in VS Code

VS Code's **Source Control** panel handles most things visually — staging, committing, pushing, pulling, branching. Useful keyboard shortcuts on macOS:

- `Cmd+Shift+G` — open Source Control panel
- `Ctrl+Shift+\`` — new terminal
- `Cmd+P` — quick-open any file by name

A normal change loop:

1. Edit a file.
2. Source Control panel shows it as modified.
3. Click the `+` next to the file to stage it.
4. Type a commit message at the top and press `Cmd+Enter`.
5. Click the sync icon (or run `git push`) to publish.

## 8. Using Claude inside VS Code

Two options, depending on how you installed Claude:

### Option A: Claude desktop app + this folder selected
You're already using this. The Claude desktop app has the `Textbook` folder mounted, so you can keep asking Claude (this conversation, or a new one) to edit files in here. Changes show up in VS Code as soon as the file is saved — you may need to focus the VS Code window for it to detect the change.

### Option B: Claude Code in VS Code's terminal
For a tighter loop, install Claude Code as a CLI and run it inside VS Code's integrated terminal:

```bash
npm install -g @anthropic-ai/claude-code
cd "/path/to/your/Textbook/folder"
claude
```

Then talk to Claude in the terminal. It reads and writes files in the current directory directly, and its edits appear immediately in VS Code's editor. See <https://docs.claude.com/en/docs/claude-code/overview> for setup and login.

### Tips for working productively with Claude on this project

- **Show, don't tell, when something's off.** Paste the error or the actual output, not a paraphrase. Claude can read your screen but not your assumptions.
- **Make commits between Claude sessions.** If a change goes wrong, `git restore .` brings everything back to the last commit. This is your safety net.
- **Ask before merging non-trivial PRs.** Have Claude review the diff (`git diff`) before you push — it's good at catching things like a missing tag escape or a forgotten field.
- **Treat `papers/*.json` as the source of truth.** Don't ask Claude to "remember" which papers you added — that's what the repo is for.

## 9. Troubleshooting

- **"Permission denied (publickey)"** when pushing — you're using SSH but haven't set up keys. Easiest fix: switch the remote to HTTPS: `git remote set-url origin https://github.com/<user>/<repo>.git`, then push.
- **Action fails with "Resource not accessible by integration"** — see step 6: enable read+write workflow permissions.
- **Site loads but shows no papers** — open the browser DevTools (Cmd+Option+I), check the Console and Network tabs. Most likely cause: `papers/index.json` references an id whose JSON file isn't in `papers/`.
- **GitHub rate limit (403) when browsing the site** — the unauthenticated API allows ~60 requests/hour per IP. For a larger team, swap in a Personal Access Token in `js/github-api.js`.

That's the whole loop. Happy annotating.
