# Working in OpenSlope

## Keep routine development fast

Choose validation for the changed behavior. A request to sync or commit existing
work does not request a complete repository verification run.

- For a Git-only sync, preserve local work and verify the resulting history,
  index, and working tree. Run relevant tests if conflict resolution changes code.
- Before committing, inspect the staged patch and run `git diff --cached --check`.
  Reuse successful checks that still cover the current changes. If validation is
  missing, run focused checks for the affected behavior.
- For documentation-only changes, check whitespace and the links or commands
  that changed. Do not launch compilers, browsers, or coverage for prose edits.
- For code edits, start with the affected tests and the component's type/lint
  checks. Run integration or browser tests when the changed flow needs them.
  Broaden to the affected component's fast suite when focused checks are
  insufficient. Avoid building unrelated components.
- Re-run checks when relevant source, dependencies, configuration, or integration
  assumptions change. Do not repeat an unchanged successful check just because
  the next action is a commit.
- Run `npm run verify` for an explicit full-validation request, release
  preparation, or broad changes across components or shared contracts. Explain
  what requires the full run before starting it. Coverage and the complete
  browser suite belong to that full run, not every local commit.
- Preserve the existing pre-push hook and CI checks. Do not bypass mandatory
  audits or silently reduce their coverage.

The existing commands and validation tiers are documented in
[CONTRIBUTING.md](CONTRIBUTING.md) and [tools/README.md](tools/README.md).

## Commit messages

Use a short conventional-commit title, a blank line, and `- ` bullet points
describing the concrete changes. Include validation results only for checks
actually run. Commit or push only when the user requests it.
