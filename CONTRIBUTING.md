# Contributing

Thanks for contributing to Metapi.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file:

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

3. Initialize the default SQLite database:

```bash
npm run db:migrate
```

## Common Commands

### App development

```bash
npm run dev
npm run dev:server
restart.bat
```

- `npm run dev` starts the Fastify server and Vite together.
- `npm run dev:server` runs only the backend watcher.
- `restart.bat` is the Windows-friendly restart entrypoint; it forwards to `scripts\dev\restart.bat`, clears stale listeners, and starts `npm run dev`.

### Docs

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

### Desktop

```bash
npm run dev:desktop
npm run build:desktop
npm run dist:desktop
npm run package:desktop
```

`npm run dev:desktop` expects the backend on `http://127.0.0.1:4000` and the Vite frontend on `http://127.0.0.1:5173`.

### Test, build, and smoke checks

```bash
npm test
npm run test:watch
npm run build
npm run build:web
npm run build:server
npm run smoke:db
npm run smoke:db:sqlite
npm run smoke:db:mysql -- --db-url mysql://user:pass@host:3306/db
npm run smoke:db:postgres -- --db-url postgres://user:pass@host:5432/db
```

## Windows Notes

- Prefer `Copy-Item` or Explorer copy/paste over `cp` if you are working in PowerShell or `cmd.exe`.
- If a previous dev process keeps ports busy, use `restart.bat` instead of manually hunting PIDs.
- If dependencies or `.cmd` shims look broken after a Node.js upgrade, rerun `npm install` before assuming the scripts are wrong.

## Pull Request Guidelines

- Keep PRs focused and small.
- Add or update tests for behavior changes.
- Update docs when user-facing behavior, commands, ports, or configuration change.
- Run the checks that match your change set before opening a PR:
  - docs only: `npm run docs:build`
  - app code: `npm test` and the relevant `npm run build:*`
  - runtime DB work: one of the `npm run smoke:db*` commands
- Avoid committing runtime data (`data/`) or temporary files (`tmp/`).

## Commit Messages

Use concise messages with clear scope, for example:

- `feat: add token route health guard`
- `fix: handle empty model list in dashboard`
- `docs: clarify docker env setup`
