# First GitHub push

The scaffold targets https://github.com/fuzzycloud/office-office. Git is configured with the `origin` remote pointing to this repository. The commands below describe the initial setup for a fresh checkout.

Run from the repository root in your own terminal:

```sh
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/fuzzycloud/office-office.git
git push -u origin main
```

The README already exists, so do not append another heading. `.gitignore` excludes credentials, runtime board data, build outputs and dependencies. Review staged files before committing.

GitHub Actions runs checks and E2E tests for main/PR changes; version tags publish release images to GHCR after the same checks pass. After the first successful image publication, change package visibility to Public if anonymous pulls are intended. Operator-specific server deployment is intentionally kept outside this repository.
