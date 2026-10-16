// End-to-end check of jira-attachment-preview.user.js: a fake Jira issue page, REST attachment
// metadata and attachments are served locally and opened in real Chrome (puppeteer-core).
// The userscript is injected like Tampermonkey did on IDSM-6362: only after Jira's first head script
// ran. The HTML case loads D3 from cdnjs.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "jira-attachment-preview.user.js"), "utf8");
// Tampermonkey only runs the script in the top frame of matching pages.
const INJECTED = `if (window.top === window && location.protocol.startsWith("http")) {
  const run = () => {\n${SCRIPT}\n};
  const observer = new MutationObserver(() => window.__jiraHeadRan && (observer.disconnect(), run()));
  observer.observe(document, { childList: true, subtree: true });
}`;

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8"><title>dash</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script></head>
<body><h1>Dashboard č</h1><div id="chart"></div><pre id="probe"></pre><script>
const probe = {};
try { probe.parentDoc = !!parent.document.body; } catch (e) { probe.parentDoc = "blocked:" + e.name; }
try { probe.cookie = document.cookie; } catch (e) { probe.cookie = "blocked:" + e.name; }
probe.origin = String(self.origin);
probe.d3 = typeof d3;
if (window.d3) {
  const svg = d3.select("#chart").append("svg").attr("width", 200).attr("height", 100);
  svg.selectAll("rect").data([10, 40, 70]).enter().append("rect")
    .attr("x", (d, i) => i * 60).attr("y", d => 100 - d).attr("width", 50).attr("height", d => d);
}
document.getElementById("probe").textContent = JSON.stringify(probe);
</script></body></html>`;

const BIG = 10 * 1024 * 1024 + 1;
const FILES = {
  1: { name: "dash.html", type: "text/html", body: DASHBOARD },
  2: { name: "06-ts-list-incident.json", type: "text/plain; charset=UTF-8", body: '{"a":1,"b":["č"]}' },
  3: { name: "q.sql", type: "application/x-sql", body: Buffer.from([0x53, 0x45, 0x4c, 0x20, 0xe8]) },
  4: { name: "w1250.txt", type: "text/plain; charset=windows-1250", body: Buffer.from([0xe8, 0x9e]) },
  5: { name: "screenshot-1.png", type: "image/png", body: PNG },
  6: { name: "big.log", type: "text/plain", chunked: true, hideSize: true },
  7: { name: "missing.txt", type: "text/plain", status: 500 },
  8: { name: "archive.zip", type: "application/zip", body: "PK" },
  9: { name: "xss.txt", type: "text/plain", body: "<img src=x onerror=alert(1)><b>bold</b>" },
  10: { name: "doc.pdf", type: "application/pdf", body: "%PDF-1.4\n%%EOF" },
  11: { name: "big-declared.txt", type: "text/plain", declaredBig: true },
};

function bodyOf(file) {
  if (file.chunked || file.declaredBig || file.body === undefined) {
    return null;
  }
  return Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, "utf8");
}

function li(id, file) {
  const href = `/secure/attachment/${id}/${file.name}`;
  const mime = file.type.split(";")[0];
  return `<li class="attachment-content js-file-attachment" draggable="true" data-downloadurl="${mime}:${file.name}:http://HOST${href}" data-attachment-type="file">
