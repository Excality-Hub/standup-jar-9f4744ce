// Standup Jar: async daily standups for a small team.
// Single-file Cloudflare Worker: inline HTML/CSS/JS page plus a JSON API.

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME = 50;
const MAX_TEXT = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Storage ----------

// In-memory fallback used when no KV binding is configured (not persistent).
const memory = new Map();

function sortDesc(entries) {
  return entries.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
}

function makeStore(env) {
  const kv = env && env.ENTRIES;
  if (kv) {
    return {
      async list(date) {
        const keys = [];
        let cursor;
        do {
          const res = await kv.list({ prefix: `entries:${date}:`, cursor });
          for (const k of res.keys) keys.push(k.name);
          cursor = res.list_complete ? undefined : res.cursor;
        } while (cursor);
        const values = await Promise.all(keys.map((k) => kv.get(k, "json")));
        return sortDesc(values.filter(Boolean));
      },
      async put(entry) {
        const key = `entries:${entry.date}:${entry.createdAt}:${entry.id}`;
        await kv.put(key, JSON.stringify(entry));
      },
    };
  }
  return {
    async list(date) {
      return sortDesc((memory.get(date) || []).slice());
    },
    async put(entry) {
      const list = memory.get(entry.date) || [];
      list.push(entry);
      memory.set(entry.date, list);
    },
  };
}

// ---------- Helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function utcDateString(d) {
  return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

// Allow up to one day ahead of server UTC so time zones ahead of UTC work.
function isTooFarInFuture(s) {
  const tomorrow = utcDateString(new Date(Date.now() + 86400000));
  return s > tomorrow;
}

async function readBody(request) {
  const len = Number(request.headers.get("content-length"));
  if (len && len > MAX_BODY_BYTES) return { error: "Request body too large" };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { error: "Request body too large" };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "Invalid JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  return { body };
}

function validateEntry(body) {
  const fields = {};
  for (const f of ["name", "yesterday", "today", "blockers", "date"]) {
    const v = body[f] === undefined || body[f] === null ? "" : body[f];
    if (typeof v !== "string") return { error: `Field "${f}" must be a string` };
    fields[f] = v.trim();
  }
  if (!fields.name) return { error: "Name is required" };
  if (fields.name.length > MAX_NAME) {
    return { error: `Name must be at most ${MAX_NAME} characters` };
  }
  if (!fields.yesterday && !fields.today && !fields.blockers) {
    return { error: "Fill in at least one of Yesterday, Today or Blockers" };
  }
  for (const f of ["yesterday", "today", "blockers"]) {
    if (fields[f].length > MAX_TEXT) {
      return { error: `"${f}" must be at most ${MAX_TEXT} characters` };
    }
  }
  if (!fields.date) fields.date = utcDateString(new Date());
  if (!isValidDate(fields.date)) return { error: "Invalid date (use YYYY-MM-DD)" };
  if (isTooFarInFuture(fields.date)) return { error: "Date cannot be in the future" };
  return { fields };
}

// ---------- Handlers ----------

async function listEntries(url, store) {
  const date = url.searchParams.get("date");
  if (!date || !isValidDate(date)) {
    return json({ error: "Missing or invalid date (use YYYY-MM-DD)" }, 400);
  }
  return json(await store.list(date));
}

async function createEntry(request, store) {
  const { body, error } = await readBody(request);
  if (error) return json({ error }, 400);
  const v = validateEntry(body);
  if (v.error) return json({ error: v.error }, 400);
  const entry = {
    id: crypto.randomUUID(),
    name: v.fields.name,
    yesterday: v.fields.yesterday,
    today: v.fields.today,
    blockers: v.fields.blockers,
    date: v.fields.date,
    createdAt: new Date().toISOString(),
  };
  await store.put(entry);
  return json(entry, 201);
}

async function handle(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/") {
    if (method !== "GET" && method !== "HEAD") {
      return json({ error: "Method not allowed" }, 405);
    }
    return new Response(HTML, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/api/entries") {
    const store = makeStore(env);
    if (method === "GET") return listEntries(url, store);
    if (method === "POST") return createEntry(request, store);
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal error" }, 500);
    }
  },
};

