"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../static/js/admin.js"), "utf8");

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
    Intl, Date, setTimeout, history: { replaceState() {} } };
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
  assert.equal($("newLink").children.find((item) => item.href?.endsWith("/c/index.html")).href,
    "https://tv.example/stalker/token/c/index.html");
  assert.equal($("subscriberActive").checked, true);
  assert.equal($("createCustomerButton").disabled, false);
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
  assert.match($("createStatus").textContent, /Customer was not confirmed.*TV_ADMIN_API_KEY/);
  assert.equal($("newLink").children.length, 0);
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
    throw new Error(`Unexpected request: ${url}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal($("signInCard").hidden, true);
  assert.equal($("adminContent").hidden, false);
  assert.equal(signins, 0);
});