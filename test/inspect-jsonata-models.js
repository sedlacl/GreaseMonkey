const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      console.log("PAGE", msg.type(), msg.text());
    });

    await page.goto("https://try.jsonata.org/", { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.monaco?.editor?.getModels), { timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const details = await page.evaluate(() => {
      function looksLikeJsonDocument(value) {
        if (typeof value !== "string") {
          return false;
        }

        const trimmed = value.trim();
        if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
          return false;
        }

        try {
          JSON.parse(trimmed);
          return true;
        } catch (error) {
          return false;
        }
      }

      function looksLikeJsonataExpression(value) {
        if (typeof value !== "string") {
          return false;
        }

        const trimmed = value.trim();
        if (!trimmed) {
          return false;
        }

        return trimmed.startsWith("$") || trimmed.includes("Account") || trimmed.includes(".") || trimmed.includes("[") || trimmed.includes("(");
      }

      const models = window.monaco.editor.getModels();
      const metas = models.map((model, index) => ({
        index,
        uri: model.uri?.toString?.() || null,
        languageId: typeof model.getLanguageId === "function" ? model.getLanguageId() : null,
        value: typeof model.getValue === "function" ? model.getValue() : null,
        lineCount: typeof model.getLineCount === "function" ? model.getLineCount() : null,
      }));

      let selected;
      if (metas.length >= 4 && metas.every((meta) => /^inmemory:\/\/model\/\d+$/i.test(meta.uri || ""))) {
        selected = {
          source: "monaco-models-ordered",
          inputPreview: metas[0].value.slice(0, 80),
          bindingsPreview: metas[1].value.slice(0, 80),
          expressionPreview: metas[2].value.slice(0, 80),
          resultPreview: metas[3].value.slice(0, 80),
        };
      } else {
        const jsonLikeMetas = metas.filter((meta) => looksLikeJsonDocument(meta.value));
        const expressionLikeMeta = metas.find((meta) => looksLikeJsonataExpression(meta.value) && !looksLikeJsonDocument(meta.value));
        const inputByContent = jsonLikeMetas[0] || metas[0] || null;
        const resultByContent = jsonLikeMetas.length > 1 ? jsonLikeMetas[jsonLikeMetas.length - 1] : metas[metas.length - 1] || null;
        const bindingsByOrder = metas[1] || null;

        selected = {
          source: "monaco-models-content",
          inputPreview: inputByContent?.value?.slice(0, 80) || null,
          bindingsPreview: bindingsByOrder?.value?.slice(0, 80) || null,
          expressionPreview: expressionLikeMeta?.value?.slice(0, 80) || null,
          resultPreview: resultByContent?.value?.slice(0, 80) || null,
        };
      }

      return { metas, selected };
    });

    console.log(JSON.stringify(details, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