// ---------- Page ----------
// Note: the client script avoids backticks, "${" and backslash escapes
// because it lives inside this template literal.

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Standup Jar</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.45;
    color: #1f2328;
    background: #f6f7f9;
  }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px; }
  h1 { font-size: 1.5rem; margin: 0; flex: 1 1 100%; }
  header input[type=date] { flex: 1 1 auto; width: auto; }
  input, textarea, button { font: inherit; font-size: 16px; }
  input, textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #c9ced6;
    border-radius: 8px;
    background: #fff;
    min-height: 44px;
  }
  textarea { resize: vertical; min-height: 72px; }
  button {
    min-height: 44px;
    padding: 10px 16px;
    border: 0;
    border-radius: 8px;
    background: #2f6feb;
    color: #fff;
    cursor: pointer;
  }
  button.secondary { background: #e7eaf0; color: #1f2328; }
  button:disabled { opacity: 0.6; cursor: default; }
  form, .card, .state {
    background: #fff;
    border: 1px solid #e1e4e8;
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 16px;
  }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  label:first-child { margin-top: 0; }
  form button[type=submit] { width: 100%; margin-top: 16px; }
  .form-error { color: #b42318; margin: 12px 0 0; }
  .form-error:empty { display: none; }
  .card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .card-name { font-weight: 700; word-break: break-word; }
  .card-time { color: #656d76; font-size: 0.9rem; }
  .badge {
    margin-left: auto;
    background: #d92d20;
    color: #fff;
    font-size: 0.8rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .section { margin-top: 8px; }
  .section h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; color: #656d76; margin: 0 0 2px; }
  .section p { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .card.blocked { border-left: 5px solid #d92d20; background: #fef3f2; }
  .state { text-align: center; color: #656d76; }
  .state.error { color: #b42318; }
  .state button { margin-top: 8px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Standup Jar</h1>
    <input type="date" id="date" aria-label="Date">
    <button type="button" class="secondary" id="refresh">Refresh</button>
  </header>

  <form id="form" novalidate>
    <label for="name">Name</label>
    <input id="name" name="name" maxlength="50" autocomplete="name" required>
    <label for="yesterday">Yesterday</label>
    <textarea id="yesterday" name="yesterday" maxlength="1000"></textarea>
    <label for="today">Today</label>
    <textarea id="today" name="today" maxlength="1000"></textarea>
    <label for="blockers">Blockers</label>
    <textarea id="blockers" name="blockers" maxlength="1000"></textarea>
    <p class="form-error" id="form-error" role="alert"></p>
    <button type="submit" id="submit">Post standup</button>
  </form>

  <section id="list" aria-live="polite"></section>
</main>
<script>
(function () {
  var NAME_KEY = "standupJar.name";
  var dateInput = document.getElementById("date");
  var refreshBtn = document.getElementById("refresh");
  var form = document.getElementById("form");
  var nameInput = document.getElementById("name");
  var fields = {
    yesterday: document.getElementById("yesterday"),
    today: document.getElementById("today"),
    blockers: document.getElementById("blockers")
  };
  var formError = document.getElementById("form-error");
  var submitBtn = document.getElementById("submit");
  var list = document.getElementById("list");
  var requestId = 0;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function localToday() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function showState(text, cls, retry) {
    list.replaceChildren();
    var box = el("div", "state" + (cls ? " " + cls : ""));
    box.appendChild(el("p", null, text));
    if (retry) {
      var b = el("button", "secondary", "Retry");
      b.type = "button";
      b.addEventListener("click", retry);
      box.appendChild(b);
    }
    list.appendChild(box);
  }

  function renderCard(entry) {
    var hasBlockers = (entry.blockers || "").trim() !== "";
    var card = el("article", "card" + (hasBlockers ? " blocked" : ""));
    var head = el("div", "card-head");
    head.appendChild(el("span", "card-name", entry.name));
    var t = new Date(entry.createdAt);
    var time = isNaN(t) ? "" : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    head.appendChild(el("span", "card-time", time));
    if (hasBlockers) head.appendChild(el("span", "badge", "Blocked"));
    card.appendChild(head);
    [["Yesterday", entry.yesterday], ["Today", entry.today], ["Blockers", entry.blockers]].forEach(function (s) {
      if (!s[1] || !s[1].trim()) return;
      var sec = el("div", "section");
      sec.appendChild(el("h3", null, s[0]));
      sec.appendChild(el("p", null, s[1]));
      card.appendChild(sec);
    });
    return card;
  }

  function renderList(entries) {
    list.replaceChildren();
    if (!entries.length) {
      showState("No standups yet for this day");
      return;
    }
    entries.forEach(function (e) { list.appendChild(renderCard(e)); });
  }

  function load() {
    var id = ++requestId;
    var date = dateInput.value;
    showState("Loading...");
    fetch("/api/entries?date=" + encodeURIComponent(date))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Request failed");
          return data;
        });
      })
      .then(function (entries) {
        if (id !== requestId) return;
        renderList(entries);
      })
      .catch(function (err) {
        if (id !== requestId) return;
        showState("Couldn't load standups: " + err.message, "error", load);
      });
  }

  function validate(v) {
    if (!v.name) return "Name is required";
    if (v.name.length > 50) return "Name must be at most 50 characters";
    if (!v.yesterday && !v.today && !v.blockers) return "Fill in at least one of Yesterday, Today or Blockers";
    if (v.yesterday.length > 1000 || v.today.length > 1000 || v.blockers.length > 1000) {
      return "Each section must be at most 1000 characters";
    }
    if (!v.date) return "Pick a date";
    return "";
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var payload = {
      name: nameInput.value.trim(),
      yesterday: fields.yesterday.value.trim(),
      today: fields.today.value.trim(),
      blockers: fields.blockers.value.trim(),
      date: dateInput.value
    };
    var err = validate(payload);
    formError.textContent = err;
    if (err) return;
    submitBtn.disabled = true;
    fetch("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Couldn't post standup");
          return data;
        });
      })
      .then(function (entry) {
        try { localStorage.setItem(NAME_KEY, payload.name); } catch (e) {}
        fields.yesterday.value = "";
        fields.today.value = "";
        fields.blockers.value = "";
        if (entry.date === dateInput.value) {
          if (list.querySelector(".state")) list.replaceChildren();
          list.insertBefore(renderCard(entry), list.firstChild);
        }
      })
      .catch(function (e) {
        formError.textContent = e.message;
      })
      .then(function () {
        submitBtn.disabled = false;
      });
  });

  var today = localToday();
  dateInput.value = today;
  dateInput.max = today;
  try { nameInput.value = localStorage.getItem(NAME_KEY) || ""; } catch (e) {}

  dateInput.addEventListener("change", function () {
    if (dateInput.value && dateInput.value > dateInput.max) dateInput.value = dateInput.max;
    if (dateInput.value) load();
  });
  refreshBtn.addEventListener("click", load);

  load();
})();
</script>
</body>
</html>`;
