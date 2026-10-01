(() => {
  "use strict";
  let csrf = "";
  let pendingAction = null;
  let actionOrigin = null;
  let customers = [];
  let sharedPortal = null;
  let listReady = false;
  let creating = false;
  let checkingPortal = false;
  let portalCheckGeneration = 0;
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
        portalCheckGeneration++;
        $("existingPortalUrl").value = "";
        $("existingServerLink").replaceChildren();
        $("existingServerLink").hidden = true;
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
    const compatibility = document.createElement("p");
    compatibility.textContent = "For Server + MAC and compatible MAG Portal URL modes, use the common addresses in One URL for every activated MAC above. These private links are for the browser/M3U and legacy private portal flows. Neither mode is guaranteed to work on every device.";
    container.append(compatibility);
    // The legacy private server and MAG page share the same customer token.
    const suffix = "/c/index.html";
    const serverUrl = magPortalUrl.endsWith(suffix) ? magPortalUrl.slice(0, -suffix.length) : null;
    const links = [["STBEmu Pro Portal URL / MAG external portal URL (requires the matching device MAC; not a Server URL)", "MAG portal", magPortalUrl]];
    if (serverUrl) links.push(["Private Stalker Server URL (Server + MAC apps; requires the matching MAC and updated TV service)", "private Stalker Server", serverUrl]);
    links.push(["TV browser URL (not for STBEmu)", "TV browser", portalUrl], ["M3U playlist URL (not for STBEmu)", "M3U", playlistUrl]);
    for (const [label, copyLabel, url] of links) {
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
  function renderSharedPortal() {
    const container = $("sharedPortalLinks");
    container.replaceChildren();
    container.hidden = true;
    if (!sharedPortal?.enabled || !/^https:\/\/[^/?#]+$/.test(sharedPortal.server_url) ||
        sharedPortal.mag_portal_url !== `${sharedPortal.server_url}/c/index.html`) {
      $("sharedPortalStatus").textContent = "Shared MAC portal not enabled on the TV service. Deploy the updated TV service with ENABLE_MAC_STALKER_PORTAL=true before using these addresses.";
      return;
    }
    $("sharedPortalStatus").textContent = "Use the mode your app actually supports. These addresses are the same for every registered MAC:";
    for (const [label, url] of [["Stalker Server + MAC address", sharedPortal.server_url], ["MAG / STBEmu external Portal URL", sharedPortal.mag_portal_url]]) {
      const heading = document.createElement("p");
      heading.textContent = label;
      const address = document.createElement("p");
      address.textContent = url;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary-button";
      copy.textContent = `Copy ${label}`;
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(url); status(`${label} copied`); }
        catch { status("Copy failed; select and copy the address above", true); }
      });
      container.append(heading, address, copy);
    }
    container.hidden = false;
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
    listReady = false;
    $("createCustomerButton").disabled = true;
    try {
      customers = await request("/admin/subscribers");
    } catch (error) {
      $("customerLoadStatus").textContent = `${error.message} Use Refresh once the TV service is working.`;
      $("customerLoadStatus").hidden = false;
      throw error;
    }
    $("customerLoadStatus").hidden = true;
    $("customerLoadStatus").textContent = "";
    try {
      sharedPortal = await request("/admin/subscribers/portal-settings");
      renderSharedPortal();
    } catch (error) {
      sharedPortal = null;
      $("sharedPortalLinks").replaceChildren();
      $("sharedPortalLinks").hidden = true;
      $("sharedPortalStatus").textContent = `Cannot confirm the shared portal address: ${error.message}`;
    }
    $("existingPortalStatus").textContent = "";
    $("existingServerLink").replaceChildren();
    $("existingServerLink").hidden = true;
    listReady = true;
    if (!creating) $("createCustomerButton").disabled = false;
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
      if (csrf) createStatus(`${error.message} Customer creation is disabled until My Customers loads successfully. Use Refresh after fixing the TV service.`, true);
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
    portalCheckGeneration++; csrf = ""; customers = []; listReady = false; $("createCustomerButton").disabled = true; closeAction(false); $("adminContent").hidden = true; $("subscriberList").replaceChildren(); $("newLink").replaceChildren(); $("newLink").hidden = true; $("existingAccountMac").value = ""; $("existingPortalUrl").value = ""; $("existingServerLink").replaceChildren(); $("existingServerLink").hidden = true; $("existingPortalStatus").textContent = ""; createStatus("Enter name, device MAC and duration, then select Create customer and URLs."); status("Signed out"); $("adminKey").focus();
  });
  $("existingPortalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (checkingPortal) { $("existingPortalStatus").textContent = "A private URL check is already in progress. Wait for its result."; return; }
    const generation = ++portalCheckGeneration;
    const result = $("existingServerLink");
    result.replaceChildren();
    result.hidden = true;
    const enteredMac = $("existingAccountMac").value.trim().toUpperCase().replaceAll("-", ":");
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(enteredMac)) {
      $("existingPortalStatus").textContent = "Enter the MAC saved for this customer (six hexadecimal pairs); check the MAC actually reported by your TV app.";
      return;
    }
    let accountStatus;
    if (!listReady) {
      accountStatus = "The customer list is unavailable, so account status and saved MAC cannot be checked. Use Refresh before troubleshooting authentication.";
    } else {
      const matches = customers.filter((row) => row.mac_address === enteredMac);
      if (!matches.length) accountStatus = `No customer has saved MAC ${enteredMac}. Check My Customers and the MAC reported by your TV app; do not create another account.`;
      else if (matches.length > 1) accountStatus = `More than one customer has MAC ${enteredMac}. The shared portal denies this MAC until duplicates are resolved. Suspend or clear the MAC on obsolete accounts after reviewing them; do not rotate URLs.`;
      else if (!matches[0].is_active) accountStatus = `Customer with MAC ${enteredMac} is inactive. Activate this existing account in My Customers before testing.`;
      else if (!(Date.parse(matches[0].expires_at) > Date.now())) accountStatus = `Customer with MAC ${enteredMac} is expired (or has an invalid expiry). Extend this existing account in My Customers before testing.`;
      else accountStatus = `One active, unexpired customer has saved MAC ${enteredMac}. Use the shared address above in the correct device mode; this does not prove your device actually reports that MAC.`;
    }
    const savedUrl = $("existingPortalUrl").value.trim();
    if (!savedUrl) {
      $("existingPortalStatus").textContent = `${accountStatus} An original private MAG URL is only needed to check an older private link, not for the shared portal.`;
      return;
    }
    let parsed;
    try { parsed = new URL(savedUrl); }
    catch { $("existingPortalStatus").textContent = `${accountStatus} Enter the complete private MAG URL saved when this account was created.`; return; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        !/^\/stalker\/[A-Za-z0-9_-]{32,128}\/c\/index\.html$/.test(parsed.pathname)) {
      $("existingPortalStatus").textContent = `${accountStatus} Use the original HTTPS MAG URL ending in /c/index.html; no query, fragment, or credentials. Do not use a TV browser or M3U URL.`;
      return;
    }
    const serverUrl = parsed.origin + parsed.pathname.slice(0, -"/c/index.html".length);
    checkingPortal = true;
    $("existingPortalStatus").textContent = "Checking which existing account owns this private URL…";
    let verified;
    try {
      verified = await request("/api/customers/portal-check", { method: "POST", body: JSON.stringify({ portal_url: savedUrl, mac_address: enteredMac }) });
    } catch (error) {
      if (generation === portalCheckGeneration && csrf) $("existingPortalStatus").textContent = `${accountStatus} Private URL verification failed: ${error.message}. No account was changed.`;
      return;
    } finally { checkingPortal = false; }
    if (generation !== portalCheckGeneration || !csrf || $("existingPortalUrl").value.trim() !== savedUrl ||
        $("existingAccountMac").value.trim().toUpperCase().replaceAll("-", ":") !== enteredMac) return;
    if (!verified.mac_matches) {
      $("existingPortalStatus").textContent = `The private URL belongs to ${verified.name}, but its saved MAC does not match ${enteredMac}. Check the app-reported MAC and this existing account; no account was changed.`;
      return;
    }
    if (!verified.is_active || !(Date.parse(verified.expires_at) > Date.now())) {
      $("existingPortalStatus").textContent = `The private URL belongs to ${verified.name} and the MAC matches, but that account is ${verified.is_active ? "expired" : "inactive"}. Correct this existing account in My Customers before testing.`;
      return;
    }
    const description = document.createElement("p");
    description.textContent = "Verified private URL, active account and saved MAC. Private Server address (never share it):";
    const address = document.createElement("p");
    address.textContent = serverUrl;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary-button";
    copy.textContent = "Copy private Server address";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(serverUrl); $("existingPortalStatus").textContent = "Private Server address copied."; }
      catch { $("existingPortalStatus").textContent = "Copy failed. Select and copy the address above."; }
    });
    result.append(description, address, copy);
    result.hidden = false;
    $("existingPortalStatus").textContent = `Verified: this private URL belongs to ${verified.name}, is active and unexpired, and its saved MAC matches ${enteredMac}. The app-reported MAC, login protocol and playback still require device testing.`;
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
    if (!listReady) { createStatus("My Customers must load before creating another account. Fix the TV service and use Refresh; a previous attempt may already have saved.", true); return; }
    if (button.disabled) return;
    const name = $("subscriberName").value.trim();
    const mac = $("subscriberMac").value.trim();
    if (!name || !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac)) {
      createStatus("Enter a name and a device MAC with six hex pairs (AA:BB:CC:DD:EE:FF).", true);
      return;
    }
    const months = Number($("subscriberMonths").value === "custom" ? $("subscriberCustomMonths").value : $("subscriberMonths").value);
    if (!Number.isInteger(months) || months < 1 || months > 120) { createStatus("Enter 1 to 120 months.", true); return; }
    creating = true;
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
      const confirmation = `Account created for ${result.name || name} (MAC ${result.mac_address || mac}, ${months} ${months === 1 ? "month" : "months"}). ${result.is_active ? "Active now: use the shared address above in your app’s matching mode after deploying the TV service." : "Inactive: select Activate in My Customers before the portal will work."}`;
      createStatus(`${confirmation} Save the URLs below now.`, false);
      showLink(result.playlist_url, result.portal_url, result.mag_portal_url, confirmation);
      try { await load(); }
      catch (error) { createStatus(`Account created for ${result.name || name}. Save the URLs below now. Customer list could not refresh: ${error.message}`, true); }
    } catch (error) {
      createStatus(`Customer was not confirmed: ${error.message} ${/timed out|did not return customer URLs/i.test(error.message) ? "Check My Customers before retrying; the request may have succeeded." : ""}`, true);
    } finally { creating = false; button.disabled = !listReady; button.textContent = "Create customer and URLs"; }
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