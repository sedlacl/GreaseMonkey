This folder contains browser-based checks for live pages used by the userscripts.

Install dependencies:

```powershell
cd test
npm install --registry=https://registry.npmjs.org
```

Run the JSONata Monaco model inspection:

```powershell
npm run inspect-jsonata-models
```

Run the end-to-end Java checker button test:

```powershell
npm run test-jsonata-java-checker
```

That test loads the local `jsonata-java-checker.js`, injects a mock TamperMonkey `GM_xmlhttpRequest`, clicks the `Java check` button, and asserts that the button reaches the `OK` state with the expected request payload.

If Chrome is installed in a non-default location, set `CHROME_PATH` before running the script.
