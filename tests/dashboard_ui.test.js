"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../static/js/admin.js"), "utf8");

test("MAC field pattern is valid under modern HTML v-regex rules and rejects malformed MACs", () => {
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  const pattern = html.match(/id="subscriberMac"[^>]*\bpattern="([^"]+)"/)?.[1];
  assert.ok(pattern, "subscriber MAC input must have an HTML pattern");
  const mac = new RegExp(`^(?:${pattern})$`, "v");
  assert.equal(mac.test("AA:BB:CC:DD:EE:FF"), true);
  assert.equal(mac.test("aa-bb-cc-dd-ee-ff"), true);
  assert.equal(mac.test("GG:BB:CC:DD:EE:FF"), false);
  assert.equal(mac.test("AA:BB:CC:DD:EE"), false);
});

function page(fetch) {
  const nodes = new Map();
  function element() {
    const handlers = {};
    const children = [];
    const classes = new Set();
    return {
      handlers, children, hidden: false, disabled: false, value: "", checked: false,
      textContent: "", innerHTML: "", isConnected: true,
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      addEventListener(name, callback) { handlers[name] = callback; },
      append(...items) { children.push(...items); },
      replaceChildren() { children.length = 0; },
      querySelector(selector) { return selector === "button" ? children.find((item) => item.textContent?.startsWith("Copy ")) : null; },
      focus() {}, scrollIntoView() {}, closest() { return null; },
      reset() { nodes.get("subscriberName").value = ""; nodes.get("subscriberMac").value = ""; nodes.get("subscriberActive").checked = false; },
    };
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = { document, fetch, location: { hash: "" }, navigator: { clipboard: {} },
    Intl, Date, URL, setTimeout, history: { replaceState() {} } };
  document.getElementById("adminContent").hidden = true;
  vm.runInNewContext(script, context);
  return document.getElementById.bind(document);
}

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

test("sign in, create active MAC customer, show confirmation and preserve links on list failure", async () => {
  let lists = 0;
  let posts = 0;
  const $ = page(async (url, options) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers" && options.method === "POST") {
      posts++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { name: "Krish", mac_address: "00:1A:79:67:CB:47", months: 1, notes: null, is_active: true });
      assert.equal(options.headers["X-CSRF-Token"], "csrf");
      return response(201, { ...body, playlist_url: "https://tv.example/subscribers/playlist/token.m3u",
        portal_url: "https://tv.example/watch/token", mag_portal_url: "https://tv.example/stalker/token/c/index.html" });
    }
    if (url === "/api/customers/portal-settings") return response(200, { enabled: true,
      server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    if (url === "/api/customers") {
      lists++;
      return lists === 1 ? response(200, []) : response(502, { detail: "Database unavailable" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  $("adminKey").value = "operator-password";
  await $("unlockButton").handlers.click();
  assert.match($("adminStatus").textContent, /Signed in/);
  $("subscriberName").value = "Krish";
  $("subscriberMac").value = "00:1A:79:67:CB:47";
  $("subscriberMonths").value = "1";
  $("subscriberActive").checked = true;
  await $("subscriberForm").handlers.submit({ preventDefault() {} });
  assert.equal(posts, 1);
  assert.match($("createStatus").textContent, /Account created for Krish.*list could not refresh/);
  assert.match($("newLink").children[0].textContent, /Account created for Krish/);
  assert.match($("newLink").children[1].textContent, /common addresses/);
  assert.equal($("sharedPortalLinks").children[1].textContent, "https://tv.example");
  assert.equal($("sharedPortalLinks").children[4].textContent, "https://tv.example/c/index.html");
  assert.equal($("newLink").children.find((item) => item.href?.endsWith("/c/index.html")).href,
    "https://tv.example/stalker/token/c/index.html");
  assert.equal($("newLink").children.find((item) => item.href?.endsWith("/stalker/token")).href,
    "https://tv.example/stalker/token");
  assert.match($("newLink").children[2].textContent, /STBEmu Pro Portal URL/);
  assert.match($("newLink").children[2].textContent, /matching device MAC/);
  assert.equal($("subscriberActive").checked, true);
  assert.equal($("createCustomerButton").disabled, true);
  await $("subscriberForm").handlers.submit({ preventDefault() {} });
  assert.equal(posts, 1);
  assert.match($("createStatus").textContent, /My Customers must load/);
});

test("existing private MAG URL is verified against its account before showing a server address", async () => {
  let posts = 0;
  const $ = page(async (url, options) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers") return response(200, [{ id: 1, name: "Existing", mac_address: "00:1A:79:67:CB:47", is_active: true, expires_at: "2099-01-01T00:00:00Z" }]);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: true, server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    if (url === "/api/customers/portal-check") {
      posts++;
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-CSRF-Token"], "csrf");
      assert.equal(JSON.parse(options.body).mac_address, "00:1A:79:67:CB:47");
      return response(200, { id: 1, name: "Existing", mac_matches: true, is_active: true, expires_at: "2099-01-01T00:00:00Z" });
    }
    posts++;
    throw new Error(`Unexpected request: ${url}`);
  });
  await $("unlockButton").handlers.click();
  const token = "a".repeat(43);
  $("existingAccountMac").value = "00:1A:79:67:CB:47";
  $("existingPortalUrl").value = `https://tv.example/stalker/${token}/c/index.html`;
  await $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.equal($("existingServerLink").hidden, false);
  assert.equal($("existingServerLink").children[1].textContent, `https://tv.example/stalker/${token}`);
  assert.match($("existingPortalStatus").textContent, /Verified: this private URL belongs to Existing/);
  assert.equal(posts, 1);
  $("existingPortalUrl").value = "https://tv.example/watch/" + token;
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.equal($("existingServerLink").hidden, true);
  assert.match($("existingPortalStatus").textContent, /original HTTPS MAG URL/);
  $("existingPortalUrl").value = `https://tv.example/stalker/${token}/c/index.html?leak=1`;
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.equal($("existingServerLink").hidden, true);
  assert.equal(posts, 1);
});

test("private URL verification never reveals a server address for another MAC, suspended or expired account", async () => {
  const statuses = [
    { mac_matches: false, is_active: true, expires_at: "2099-01-01T00:00:00Z" },
    { mac_matches: true, is_active: false, expires_at: "2099-01-01T00:00:00Z" },
    { mac_matches: true, is_active: true, expires_at: "2020-01-01T00:00:00Z" },
  ];
  let checks = 0;
  const $ = page(async (url) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers") return response(200, []);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: false });
    if (url === "/api/customers/portal-check") return response(200, { name: "Existing", ...statuses[checks++] });
    throw new Error(`Unexpected request: ${url}`);
  });
  await $("unlockButton").handlers.click();
  $("existingAccountMac").value = "00:1A:79:67:CB:47";
  $("existingPortalUrl").value = `https://tv.example/stalker/${"a".repeat(43)}/c/index.html`;
  for (const detail of [/does not match/, /inactive/, /expired/]) {
    await $("existingPortalForm").handlers.submit({ preventDefault() {} });
    assert.equal($("existingServerLink").hidden, true);
    assert.match($("existingPortalStatus").textContent, detail);
  }
  assert.equal(checks, 3);
});

test("disabled shared portal never displays a device URL but keeps customer management available", async () => {
  const $ = page(async (url) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers") return response(200, [
      { id: 1, name: "Old", mac_address: "AA:BB:CC:DD:EE:FF", is_active: false, expires_at: "2099-01-01T00:00:00Z" },
      { id: 2, name: "Current", mac_address: "AA:BB:CC:DD:EE:FF", is_active: true, expires_at: "2099-01-01T00:00:00Z" },
    ]);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: false, server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    throw new Error(`Unexpected request: ${url}`);
  });
  await $("unlockButton").handlers.click();
  assert.equal($("sharedPortalLinks").hidden, true);
  assert.match($("sharedPortalStatus").textContent, /not enabled/);
  assert.equal($("createCustomerButton").disabled, false);
  $("existingAccountMac").value = "AA:BB:CC:DD:EE:FF";
  await $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.match($("existingPortalStatus").textContent, /shared portal denies this MAC.*clear the MAC/);
});

