import { connectCdp } from "./e2e-runtime.mjs";

const port = Number.parseInt(process.env.OPENBOT_CDP_PORT || "9334", 10);
const endpoint = `http://127.0.0.1:${port}/json/list`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const targets = await (await fetch(endpoint, { signal: AbortSignal.timeout(2_000) })).json();
    target = targets.find((entry) => entry.type === "page" && entry.title === "OpenBot")
      ?? targets.find((entry) => entry.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) throw new Error("OpenBot CDP page unavailable");

const cdp = connectCdp(target.webSocketDebuggerUrl, { readyTimeoutMs: 5_000, callTimeoutMs: 5_000 });
await cdp.ready;
const result = await cdp.send("Runtime.evaluate", {
  expression: `(() => {
    const label = /^(?:Can't reach .+ screen|.+['’]s screen)$/i;
    const matches = [...document.querySelectorAll("div, section, aside")]
      .filter((element) => label.test((element.textContent || "").replace(/\\s+/g, " ").trim()));
    return matches.map((element) => ({
      text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
      hidden: Boolean(element.closest('[data-openbot-hide="1"]')),
      display: getComputedStyle(element).display,
      visibleRects: element.getClientRects().length,
    }));
  })()`,
  returnByValue: true,
});
cdp.close();

if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "CDP evaluation failed");
const matches = result.result?.value ?? [];
const visible = matches.filter((entry) => !entry.hidden && entry.display !== "none" && entry.visibleRects > 0);
console.log(JSON.stringify({ matches, visible }, null, 2));
if (visible.length > 0) process.exitCode = 1;
