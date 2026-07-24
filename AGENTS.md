# Agent Notes

See also `agent.md` for userscript authoring rules (version bumping, `.user.js`-only for new scripts, manual injection for live testing, EN/CZ localization checks).

- When modifying any userscript in this repository, always increment the `@version` header in the edited script.
- Use the next patch version by default unless the change clearly requires a different versioning step.
- For new userscripts, create only the `.user.js` file. Do not add a legacy non-`.user.js` shim unless the user explicitly asks for it.
- The integrated browser does not run Tampermonkey/Violentmonkey automatically, so live userscript testing requires manual script injection.
- When testing message-detail flows, watch for page localization and verify the behavior in both English and Czech labels/texts, not just one language variant.

## Cursor Cloud specific instructions

This repo is a collection of browser userscripts (`*.user.js` at the repo root) plus two small Node dev-tooling packages: `test/` and `tools/`. There is no build step, no database, and no always-on backend service. Standard commands live in `test/package.json`, `tools/package.json`, `test/README.md`, and `README.md`.

### Services / how to run

- **browser-bridge dev server** (`tools/`): `cd tools && npm start` (serves on `127.0.0.1:8766`). No dependencies to install. Check it with `npm run bridge:health` and `npm run bridge:diagnostics`. It serves select userscripts as static files and buffers diagnostics posted by the `browser-bridge.user.js` helper. Only needed for the bookkit-fulltext live-reload dev workflow and remote-control CLI.
- **Userscripts themselves**: no service. They are installed into a browser userscript manager (see `README.md` install table) or injected manually for testing.

### Lint / test / build

- No linter and no build system exist in this repo (no ESLint/Prettier/tsconfig/bundler).
- **Fulltext unit tests** (pure Node, no deps, no Chrome, no network): `cd tools && npm run test:fulltext` (runs `node --test ../test/bookkit-fulltext-search.test.js`).
- **Puppeteer E2E** (`test/`): requires `npm install` in `test/` (installs `puppeteer-core`) plus an external Chrome and outbound network to `https://try.jsonata.org/`.
  - Chrome is preinstalled at `/usr/local/bin/google-chrome`. The test scripts default `executablePath` to a Windows path, so you MUST set `CHROME_PATH=/usr/local/bin/google-chrome` before running them: e.g. `cd test && CHROME_PATH=/usr/local/bin/google-chrome npm run inspect-jsonata-models`.
- **Known gotcha — `test/test-jsonata-java-checker.js` currently fails**: it injects `../jsonata-java-checker.js`, which is only a `@require` shim (real code lives in `jsonata-java-checker.user.js`). `page.addScriptTag` does not resolve `@require`, so the userscript button is never created and the test times out. This is a pre-existing repo issue, not an environment problem. The environment itself is verified working via `npm run inspect-jsonata-models` and by injecting the real `.user.js` (the button reaches the `Java check: OK` state on the live page).
