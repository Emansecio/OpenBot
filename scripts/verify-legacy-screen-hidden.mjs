const port = Number.parseInt(process.env.OPENBOT_CDP_PORT || "9334", 10);
const endpoint = `http://127.0.0.1:${port}/json/list`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const targets = await (await fetch(endpoint)).json();
    target = targets.find((entry) => entry.type === "page" && entry.title === "OpenBot")
      ?? targets.find((entry) => entry.type === "page");
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) throw new Error("OpenBot CDP page unavailable");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("OpenBot CDP evaluation timed out")), 5_000);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
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
    },
  }));
});
socket.close();

if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "CDP evaluation failed");
const matches = result.result?.result?.value ?? [];
const visible = matches.filter((entry) => !entry.hidden && entry.display !== "none" && entry.visibleRects > 0);
console.log(JSON.stringify({ matches, visible }, null, 2));
if (visible.length > 0) process.exitCode = 1;
