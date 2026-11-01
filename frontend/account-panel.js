/* Bitlog: one unobtrusive action panel for login, posting, and account settings. */
(() => {
  const el = (id) => document.getElementById(id);
  const ui = {};
  let activeName = null;
  let pendingReset = null;
  let currentPreferences = null;
  let mode = "loading";
  let submitting = false;
  let removeEmailRequested = false;
  // Only in this page's memory. Never put it in a cookie or browser storage.
  let memoryToken = null;

  function authHeaders() {
    return memoryToken ? { Authorization: `Bearer ${memoryToken}` } : {};
  }

  function timeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  }

  async function send(path, data = {}) {
    const zone = timeZone();
    const res = await fetch(`/api/account/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(zone ? { ...data, time_zone: zone } : data),
    });
    const value = await res.json().catch(() => ({}));
    if (!res.ok || value.ok === false) {
      const error = new Error(value.message || `Request failed (${res.status})`);
      error.code = value.code || "request_failed";
      error.status = res.status;
      throw error;
    }
    return value;
  }

  function notice(text = "") {
    ui.notice.textContent = text;
    ui.notice.hidden = !text;
  }

  function settingsMessage(text = "") {
    ui.settingsMessage.textContent = text;
  }

  function show(view) {
    mode = view;
    ui.loading.hidden = view !== "loading";
    ui.login.hidden = view !== "login";
    ui.reset.hidden = view !== "reset";
    ui.compose.hidden = view !== "signed";
    if (view === "signed")
      requestAnimationFrame(resizeEntryText);
    if (view !== "signed") {
      ui.settings.hidden = true;
      ui.settingsToggle.setAttribute("aria-expanded", "false");
    }
  }

  function updateUser(data) {
    activeName = data.name;
    currentPreferences = { ...data };
    delete currentPreferences.auth_token;
    el("name").value = activeName; // Retained for existing user-picker logic.
    ui.username.textContent = activeName;
    ui.email.value = "";
    ui.email.placeholder = data.email_masked || "Email address";
    ui.removeEmail.hidden = !data.has_email;
    ui.removeEmail.textContent = "remove email";
    removeEmailRequested = false;
    ui.reminders.checked = data.reminders_enabled === true;
    ui.newPassword.value = "";
    settingsMessage();
    ui.loginPassword.value = "";
    ui.resetPassword.value = "";
  }

  function loginFailed(message) {
    memoryToken = null;
    activeName = null;
    currentPreferences = null;
    pendingReset = null;
    show("login");
    notice(message);
  }

  function signedIn(data) {
    // Remembered logins have an HttpOnly cookie; unchecked logins instead
    // return a bearer token that is discarded when the page reloads.
    memoryToken = typeof data.auth_token === "string" ? data.auth_token : null;
    pendingReset = null;
    updateUser(data);
    notice();
    show("signed");
  }

  async function refreshAuthentication() {
    show("loading");
    notice();
    const params = new URLSearchParams(window.location.search);
    const hasUrlCredential = params.has("user") || params.has("reset_pass");

    if (hasUrlCredential) {
      const user = params.get("user") || "";
      const resetPass = params.get("reset_pass") || "";
      // Never attempt the cookie if URL credentials are present.
      try {
        const data = await send("auth", { user, reset_pass: resetPass });
        if (data.mode !== "reset") throw new Error("Reset authentication failed");
        pendingReset = { user, reset_pass: resetPass };
        activeName = null;
        ui.resetPassword.value = "";
        ui.resetStay.checked = true;
        show("reset");
        ui.resetPassword.focus();
      } catch (error) {
        // A failed URL should not keep overriding a later successful login.
        const cleaned = new URL(window.location.href);
        cleaned.searchParams.delete("user");
        cleaned.searchParams.delete("reset_pass");
        history.replaceState(history.state, "", cleaned.pathname + cleaned.search + cleaned.hash);
        loginFailed("Reset-link authentication failed. Enter your usual username and password.");
      }
      return;
    }

    try {
      const data = await send("auth");
      signedIn(data);
    } catch (error) {
      loginFailed(error.code === "no_cookie" ? "" : "Saved-login authentication failed.");
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (submitting) return;
    const name = ui.loginName.value.trim();
    const password = ui.loginPassword.value;
    if (!name) {
      notice("Enter a username.");
      ui.loginName.focus();
      return;
    }
    submitting = true;
    ui.loginSubmit.disabled = true;
    notice();
    try {
      const data = await send("login", {
        name, password, stay_signed_in: ui.loginStay.checked,
      });
      signedIn(data);
      if (typeof window.load === "function") void window.load(data.name);
    } catch (error) {
      notice(error.message);
    } finally {
      submitting = false;
      ui.loginSubmit.disabled = false;
    }
  }

  async function requestReset() {
    const name = ui.loginName.value.trim();
    if (!name) {
      notice("Enter the username first.");
      ui.loginName.focus();
      return;
    }
    ui.resetRequest.disabled = true;
    notice();
    try {
      const result = await send("reset-request", { name });
      notice(result.message);
    } catch (error) {
      notice(error.message);
    } finally {
      ui.resetRequest.disabled = false;
    }
  }

  async function handleReset(event) {
    event.preventDefault();
    if (!pendingReset || submitting) return;
    if (!ui.resetPassword.value) {
      notice("Enter a new password.");
      return;
    }
    submitting = true;
    ui.resetSubmit.disabled = true;
    notice();
    try {
      const result = await send("password", {
        ...pendingReset,
        new_password: ui.resetPassword.value,
        stay_signed_in: ui.resetStay.checked,
      });
      // This token can no longer be used once the new password is saved.
      const url = new URL(window.location.href);
      url.searchParams.delete("user");
      url.searchParams.delete("reset_pass");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      signedIn(result);
      if (typeof window.load === "function") void window.load(result.name);
    } catch (error) {
      notice(error.message);
    } finally {
      submitting = false;
      ui.resetSubmit.disabled = false;
    }
  }

  function toggleSettings() {
    if (mode !== "signed") return;
    const open = ui.settings.hidden;
    ui.settings.hidden = !open;
    ui.settingsToggle.setAttribute("aria-expanded", String(open));
    if (open) {
      ui.email.value = "";
      ui.email.placeholder = currentPreferences?.email_masked || "Email address";
      removeEmailRequested = false;
      ui.removeEmail.textContent = "remove email";
      ui.reminders.checked = currentPreferences?.reminders_enabled === true;
      ui.newPassword.value = "";
      settingsMessage();
    }
  }

  async function saveSettings(event) {
    event.preventDefault();
    if (mode !== "signed" || submitting) return;
    const values = { reminders_enabled: ui.reminders.checked };
    const email = ui.email.value.trim();
    if (removeEmailRequested) values.remove_email = true;
    else if (email) values.email = email;
    if (ui.newPassword.value) values.new_password = ui.newPassword.value;
    submitting = true;
    ui.saveSettings.disabled = true;
    settingsMessage();
    try {
      const changedPassword = !!ui.newPassword.value;
      const result = await send("settings", values);
      if (changedPassword) {
        memoryToken = typeof result.auth_token === "string" ? result.auth_token : null;
      }
      updateUser(result);
      ui.settings.hidden = true;
      ui.settingsToggle.setAttribute("aria-expanded", "false");
    } catch (error) {
      if (error.status === 401) {
        loginFailed("Saved-login authentication failed.");
      } else {
        settingsMessage(error.message);
      }
    } finally {
      submitting = false;
      ui.saveSettings.disabled = false;
    }
  }

  function toggleRemoveEmail() {
    removeEmailRequested = !removeEmailRequested;
    ui.removeEmail.textContent = removeEmailRequested ? "undo remove" : "remove email";
    ui.email.value = "";
    ui.email.placeholder = removeEmailRequested
      ? "email will be removed" : (currentPreferences?.email_masked || "Email address");
    if (removeEmailRequested) ui.reminders.checked = false;
  }

  async function logout() {
    try {
      await send("logout");
    } catch {
      // Still remove the visible authenticated UI.
    }
    loginFailed("");
    ui.loginPassword.value = "";
    ui.loginStay.checked = true;
  }

  function sessionExpired() {
    loginFailed("Saved-login authentication failed.");
  }

  function init() {
    for (const [name, id] of Object.entries({
      loading: "auth-loading", login: "auth-login", reset: "auth-reset",
      compose: "auth-compose", notice: "auth-notice",
      loginName: "login-name", loginPassword: "login-password",
      loginStay: "login-stay", loginSubmit: "login-submit",
      resetRequest: "login-reset-email", resetPassword: "reset-new-password",
      resetStay: "reset-stay", resetSubmit: "reset-submit",
      username: "account-username", settings: "account-settings",
      settingsToggle: "account-settings-toggle", email: "account-email",
      removeEmail: "account-remove-email", reminders: "account-reminders", newPassword: "account-new-password",
      saveSettings: "account-save", settingsMessage: "account-feedback",
      logout: "account-logout",
    })) {
      ui[name] = el(id);
      if (!ui[name]) throw new Error(`Missing account UI element: ${id}`);
    }
    ui.login.addEventListener("submit", handleLogin);
    ui.resetRequest.addEventListener("click", requestReset);
    ui.reset.addEventListener("submit", handleReset);
    ui.settingsToggle.addEventListener("click", toggleSettings);
    ui.settings.addEventListener("submit", saveSettings);
    ui.removeEmail.addEventListener("click", toggleRemoveEmail);
    ui.email.addEventListener("input", () => {
      if (removeEmailRequested && ui.email.value.trim()) {
        removeEmailRequested = false;
        ui.removeEmail.textContent = "remove email";
      }
    });
    ui.logout.addEventListener("click", logout);
    void refreshAuthentication();
  }

  window.BitlogAccount = {
    name: () => mode === "signed" ? activeName : null,
    authHeaders,
    signedIn: () => mode === "signed" && !!activeName,
    timeZone,
    sessionExpired,
    refreshAuthentication,
  };
  document.addEventListener("DOMContentLoaded", init);
})();
