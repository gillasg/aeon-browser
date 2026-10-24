import { createServer } from "node:http";

// Local pages for the test bench. They mirror the shapes browserkit's own test site uses (a table
// with embedded data, a virtualized list, and a form), so a task can be solved by reading rather
// than by any site-specific trick. Nothing here touches the network.

const DEALS = `<!doctype html><html><head><title>Deals</title></head><body>
<h1>Deals</h1>
<table><tr><th>Item</th><th>Price</th></tr>
<tr><td>Phone</td><td>699</td></tr><tr><td>Laptop</td><td>1299</td></tr></table>
</body></html>`;

const VIRTUAL = `<!doctype html><html><head><title>Jobs</title></head><body>
<div id="scroller" style="height:300px;overflow-y:auto"><div id="inner" style="position:relative"></div></div>
<script>
const ROW = 40, COUNT = 150, scroller = document.getElementById("scroller"), inner = document.getElementById("inner");
inner.style.height = ROW * COUNT + "px";
function draw() {
  const first = Math.floor(scroller.scrollTop / ROW), last = Math.min(COUNT, first + 10);
  inner.innerHTML = "";
  for (let i = first; i < last; i++) {
    const row = document.createElement("div");
    row.setAttribute("data-index", String(i));
    row.style.cssText = "position:absolute;top:" + i * ROW + "px;height:" + ROW + "px";
    row.textContent = "Job " + i + (i === 120 ? " Yet to apply" : " Applications closed");
    inner.append(row);
  }
}
scroller.addEventListener("scroll", draw);
draw();
</script></body></html>`;

const FORM = `<!doctype html><html><head><title>Apply</title></head><body>
<form id="form"><label>Name <input name="name"></label>
<label>Email <input name="email"></label>
<button type="submit">Send</button></form>
<p id="result">Not sent</p>
<script>
document.getElementById("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = new FormData(event.target).get("name");
  document.getElementById("result").textContent = "Thanks " + name;
});
</script></body></html>`;

export async function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const page =
      url.pathname === "/deals"
        ? DEALS
        : url.pathname === "/virtual"
          ? VIRTUAL
          : url.pathname === "/form"
            ? FORM
            : undefined;
    if (!page) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the fixture server");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
