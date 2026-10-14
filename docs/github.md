# First GitHub push

The scaffold targets https://github.com/fuzzycloud/office-office. The Codex session could write project files but `.git` was mounted read-only, so no repository, commit, remote or push was created by the agent.

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

GitHub Actions checks the scaffold and publishes the image to GHCR on main. After the first successful image publication, change package visibility to Public if anonymous pulls are intended. No Kamal or server deploy is configured.
