// The conformance fixture site. One loopback server answers on two origins, 127.0.0.1:<port>
// (PRIMARY) and localhost:<port> (CROSS), so same-origin, cross-origin and out-of-process iframe
// cases are all deterministic. Every request lands in `log` as ground truth that does not come
// through the engine, and gates hold a response open until a test releases it, so slow pages and
// timeouts never need a sleep. Every element a test points at has a fixed pixel size, so hit
// tests and click points never depend on font metrics.
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const html = (title, body, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{margin:0;font:16px/20px sans-serif}button,input,select{box-sizing:border-box}</style>` +
  `${head}</head><body>${body}</body></html>`;

/** A solid-colour PNG, built by hand so the fixture needs no image files. */
export function solidPng(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

const BOX = "display:block;width:160px;height:40px;margin:0;padding:0";

const pages = {
  "/app": () =>
    html(
      "App",
      `<form id="f" style="position:relative;width:600px">
        <input id="name" aria-label="Name" style="${BOX}">
        <select id="color" aria-label="Color" style="${BOX}"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select>
        <button type="button" id="save" style="${BOX}" onclick="document.getElementById('out').textContent='saved '+document.getElementById('name').value+' '+document.getElementById('color').value">Save</button>
        <div style="position:relative;width:160px;height:40px">
          <input id="covered" aria-label="Covered" style="${BOX}">
          <div id="cover" style="position:absolute;left:0;top:0;width:160px;height:40px;background:#888"></div>
        </div>
        <button type="button" id="covered-btn" style="${BOX}" onclick="document.title='covered clicked'">Under</button>
        <div id="remount"><input id="live" aria-label="Live" style="${BOX}"></div>
      </form><p id="out" style="height:20px"></p>
      <script>
        // The "Under" button sits under a fixed overlay, exactly over its box.
        const b = document.getElementById('covered-btn').getBoundingClientRect();
        const o = document.createElement('div');
        o.id = 'overlay';
        o.style.cssText = 'position:absolute;left:'+b.left+'px;top:'+(b.top+scrollY)+'px;width:160px;height:40px;background:#444';
        document.body.appendChild(o);
        // React-style detach and remount: the first keystroke replaces the field with a fresh node.
        let swapped = false;
        document.getElementById('remount').addEventListener('focusin', () => {
          if (swapped) return; swapped = true;
          const fresh = document.createElement('input');
          fresh.id = 'live'; fresh.setAttribute('aria-label', 'Live'); fresh.style.cssText = '${BOX}';
          queueMicrotask(() => { const box = document.getElementById('remount'); box.replaceChildren(fresh); fresh.focus(); });
        });
      </script>`,
    ),
  "/spa": () =>
    html(
      "SPA home",
      `<a id="next" href="/spa/next" style="${BOX}" onclick="event.preventDefault();history.pushState({},'','/spa/next');document.title='SPA next';document.getElementById('view').textContent='next view'">Next</a><p id="view">home view</p>`,
    ),
  "/spa/next": () => html("SPA next", `<p id="view">next view (server)</p>`),
  "/bf/a": () => html("BF A", `<a id="to-b" href="/bf/b" style="${BOX}">To B</a>`),
  "/bf/b": () => html("BF B", `<p>page b</p>`),
  "/landed": () => html("Landed", `<p id="landed">landed</p>`),
  "/frames": ({ cross }) =>
    html(
      "Frames",
      `<iframe id="same" src="/frames/same" style="width:300px;height:100px"></iframe>
       <iframe id="cross" src="${cross}/frames/cross" style="width:300px;height:100px"></iframe>
       <iframe id="nest" src="${cross}/frames/n1" style="width:300px;height:200px"></iframe>`,
    ),
  "/frames/same": () =>
    html("Same", `<button style="${BOX}" onclick="this.textContent='same hit'">Same</button>`),
  "/frames/cross": () =>
    html("Cross", `<button style="${BOX}" onclick="this.textContent='cross hit'">Cross</button>`),
  "/frames/n1": ({ primary }) =>
    html(
      "N1",
      `<p>level 1</p><iframe src="${primary}/frames/n2" style="width:280px;height:150px"></iframe>`,
    ),
  "/frames/n2": ({ cross }) =>
    html(
      "N2",
      `<p>level 2</p><iframe src="${cross}/frames/n3" style="width:260px;height:100px"></iframe>`,
    ),
  "/frames/n3": () => html("N3", `<p id="deep">level 3 deep text</p>`),
  "/dialogs": () =>
    html(
      "Dialogs",
      `<button id="alert" style="${BOX}" onclick="alert('hello alert');document.getElementById('out').textContent='alert done'">Alert</button>
       <button id="confirm" style="${BOX}" onclick="document.getElementById('out').textContent='confirm '+confirm('sure?')">Confirm</button>
       <button id="prompt" style="${BOX}" onclick="document.getElementById('out').textContent='prompt '+prompt('name?','dflt')">Prompt</button>
       <input id="typed" aria-label="Typed" style="${BOX}" oninput="if(this.value.length===2)alert('mid input')">
       <p id="out" style="height:20px"></p>`,
    ),
  "/dialogs/onload": () => html("Onload dialog", `<p>loaded</p><script>alert('on load')</script>`),
  "/dialogs/frame": () =>
    html("Dialog frame", `<iframe src="/dialogs/inner" style="width:300px;height:100px"></iframe>`),
  "/dialogs/inner": () =>
    html(
      "Inner",
      `<button id="inner" style="${BOX}" onclick="this.textContent='inner '+confirm('in frame?')">Inner</button>`,
    ),
  "/upload": () =>
    html(
      "Upload",
      `<form method="post" action="/upload" enctype="multipart/form-data">
        <input type="file" id="file" name="file" aria-label="File" style="${BOX}">
        <button id="send" style="${BOX}">Send</button></form>`,
    ),
  "/download-page": () =>
    html(
      "Download",
      `<a id="dl" href="/download" download="report.txt" style="${BOX}">Get report</a>`,
    ),
  "/drag": () =>
    html(
      "Drag",
      `<div id="src" draggable="true" style="position:absolute;left:20px;top:20px;width:100px;height:100px;background:#36c"></div>
       <div id="dst" style="position:absolute;left:300px;top:20px;width:150px;height:150px;background:#ccc"></div>
       <p id="out" style="position:absolute;top:200px">none</p>
       <script>
        src.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'payload'));
        dst.addEventListener('dragover', e => e.preventDefault());
        dst.addEventListener('drop', e => { e.preventDefault(); out.textContent = 'dropped ' + e.dataTransfer.getData('text/plain'); });
       </script>`,
    ),
  "/csp": () =>
    html(
      "CSP",
      `<p id="out">strict</p><script>document.getElementById('out').textContent='inline ran'</script>`,
    ),
  "/network": ({ cross }) =>
    html(
      "Network",
      `<p id="out">idle</p><button id="go" style="${BOX}">Go</button>
       <script>
        go.onclick = async () => {
          const a = await fetch('/api/data?q=1').then(r => r.json());
          const x = new XMLHttpRequest(); x.open('POST', '/api/xhr'); x.setRequestHeader('content-type','application/json');
          await new Promise(d => { x.onload = d; x.send(JSON.stringify({hello: 'xhr'})); });
          const w = new Worker('/worker.js'); const wv = await new Promise(d => w.onmessage = e => d(e.data));
          const red = await fetch('/r/1').then(r => r.url.replace(location.origin, ''));
          const ctl = new AbortController(); const ab = fetch('/gate/abort', {signal: ctl.signal}).catch(e => e.name); ctl.abort(); const aborted = await ab;
          const f = document.createElement('iframe'); f.src = '${cross}/network/frame'; f.style.cssText = 'width:200px;height:50px'; document.body.appendChild(f);
          await new Promise(d => f.onload = d);
          out.textContent = ['data ' + a.value, 'xhr ' + x.status, 'worker ' + wv, 'redirect ' + red, 'abort ' + aborted].join(' | ');
        };
       </script>`,
    ),
  "/network/frame": () => html("Net frame", `<p>frame</p><script>fetch('/api/frame')</script>`),
  "/console": () =>
    html(
      "Console",
      `<button id="log" style="${BOX}" onclick="console.log('plain log', 1);console.warn('careful');console.error('bad thing');fetch('/console/broken')">Log</button>`,
    ),
  "/visual": () =>
    html(
      "Visual",
      `<div style="position:absolute;left:0;top:0;width:200px;height:200px;background:rgb(255,0,0)"></div>
       <div style="position:absolute;left:200px;top:0;width:200px;height:200px;background:rgb(0,0,255)"></div>
       <div style="position:absolute;left:0;top:200px;width:400px;height:200px;background:rgb(0,128,0)"></div>`,
    ),
  "/hangs": () =>
    html(
      "Hangs",
      `<button id="spin" style="${BOX}">Spin</button><a id="slow" href="/gate/slow" style="${BOX}">Slow</a>`,
    ),
  "/popups": () =>
    html(
      "Popups",
      `<button id="pop" style="${BOX}" onclick="window.open('/popup/a','_blank')">Open</button><a id="blank" href="/popup/b" target="_blank" style="${BOX}">New tab link</a>`,
    ),
  "/inert-main": ({ cross }) =>
    html(
      "Inert main",
      `<main inert aria-hidden="true"><h1>Background</h1><button style="${BOX}">Hidden action</button></main>
       <iframe src="${cross}/frames/cross" style="width:200px;height:50px"></iframe>
       <div role="dialog" aria-modal="true" aria-label="Consent" style="position:fixed;left:100px;top:100px;width:300px;height:120px;background:#fff">
         <p>Accept cookies?</p><button id="accept" style="${BOX}" onclick="this.textContent='accepted'">Accept</button></div>`,
    ),
  "/popup/a": () => html("Popup A", `<p>popup a</p>`),
  "/popup/b": () => html("Popup B", `<p>popup b</p>`),
  "/policy": () => html("Policy", `<p>allowed page</p>`),
  "/baseline": () => html("Baseline", `<p>fresh</p>`),
};

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

function apiRoute(path, req, res, body) {
  if (path === "/api/data") return (json(res, 200, { value: 42 }), true);
  if (path === "/api/xhr") return (json(res, 201, { got: body }), true);
  if (path === "/api/frame") return (json(res, 200, { frame: true }), true);
  if (path === "/data.json") return (json(res, 200, { items: [1, 2, 3], name: "fixture" }), true);
  if (path === "/worker.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end("fetch('/api/worker').then(r=>r.json()).then(v=>postMessage(v.worker))");
    return true;
  }
  if (path === "/api/worker") return (json(res, 200, { worker: "ok" }), true);
  return false;
}

function specialRoute(path, req, res, body) {
  if (path === "/r/1") return (res.writeHead(302, { location: "/r/2" }), res.end(), true);
  if (path === "/r/2") return (res.writeHead(302, { location: "/landed" }), res.end(), true);
  if (path === "/plain.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain text body\nline two\n");
    return true;
  }
  if (path === "/image.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(solidPng(40, 30, [0, 200, 100]));
    return true;
  }
  if (path === "/download") {
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="report.txt"',
    });
    res.end("report body 12345\n");
    return true;
  }
  if (path === "/auth") {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="fixture"',
      "content-type": "text/plain",
    });
    res.end("auth required");
    return true;
  }
  if (path === "/upload" && req.method === "POST") {
    const name = /filename="([^"]+)"/.exec(body)?.[1] ?? "none";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      html(
        "Uploaded",
        `<p id="got">got ${name} ${body.includes("upload payload") ? "with payload" : "empty"}</p>`,
      ),
    );
    return true;
  }
  if (path === "/console/broken") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
    return true;
  }
  return false;
}

/** A gate holds `/gate/<name>` open until `release(name)`; a gate never released stays pending. */
function gates() {
  const held = new Map();
  const channel = (name) => {
    let entry = held.get(name);
    if (!entry) {
      let open;
      const opened = new Promise((done) => (open = done));
      entry = { opened, open, waiting: 0 };
      held.set(name, entry);
    }
    return entry;
  };
  return {
    async hold(name, res) {
      const entry = channel(name);
      entry.waiting += 1;
      await entry.opened;
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html(`Gate ${name}`, `<p id="gate">${name} released</p>`));
      }
    },
    release: (name) => channel(name).open(),
    waiting: (name) => held.get(name)?.waiting ?? 0,
    releaseAll: () => held.forEach((entry) => entry.open()),
  };
}

/** Starts the site. `log` is every request; the test reads it as ground truth. */
export async function startSites() {
  const log = [];
  const gate = gates();
  let port = 0;
  const origins = () => ({
    primary: `http://127.0.0.1:${port}`,
    cross: `http://localhost:${port}`,
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const host = req.headers.host ?? "";
    const site = host.startsWith("localhost") ? "CROSS" : "PRIMARY";
    const target = req.url ?? "/";
    log.push({ site, method: req.method, target, headers: { ...req.headers }, body });
    const path = new URL(target, "http://x").pathname;
    if (path.startsWith("/gate/")) return gate.hold(path.slice(6), res);
    if (apiRoute(path, req, res, body) || specialRoute(path, req, res, body)) return;
    const page = pages[path];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (path === "/csp") headers["content-security-policy"] = "script-src 'none'";
    res.writeHead(200, headers);
    res.end(page(origins()));
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  port = server.address().port;
  return {
    ...origins(),
    port,
    log,
    gate,
    /** Requests seen since `mark` (an index into the log), optionally filtered by path prefix. */
    since: (mark, prefix = "") =>
      log.slice(mark).filter((entry) => entry.target.startsWith(prefix)),
    close: () =>
      new Promise((done) => {
        gate.releaseAll();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
