# Agent Notes

- When modifying any userscript in this repository, always increment the `@version` header in the edited script.
- Use the next patch version by default unless the change clearly requires a different versioning step.
- For new userscripts, create only the `.user.js` file. Do not add a legacy non-`.user.js` shim unless the user explicitly asks for it.
- The integrated browser does not run Tampermonkey/Violentmonkey automatically, so live userscript testing requires manual script injection.
- When testing message-detail flows, watch for page localization and verify the behavior in both English and Czech labels/texts, not just one language variant.
