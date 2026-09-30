(() => {
  "use strict";
  let csrf = "";
  let pendingAction = null;
  let actionOrigin = null;
  let customers = [];
  const $ = (id) => document.getElementById(id);
  const status = (message, error = false) => {
    $("adminStatus").textContent = message;
    $("adminStatus").classList.toggle("is-error", error);
  };
  const createStatus = (message, error = false) => {
    $("createStatus").textContent = message;
    $("createStatus").classList.toggle("is-error", error);
  };
  const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  async function request(path, options = {}) {
    const response = await fetch(path.replace(/^\/admin\/subscribers/, "/api/customers"), {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      headers: { ...(options.method && options.method !== "GET" ? { "X-CSRF-Token": csrf } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (response.status === 401) {
        csrf = "";
        $("adminContent").hidden = true;
        status("Session expired. Refresh to reconnect locally, or sign in again.", true);
      }
      throw new Error(typeof error.detail === "string" ? error.detail : `HTTP ${response.status}`);
    }
    return response.json();
  }
  function showLink(playlistUrl, portalUrl, magPortalUrl, message = "URLs replaced.") {
    const container = $("newLink");
    container.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = `${message} Save all customer URLs now: they cannot be retrieved after this page is closed. Replacing them disables the old URLs.`;
    container.append(title);
    for (const [label, copyLabel, url] of [["MAG external portal URL (set on the MAG box; requires the recorded MAC)", "MAG portal", magPortalUrl], ["TV browser URL (not a MAG portal)", "TV browser", portalUrl], ["M3U playlist URL (for M3U players)", "M3U", playlistUrl]]) {
      const heading = document.createElement("p");
      heading.textContent = label;
      const link = document.createElement("a");
      link.href = url;
      link.textContent = url;
      link.rel = "noreferrer";
      const copy = document.createElement("button");
      copy.className = "secondary-button";
      copy.type = "button";
      copy.textContent = `Copy ${copyLabel} URL`;
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(url); status("Customer URL copied"); }
        catch { status("Copy failed; select and copy the URL above", true); }
      });
      container.append(heading, link, copy);
    }
    container.hidden = false;
    container.querySelector("button")?.focus();
    container.scrollIntoView({ block: "nearest" });
  }
  function closeAction(restoreFocus = true) {
    const origin = actionOrigin;
    pendingAction = null;
    actionOrigin = null;
    $("subscriberAction").hidden = true;
    $("actionMonthsPreset").value = "1";
    $("actionCustomLabel").hidden = true;
    $("actionCustomMonths").disabled = true;
    $("actionMacLabel").hidden = true;
    $("actionMac").disabled = true;
    if (restoreFocus && origin?.isConnected) origin.focus();
  }
  function beginAction(button) {
    closeAction(false);
    pendingAction = { id: Number(button.dataset.id), action: button.dataset.action, active: button.dataset.active === "true" };
    actionOrigin = button;
    const name = button.closest(".subscriber-row").querySelector("strong").textContent;
    const { action, active } = pendingAction;
    $("actionTitle").textContent = `${action === "extend" ? "Extend" : action === "mac" ? "Update MAC for" : action === "rotate" ? "Replace links for" : active ? "Suspend" : "Activate"} ${name}?`;
    $("actionDescription").textContent = action === "rotate"
      ? "All three old URLs will stop working immediately. Copy all three replacement URLs after confirming."
      : action === "mac" ? "The MAG portal compares the reported MAC against this value. A MAC can be spoofed; changing it does not prove device identity."
      : action === "extend" ? "Add calendar months to the current expiry (or from today if expired)."
        : active ? "This stops future portal, API and playlist requests, not previously copied stream URLs." : "This restores portal and playlist requests until the expiry date.";
    $("actionMonthsLabel").hidden = action !== "extend";
    $("actionMacLabel").hidden = action !== "mac";
    $("actionMac").disabled = action !== "mac";
    if (action === "mac") $("actionMac").value = customers.find((row) => row.id === pendingAction.id)?.mac_address || "";
    $("confirmAction").textContent = action === "rotate" ? "Replace links" : action === "mac" ? "Save MAC" : action === "extend" ? "Extend account" : active ? "Suspend account" : "Activate account";
    $("subscriberAction").hidden = false;
    (action === "extend" ? $("actionMonthsPreset") : action === "mac" ? $("actionMac") : $("confirmAction")).focus();
    $("subscriberAction").scrollIntoView({ block: "nearest" });
  }
  async function load() {
    try {
      customers = await request("/admin/subscribers");
    } catch (error) {
      $("customerLoadStatus").textContent = `${error.message} Use Refresh once the TV service is working.`;
      $("customerLoadStatus").hidden = false;
      throw error;
    }
    $("customerLoadStatus").hidden = true;
    $("customerLoadStatus").textContent = "";
    $("customerCount").textContent = String(customers.length);
    $("activeCount").textContent = String(customers.filter((row) => row.is_active && Date.parse(row.expires_at) > Date.now()).length);
    $("todayDate").textContent = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    renderCustomers();
  }
  async function unlockContent() {
    $("adminContent").hidden = false;
    const target = document.getElementById(location.hash.slice(1));
    if (target && !target.closest("[hidden]")) target.scrollIntoView({ block: "start" });
    status("Signed in. Loading customers…");
    try {
      await load();
      createStatus("Enter name, device MAC and duration, then select Create customer and URLs.");
      status("Signed in. Dashboard ready.");
    }
    catch (error) {
      status(csrf ? "Dashboard open, but the TV customer service is unavailable. See My Customers for details." : "Session expired. Refresh to reconnect locally or sign in again.", true);
      if (csrf) createStatus(`${error.message} Customer creation will not work until the TV service connection is fixed.`, true);
    }
  }
  function renderCustomers() {
    const search = $("subscriberSearch").value.trim().toLowerCase();
    const rows = customers.filter((row) => `${row.name} ${row.mac_address || ""}`.toLowerCase().includes(search));
    $("subscriberList").innerHTML = rows.length ? rows.map((row) => {
      const expired = Date.parse(row.expires_at) <= Date.now();
      return `<article class="subscriber-row"><div><strong>${escapeHtml(row.name)}</strong><small>MAC: ${escapeHtml(row.mac_address || "Not recorded")} · ${row.is_active ? expired ? "Expired" : "Active" : "Inactive"} · Expires ${escapeHtml(new Date(row.expires_at).toLocaleString())}${row.notes ? ` · ${escapeHtml(row.notes)}` : ""}</small></div><div class="subscriber-actions"><button class="secondary-button" data-action="extend" data-id="${row.id}" type="button">Extend</button><button class="secondary-button" data-action="toggle" data-id="${row.id}" data-active="${row.is_active}" type="button">${row.is_active ? "Suspend" : "Activate"}</button><button class="secondary-button" data-action="mac" data-id="${row.id}" type="button">Edit MAC</button><button class="secondary-button" data-action="rotate" data-id="${row.id}" type="button">Replace URLs</button></div></article>`;
    }).join("") : "No matching customers.";
  }
  $("unlockButton").addEventListener("click", async () => {
    const password = $("adminKey").value;
    $("adminKey").value = "";
    $("unlockButton").disabled = true;
    $("unlockButton").textContent = "Signing in…";
    status("Checking operator password…");
    try {
      const response = await fetch("/api/login", { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      if (!response.ok) { const problem = await response.json().catch(() => ({})); throw new Error(problem.detail || `Sign in failed (HTTP ${response.status})`); }
      csrf = (await response.json()).csrf_token;
      await unlockContent();
      if (!location.hash || location.hash === "#overview" || location.hash === "#newCustomer") $("subscriberName").focus();
    } catch (error) { csrf = ""; $("adminContent").hidden = true; status(`Sign in failed: ${error.message}`, true); }
    finally { $("unlockButton").disabled = false; $("unlockButton").textContent = "Sign in"; }
  });
  document.querySelectorAll('.admin-sidebar a[href^="#"]').forEach((link) => link.addEventListener("click", (event) => {
    const section = document.getElementById(link.hash.slice(1));
    if (section?.closest("#adminContent") && $("adminContent").hidden) {
      event.preventDefault();
      status("Sign in to open New Customer and My Customers.");
      $("adminKey").focus();
      return;
    }
    if (section) {
      event.preventDefault();
      history.replaceState(null, "", link.hash);
      section.scrollIntoView({ block: "start" });
      section.querySelector("h2, h1")?.setAttribute("tabindex", "-1");
      section.querySelector("h2, h1")?.focus({ preventScroll: true });
    }
  }));
  $("lockButton").addEventListener("click", async () => {
    if (csrf) await fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrf } }).catch(() => {});
    csrf = ""; customers = []; closeAction(false); $("adminContent").hidden = true; $("subscriberList").replaceChildren(); $("newLink").replaceChildren(); $("newLink").hidden = true; createStatus("Enter name, device MAC and duration, then select Create customer and URLs."); status("Signed out"); $("adminKey").focus();
  });
  $("adminKey").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("unlockButton").click(); } });
  $("subscriberMonths").addEventListener("change", () => {
    const custom = $("subscriberMonths").value === "custom";
    $("subscriberCustomLabel").hidden = !custom;
    $("subscriberCustomMonths").disabled = !custom;
    if (custom) $("subscriberCustomMonths").focus();
  });
  $("subscriberForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("createCustomerButton");
    if (button.disabled) return;
    const name = $("subscriberName").value.trim();
    const mac = $("subscriberMac").value.trim();
    if (!name || !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac)) {
      createStatus("Enter a name and a device MAC with six hex pairs (AA:BB:CC:DD:EE:FF).", true);
      return;
    }
    const months = Number($("subscriberMonths").value === "custom" ? $("subscriberCustomMonths").value : $("subscriberMonths").value);
    if (!Number.isInteger(months) || months < 1 || months > 120) { createStatus("Enter 1 to 120 months.", true); return; }
    button.disabled = true;
    button.textContent = "Creating customer…";
    createStatus(`Saving ${name} to the TV service… Do not submit again while waiting.`);
    try {
      const result = await request("/admin/subscribers", { method: "POST", body: JSON.stringify({
        name, mac_address: mac,
        months, notes: $("subscriberNotes").value || null,
        is_active: $("subscriberActive").checked,
      }) });
      if (!result.mag_portal_url || !result.portal_url || !result.playlist_url) throw new Error("TV service did not return customer URLs. Check My Customers before retrying; the account may have been created.");
      $("subscriberForm").reset();
      $("subscriberCustomLabel").hidden = true;
      $("subscriberCustomMonths").disabled = true;
      $("subscriberActive").checked = true;
      const confirmation = `Account created for ${result.name || name} (MAC ${result.mac_address || mac}, ${months} ${months === 1 ? "month" : "months"}). ${result.is_active ? "Active now: set the MAG external portal URL below on the matching device." : "Inactive: select Activate in My Customers before the portal will work."}`;
      createStatus(`${confirmation} Save the URLs below now.`, false);
      showLink(result.playlist_url, result.portal_url, result.mag_portal_url, confirmation);
      try { await load(); }
      catch (error) { createStatus(`Account created for ${result.name || name}. Save the URLs below now. Customer list could not refresh: ${error.message}`, true); }
    } catch (error) {
      createStatus(`Customer was not confirmed: ${error.message} ${/timed out|did not return customer URLs/i.test(error.message) ? "Check My Customers before retrying; the request may have succeeded." : ""}`, true);
    } finally { button.disabled = false; button.textContent = "Create customer and URLs"; }
  });
  $("refreshSubscribers").addEventListener("click", () => { closeAction(false); load().catch((error) => status(error.message, true)); });
  $("subscriberSearch").addEventListener("input", () => { closeAction(false); renderCustomers(); });
  $("subscriberList").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    beginAction(button);
  });
  $("actionMonthsPreset").addEventListener("change", () => {
    const custom = $("actionMonthsPreset").value === "custom";
    $("actionCustomLabel").hidden = !custom;
    $("actionCustomMonths").disabled = !custom;
    if (custom) $("actionCustomMonths").focus();
  });
  $("cancelAction").addEventListener("click", () => closeAction());
  $("subscriberAction").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pendingAction) return;
    const { id, action, active } = pendingAction;
    const confirm = $("confirmAction");
    confirm.disabled = true;
    try {
      let links = null;
      if (action === "extend") {
        const months = Number($("actionMonthsPreset").value === "custom" ? $("actionCustomMonths").value : $("actionMonthsPreset").value);
        if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("Enter 1 to 120 months");
        await request(`/admin/subscribers/${id}`, { method: "PATCH", body: JSON.stringify({ extend_months: months }) });
      } else if (action === "toggle") {
        await request(`/admin/subscribers/${id}`, { method: "PATCH", body: JSON.stringify({ is_active: !active }) });
      } else if (action === "mac") {
        await request(`/admin/subscribers/${id}`, { method: "PATCH", body: JSON.stringify({ mac_address: $("actionMac").value || null }) });
      } else if (action === "rotate") {
        const result = await request(`/admin/subscribers/${id}/rotate`, { method: "POST" });
        links = result;
      }
      closeAction(false);
      if (links) showLink(links.playlist_url, links.portal_url, links.mag_portal_url);
      await load();
      status(links ? "URLs replaced. Copy all three private URLs now." : "Customer updated");
      if (links) $("newLink").querySelector("button")?.focus();
      else $("subscriberList").querySelector(`[data-id="${id}"][data-action="${action}"]`)?.focus();
    } catch (error) { status(error.message, true); confirm.focus(); }
    finally { confirm.disabled = false; }
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const actionOpen = !$("subscriberAction").hidden;
    const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (actionOpen && (["Escape", "BrowserBack"].includes(event.key) || (event.key === "Backspace" && !editing))) { event.preventDefault(); closeAction(); return; }
    if (actionOpen && document.activeElement === $("actionMonthsPreset") && event.key === "ArrowRight") {
      event.preventDefault(); $("confirmAction").focus(); return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) ||
      (editing && (["TEXTAREA"].includes(document.activeElement.tagName) ||
        (document.activeElement.tagName === "INPUT" && ["ArrowLeft", "ArrowRight"].includes(event.key)) ||
        (document.activeElement.tagName === "SELECT" && ["ArrowUp", "ArrowDown"].includes(event.key))))) return;
    const scope = actionOpen ? $("subscriberAction") : document;
    const targets = [...scope.querySelectorAll("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)")]
      .filter((node) => node.getClientRects().length && !node.closest("[hidden]"));
    const current = document.activeElement;
    const rect = current?.getBoundingClientRect();
    if (!targets.includes(current)) { if (targets[0]) { event.preventDefault(); targets[0].focus(); } return; }
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const candidates = targets.filter((node) => {
      if (node === current) return false;
      const box = node.getBoundingClientRect();
      const delta = vertical ? box.top + box.height / 2 - center.y : box.left + box.width / 2 - center.x;
      return forward ? delta > 3 : delta < -3;
    });
    candidates.sort((a, b) => {
      const score = (node) => {
        const box = node.getBoundingClientRect();
        const dx = box.left + box.width / 2 - center.x;
        const dy = box.top + box.height / 2 - center.y;
        return vertical ? Math.abs(dy) * 2 + Math.abs(dx) : Math.abs(dx) * 2 + Math.abs(dy);
      };
      return score(a) - score(b);
    });
    if (candidates[0]) { event.preventDefault(); candidates[0].focus(); candidates[0].scrollIntoView({ block: "nearest", inline: "nearest" }); }
  });
  fetch("/api/session", { credentials: "same-origin", cache: "no-store" })
    .then((response) => response.ok ? response.json() : null)
    .then(async (result) => {
      if (!result) return;
      csrf = result.csrf_token;
      if (result.passwordless) $("signInCard").hidden = true;
      await unlockContent();
    })
    .catch(() => {});
})();