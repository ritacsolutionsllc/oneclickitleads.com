# Create PR

Create a new branch, commit specified changes, push, and open a draft PR.

## Steps

1. Determine branch name using pattern `<type>/<short-desc>` based on the change description
2. Create the branch from `main` (or the current default branch)
3. Push all changed/new files via `mcp__github__push_files` in a single commit
4. Open a **draft** pull request with:
   - A concise title (under 70 characters)
   - Summary bullet points describing what changed and why
   - A test plan checklist
5. Check CI status via `mcp__github__pull_request_read` (method: `get_check_runs`) and report results
6. If CI is still running, note that and advise checking back — do not poll indefinitely