test("checks the existing saved MAC and account status without changing a customer", async () => {
  const rows = [
    { id: 1, name: "Current", mac_address: "00:1A:79:67:CB:47", is_active: true, expires_at: "2099-01-01T00:00:00Z" },
    { id: 2, name: "Suspended", mac_address: "AA:BB:CC:DD:EE:FF", is_active: false, expires_at: "2099-01-01T00:00:00Z" },
    { id: 3, name: "Expired", mac_address: "11:22:33:44:55:66", is_active: true, expires_at: "2020-01-01T00:00:00Z" },
  ];
  const calls = [];
  const $ = page(async (url, options) => {
    calls.push([url, options?.method]);
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers") return response(200, rows);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: true, server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    if (url === "/api/logout") return response(200, {});
    throw new Error(`Unexpected request: ${url}`);
  });
  await $("unlockButton").handlers.click();
  $("existingAccountMac").value = "00:1a:79:67:cb:47";
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.match($("existingPortalStatus").textContent, /One active, unexpired customer/);
  $("existingAccountMac").value = "aa-bb-cc-dd-ee-ff";
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.match($("existingPortalStatus").textContent, /is inactive/);
  $("existingAccountMac").value = "11:22:33:44:55:66";
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.match($("existingPortalStatus").textContent, /is expired/);
  $("existingAccountMac").value = "99:99:99:99:99:99";
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.match($("existingPortalStatus").textContent, /No customer has saved MAC/);
  $("existingAccountMac").value = "invalid";
  $("existingPortalForm").handlers.submit({ preventDefault() {} });
  assert.match($("existingPortalStatus").textContent, /Enter the MAC saved/);
  assert.deepEqual(calls.filter(([url]) => url === "/api/customers").map(([, method]) => method), [undefined]);
  $("existingPortalUrl").value = `https://tv.example/stalker/${"a".repeat(43)}/c/index.html`;
  await $("lockButton").handlers.click();
  assert.equal($("existingAccountMac").value, "");
  assert.equal($("existingPortalUrl").value, "");
  assert.equal($("existingServerLink").hidden, true);
});