<div class="attachment-thumb"><a href="${href}" title="${file.name}"><span class="aui-icon"></span></a></div>
<dl><dt><span class="blender"></span><a href="${href}" class="attachment-title" title="${file.name} - Latest">${file.name}</a></dt>
<dd class="attachment-size">1 kB</dd><dd class="attachment-date"><time>08.10.2026 12:22</time></dd></dl></li>`;
}

function issuePage() {
  const items = Object.entries(FILES).map(([id, file]) => li(id, file)).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="ajs-issue-key" content="IDSM-6362"><title>IDSM-6362</title>
<script>window.__jiraHeadRan = true;
// like Jira's base URL check: write into the page once it is ready, loaded, and a bit later
const jiraBanner = (from) => { const p = document.createElement("p"); p.className = "jira-banner"; p.textContent = from; document.body?.prepend(p); };
document.addEventListener("DOMContentLoaded", () => jiraBanner("ready"));
window.addEventListener("load", () => jiraBanner("load"));
setTimeout(() => jiraBanner("timer"), 300);</script>
<script src="/jira-head.js"></script>
<style>#attachment_thumbnails li{display:inline-block;width:200px;vertical-align:top;margin:4px;border:1px solid #ccc}
#attachment_thumbnails .attachment-thumb{height:120px;background:#f4f5f7}
#attachment_thumbnails .attachment-thumb > a{display:block;height:100%}
#attachment_thumbnails dt{width:180px;overflow:hidden}</style></head>
<body><div id="attachmentmodule"><ol id="attachment_thumbnails" class="item-attachments">${items}</ol></div>
<script>window.__jiraBodyRan = true;</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Jira's head loads external scripts; the parser waits on them before it reaches <body>.
  if (url.pathname === "/jira-head.js") {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end("window.__jiraHeadScriptRan = true;");
    }, 300);
    return;
  }
  if (url.pathname === "/browse/IDSM-6362") {
    // the script-src of jira.unicorn.com: the srcdoc frame inherits it, so the dashboard's CDN script must come inline
    res.writeHead(200, {
      "Content-Type": "text/html;charset=UTF-8",
      "Content-Security-Policy": "script-src 'unsafe-eval' 'unsafe-inline' 'self'; frame-ancestors 'self'; object-src 'none'",
    });
    res.end(issuePage());
    return;
  }
  if (url.pathname === "/rest/api/2/issue/IDSM-6362" && url.searchParams.get("fields") === "attachment") {
    const attachment = Object.entries(FILES).map(([id, file]) => {
      const size = file.declaredBig ? BIG : bodyOf(file)?.length;
      return { id, filename: file.name, mimeType: file.type.split(";")[0], ...(file.hideSize ? {} : { size }) };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ key: "IDSM-6362", fields: { attachment } }));
    return;
  }
  const m = url.pathname.match(/^\/secure\/attachment\/(\d+)\/(.+)$/);
  const file = m && FILES[m[1]];
  if (!file || decodeURIComponent(m[2]) !== file.name) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (file.status) {
    res.writeHead(file.status);
    res.end("err");
    return;
  }
  if (file.chunked) {
    // no Content-Length, 11 MiB
    res.writeHead(200, { "Content-Type": file.type });
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let n = 0;
    const write = () => {
      while (n < 11) {
        n += 1;
        if (!res.write(chunk)) {
          res.once("drain", write);
          return;
        }
      }
      res.end();
    };
    write();
    return;
  }
  if (file.declaredBig) {
    res.writeHead(200, { "Content-Type": file.type, "Content-Length": String(BIG) });
    res.end(Buffer.alloc(BIG, 0x61));
    return;
  }
  const body = bodyOf(file);
  res.writeHead(200, { "Content-Type": file.type, "Content-Length": body.length, "Content-Disposition": "attachment" });
  res.end(body);
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOO_LARGE = "Příloha je větší než 10 MB, náhled se neotevře.";
const LOAD_FAILED = "Přílohu se nepodařilo načíst.";
const NOT_FOUND = "Příloha s tímto názvem na issue není.";

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: "new",
    args: ["--no-first-run"],
  });

  async function newPage() {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(INJECTED);
    return page;
  }

  try {
    const page = await newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/browse/IDSM-6362`);
    await sleep(400);

    const state = await page.evaluate(() =>
      [...document.querySelectorAll("li.attachment-content")].map((l) => {
        const b = l.querySelectorAll(".gm-jap-btn");
        return {
          name: l.querySelector("a.attachment-title").textContent,
          btns: b.length,
          inThumb: b[0]?.parentElement?.classList.contains("attachment-thumb") ?? null,
          href: b[0]?.getAttribute("href") ?? null,
          target: b[0]?.target ?? null,
          label: b[0]?.getAttribute("aria-label") ?? null,
          title: b[0]?.title ?? null,
        };
      }),
    );
    const supported = state.filter((s) => s.name !== "archive.zip");
    check("zip has no eye", state.find((s) => s.name === "archive.zip").btns === 0);
    check("one eye per supported attachment, overlaid on the thumbnail", supported.every((s) => s.btns === 1 && s.inThumb), state.map((s) => `${s.name}:${s.btns}`));
    check("eye link: reloadable issue URL with the file name, new tab", state[0].href === `${base}/browse/IDSM-6362?viewAttachment=dash.html` && state[0].target === "_blank", state[0]);
    check("aria-label and title", state[0].label === "Náhled: dash.html" && state[0].title === "Náhled: dash.html");

    const geometry = await page.evaluate(() => {
      const b = document.querySelector(".gm-jap-btn");
      const r = b.getBoundingClientRect();
      const t = b.parentElement.getBoundingClientRect();
      const svg = b.querySelector("svg").getBoundingClientRect();
      return {
        size: [Math.round(r.width), Math.round(r.height)],
        icon: [Math.round(svg.width), Math.round(svg.height)],
        topRight: Math.round(t.right - r.right) === 8 && Math.round(r.top - t.top) === 8,
        hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".gm-jap-btn") === b,
      };
    });
    check("overlay: 44px button with 32px icon in the top right corner, clickable", geometry.size.join() === "44,44" && geometry.icon.join() === "32,32" && geometry.topRight && geometry.hit, geometry);

    // Jira replaces the module content
    await page.evaluate(() => {
      const ol = document.querySelector("#attachment_thumbnails");
      ol.innerHTML = ol.innerHTML.replace(/<a class="gm-jap-btn[^]*?<\/a>/g, "");
    });
    await sleep(400);
    const rerender = await page.evaluate(() => [...document.querySelectorAll("li.attachment-content")].map((l) => l.querySelectorAll(".gm-jap-btn").length));
    check("re-render restores one eye each", rerender.join("") === "11111110111", rerender);

    await page.evaluate(() => {
      const thumb = document.querySelector("li.attachment-content .attachment-thumb");
      thumb.appendChild(thumb.querySelector(".gm-jap-btn").cloneNode(true));
    });
    await sleep(400);
    check("duplicate collapses to one", (await page.evaluate(() => document.querySelector("li.attachment-content").querySelectorAll(".gm-jap-btn").length)) === 1);

    const mutations = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const o = new MutationObserver((l) => (n += l.length));
          o.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          setTimeout(() => {
            o.disconnect();
            resolve(n);
          }, 1500);
        }),
    );
    check("DOM is quiet after decoration", mutations === 0, mutations);
    check("title link unchanged", await page.evaluate(() => document.querySelector("a.attachment-title").getAttribute("href") === "/secure/attachment/1/dash.html"));

    // list view (Jira re-renders the list when switching): the eye goes right after the name
    await page.evaluate(() => {
      const ol = document.querySelector("#attachment_thumbnails");
      ol.id = "file_attachments";
      ol.replaceChildren(...[...ol.children].map((item) => item.cloneNode(true)));
    });
    await sleep(400);
    const list = await page.evaluate(() =>
      [...document.querySelectorAll("li.attachment-content")].map((l) => {
        const b = l.querySelectorAll(".gm-jap-btn");
        return `${b.length}:${b[0] ? b[0].previousElementSibling?.classList.contains("attachment-title") : "-"}`;
      }),
    );
    check("list view: one eye after the title", list.filter((x) => x !== "0:-").every((x) => x === "1:true") && list.length === 11, list);

    // a real click opens the preview URL in a new tab
    {
      await page.evaluate(() => {
        const ol = document.querySelector("#file_attachments");
        ol.id = "attachment_thumbnails";
        ol.replaceChildren(...[...ol.children].map((item) => item.cloneNode(true)));
      });
      await sleep(400);
      const created = new Promise((resolve) => browser.once("targetcreated", resolve));
      await (await page.$(".gm-jap-btn")).click();
      const target = await created;
      check("click opens new tab with the preview URL", target.url() === `${base}/browse/IDSM-6362?viewAttachment=dash.html`, target.url());

      // The opened tab starts without history. It needs the userscript too: inject and reload,
      // which keeps the history as it is.
      const opened = await target.page();
      await opened.evaluateOnNewDocument(INJECTED);
      await opened.reload();
      await sleep(2500);
      check("history: the issue page sits behind the preview", (await opened.evaluate(() => history.length)) === 2);
      await opened.reload();
      await sleep(2500);
      check("history: reload adds nothing", (await opened.evaluate(() => history.length)) === 2);
      await opened.goBack();
      await sleep(1500);
      const back = await opened.evaluate(() => ({ url: location.href, module: !!document.querySelector("#attachmentmodule"), jira: window.__jiraBodyRan === true }));
      check("history: Back shows the real issue page", back.url === `${base}/browse/IDSM-6362` && back.module && back.jira, back);
      await opened.goForward();
      await sleep(2500);
      const forward = await opened.evaluate(() => ({ url: location.href, title: document.title, frame: !!document.querySelector("iframe.gm-jap-frame"), body: document.body?.innerText.slice(0, 80) }));
      check("history: Forward shows the preview again", forward.title === "dash.html" && forward.frame, forward);
      await opened.close();
    }

    // Content in the DOM is not enough: the tab must paint (window.stop() before <body> froze it).
    async function painted(p) {
      return p.evaluate(() =>
        Promise.race([
          new Promise((resolve) => requestAnimationFrame(() => resolve(true))),
          new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
        ]),
      );
    }

    async function preview(name, wait = 1500) {
      const p = await newPage();
      await p.goto(`${base}/browse/IDSM-6362?viewAttachment=${encodeURIComponent(name)}`);
      await sleep(wait);
      return p;
    }

    // HTML
    {
      const p = await preview("dash.html", 3500);
      const top = await p.evaluate(() => ({
        title: document.title,
        url: location.href,
        jira: [window.__jiraHeadScriptRan, window.__jiraBodyRan],
        banners: document.querySelectorAll(".jira-banner").length,
        frames: document.querySelectorAll("iframe").length,
        sandbox: document.querySelector("iframe")?.getAttribute("sandbox"),
        hasSrcdoc: !!document.querySelector("iframe")?.srcdoc,
        bodyChildren: document.body.children.length,
        frameFills: (() => {
          const r = document.querySelector("iframe").getBoundingClientRect();
          return r.width === innerWidth && r.height === innerHeight;
        })(),
      }));
      check("html: Jira page scripts after the takeover did not run", top.jira.every((ran) => !ran), top.jira);
      check("html: Jira code that ran before the takeover left nothing in the page", top.banners === 0, top.banners);
      check("html: the preview tab actually paints", await painted(p));
      check("html: one sandboxed srcdoc frame filling the window", top.frames === 1 && top.bodyChildren === 1 && top.hasSrcdoc && top.frameFills, top);
      check("html: sandbox exact", top.sandbox === "allow-scripts allow-popups allow-forms allow-modals allow-downloads");
      check("html: tab title is filename", top.title === "dash.html");
      const inner = async () => {
        const frame = p.frames().find((f) => f !== p.mainFrame());
        return frame.evaluate(() => ({
          rects: document.querySelectorAll("svg rect").length,
          probe: JSON.parse(document.getElementById("probe").textContent || "{}"),
          h1: document.querySelector("h1").textContent,
        }));
      };
      const first = await inner();
      check("html: D3 renders charts", first.rects === 3 && first.probe.d3 === "object", first);
      check("html: no access to Jira DOM / cookies, opaque origin", String(first.probe.parentDoc).startsWith("blocked") && String(first.probe.cookie).startsWith("blocked") && first.probe.origin === "null", first.probe);
      check("html: UTF-8 default decoding", first.h1 === "Dashboard č", first.h1);

      await p.reload();
      await sleep(3500);
      const again = await inner();
      check("html: reload shows the preview again", again.rects === 3 && p.url().endsWith("?viewAttachment=dash.html") && (await p.title()) === "dash.html", again.rects);

      // a new version is uploaded under the same name: the open tab picks it up without a reload
      FILES[12] = { ...FILES[1], body: DASHBOARD.replace("Dashboard č", "Dashboard v2") };
      await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await sleep(3500);
      const updated = await inner();
      check("update: newer upload of the same name replaces the content", updated.h1 === "Dashboard v2" && updated.rects === 3, updated.h1);
      const frameAfterUpdate = await p.evaluateHandle(() => document.querySelector("iframe"));
      await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await sleep(800);
      check("update: no reload while nothing changed", await p.evaluate((f) => document.querySelector("iframe") === f, frameAfterUpdate));

      await p.reload();
      await sleep(3500);
      check("update: reload opens the newest upload", (await inner()).h1 === "Dashboard v2");

      // both versions deleted: the open tab keeps what it shows
      delete FILES[1];
      delete FILES[12];
      await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await sleep(800);
      check("update: deleted attachment keeps the last content", (await inner()).h1 === "Dashboard v2");
      await p.close();
    }

    {
      const p = await preview("dash.html");
      check("deleted attachment: not-found message", (await p.evaluate(() => document.body.innerText.trim())) === NOT_FOUND);
      await p.close();
    }

    {
      const p = await preview("06-ts-list-incident.json");
      const r = await p.evaluate(() => ({ pre: document.querySelector("pre")?.textContent, title: document.title }));
      check("json: formatted in pre", r.pre === '{\n  "a": 1,\n  "b": [\n    "č"\n  ]\n}' && r.title === "06-ts-list-incident.json", r);
      check("json: the preview tab actually paints", await painted(p));
      check("json: no Jira banners in the page", (await p.evaluate(() => document.querySelectorAll(".jira-banner").length)) === 0);
      await p.close();
    }

    {
      const p = await preview("q.sql");
      const r = await p.evaluate(() => document.querySelector("pre")?.textContent);
      check("sql: text in pre, UTF-8 default", r === "SEL \uFFFD", r);
      await p.close();
    }

    {
      const p = await preview("w1250.txt");
      const r = await p.evaluate(() => document.querySelector("pre")?.textContent);
      check("txt: charset from Content-Type", r === "čž", r);
      await p.close();
    }

    {
      const p = await preview("xss.txt");
      const r = await p.evaluate(() => ({ pre: document.querySelector("pre")?.textContent, markup: document.querySelectorAll("img,b").length }));
      check("txt: markup is not interpreted", r.markup === 0 && r.pre.startsWith("<img"), r);
      await p.close();
    }

    {
      const p = await preview("screenshot-1.png");
      const r = await p.evaluate(() => ({ w: document.querySelector("img")?.naturalWidth, title: document.title }));
      check("png: shown in img", r.w === 1 && r.title === "screenshot-1.png", r);
      await p.close();
    }

    {
      const p = await preview("doc.pdf");
      const r = await p.evaluate(() => ({ src: document.querySelector("iframe")?.src ?? "", sandbox: document.querySelector("iframe")?.hasAttribute("sandbox") }));
      check("pdf: built-in viewer in a frame, tab keeps its URL", r.src.startsWith("blob:") && !r.sandbox && p.url().endsWith("?viewAttachment=doc.pdf"), r);
      await p.close();
    }

    {
      const p = await preview("big.log", 2500);
      check("big (no size, chunked): over-limit message", (await p.evaluate(() => document.body.innerText.trim())) === TOO_LARGE);
      await p.close();
    }

    {
      const p = await preview("big-declared.txt");
      check("big (REST size): over-limit message", (await p.evaluate(() => document.body.innerText.trim())) === TOO_LARGE);
      await p.close();
    }

    {
      const p = await preview("missing.txt");
      check("http 500: error message", (await p.evaluate(() => document.body.innerText.trim())) === LOAD_FAILED);
      await p.close();
    }

    {
      const p = await preview("nope.txt");
      check("unknown file name: not-found message", (await p.evaluate(() => document.body.innerText.trim())) === NOT_FOUND);
      await p.close();
    }

    {
      const p = await preview("archive.zip");
      check("unsupported type: message", (await p.evaluate(() => document.body.innerText.trim())) === "Tento typ přílohy náhled nemá.");
      await p.close();
    }

    {
      const p = await newPage();
      await p.goto(`${base}/browse/IDSM-6362?viewAttachment=`);
      await sleep(600);
      check("empty file name: normal issue page", await p.evaluate(() => !!document.querySelector("#attachmentmodule") && window.__jiraBodyRan === true));
      await p.close();
    }

    check("no page errors on issue page", errors.length === 0, errors);
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