test("signed in with rejected TV admin key displays actionable creation error without claiming success", async () => {
  const $ = page(async (url) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers") return response(502, { detail: "TV service rejected the admin key. Match dashboard TV_ADMIN_API_KEY to TV service ADMIN_API_KEY in Render." });
    throw new Error(`Unexpected request: ${url}`);
  });
  $("adminKey").value = "operator-password";
  await $("unlockButton").handlers.click();
  assert.equal($("adminContent").hidden, false);
  assert.match($("adminStatus").textContent, /Dashboard open/);
  assert.match($("createStatus").textContent, /TV_ADMIN_API_KEY/);
  $("subscriberName").value = "Krish";
  $("subscriberMac").value = "00:1A:79:67:CB:47";
  $("subscriberMonths").value = "1";
  await $("subscriberForm").handlers.submit({ preventDefault() {} });
  assert.match($("createStatus").textContent, /My Customers must load/);
  assert.equal($("createCustomerButton").disabled, true);
  assert.equal($("newLink").children.length, 0);
});

test("refreshing the customer list unlocks creation only after a successful read", async () => {
  let reads = 0;
  let posts = 0;
  const $ = page(async (url, options) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers" && options.method === "POST") { posts++; return response(502, { detail: "Failed" }); }
    if (url === "/api/customers") return ++reads === 1 ? response(502, { detail: "Database unavailable" }) : response(200, []);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: true, server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    throw new Error(`Unexpected request: ${url}`);
  });
  await $("unlockButton").handlers.click();
  assert.equal($("createCustomerButton").disabled, true);
  assert.equal($("customerLoadStatus").hidden, false);
  $("subscriberName").value = "Krish";
  $("subscriberMac").value = "00:1A:79:67:CB:47";
  $("subscriberMonths").value = "1";
  await $("subscriberForm").handlers.submit({ preventDefault() {} });
  assert.equal(posts, 0);
  await $("refreshSubscribers").handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($("customerLoadStatus").hidden, true);
  assert.equal($("createCustomerButton").disabled, false);
  await $("subscriberForm").handlers.submit({ preventDefault() {} });
  assert.equal(posts, 1);
});

test("invalid MAC is rejected locally and a pending create cannot be submitted twice", async () => {
  let posts = 0;
  let finish;
  const $ = page(async (url, options) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(200, { csrf_token: "csrf" });
    if (url === "/api/customers" && options.method === "POST") {
      posts++;
      return new Promise((resolve) => { finish = resolve; });
    }
    if (url === "/api/customers") return response(200, []);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: true, server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    throw new Error(`Unexpected request: ${url}`);
  });
  $("adminKey").value = "operator-password";
  await $("unlockButton").handlers.click();
  $("subscriberName").value = "Krish";
  $("subscriberMac").value = "not-a-mac";
  $("subscriberMonths").value = "1";
  const submit = () => $("subscriberForm").handlers.submit({ preventDefault() {} });
  await submit();
  assert.equal(posts, 0);
  assert.match($("createStatus").textContent, /six hex pairs/);
  $("subscriberMac").value = "00:1A:79:67:CB:47";
  const pending = submit();
  await submit();
  assert.equal(posts, 1);
  assert.equal($("createCustomerButton").disabled, true);
  assert.match($("createStatus").textContent, /Do not submit again/);
  finish(response(502, { detail: "TV service rejected the admin key" }));
  await pending;
  assert.equal($("createCustomerButton").disabled, false);
  assert.match($("createStatus").textContent, /Customer was not confirmed/);
});

test("wrong operator password reports a visible sign-in failure", async () => {
  const $ = page(async (url) => {
    if (url === "/api/session") return response(401, {});
    if (url === "/api/login") return response(401, { detail: "Incorrect operator password" });
    throw new Error(`Unexpected request: ${url}`);
  });
  $("adminKey").value = "wrong-password";
  await $("unlockButton").handlers.click();
  assert.match($("adminStatus").textContent, /Sign in failed: Incorrect operator password/);
  assert.equal($("adminStatus").classList.contains("is-error"), true);
  assert.equal($("adminContent").hidden, true);
  assert.equal($("unlockButton").disabled, false);
});

test("local passwordless session opens the customer form without calling sign-in", async () => {
  let signins = 0;
  const $ = page(async (url) => {
    if (url === "/api/session") return response(200, { csrf_token: "local-csrf", passwordless: true });
    if (url === "/api/login") { signins++; throw new Error("Must not sign in"); }
    if (url === "/api/customers") return response(200, []);
    if (url === "/api/customers/portal-settings") return response(200, { enabled: true, server_url: "https://tv.example", mag_portal_url: "https://tv.example/c/index.html" });
    throw new Error(`Unexpected request: ${url}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($("signInCard").hidden, true);
  assert.equal($("adminContent").hidden, false);
  assert.equal(signins, 0);
});