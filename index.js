document.getElementById("loginForm").addEventListener("submit", async function(e) {
  e.preventDefault();

  var email = document.getElementById("loginEmail").value.trim();
  var password = document.getElementById("loginPassword").value;
  var messageEl = document.getElementById("loginMessage");
  var btn = document.getElementById("loginBtn");

  btn.disabled = true;
  messageEl.textContent = "Logging in...";
  messageEl.className = "signup-message info";

  try {
    await login(email, password);
    messageEl.textContent = "Login successful!";
    messageEl.className = "signup-message success";
    applyAuthGate();
    this.reset();
  } catch (err) {
    messageEl.textContent = err.message;
    messageEl.className = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("logoutBtn").addEventListener("click", function() {
  logout();
  applyAuthGate();
});

document.getElementById("showResetBtn").addEventListener("click", function() {
  document.getElementById("loginForm").hidden = true;
  document.getElementById("resetPasswordForm").hidden = false;
  document.getElementById("resetMessage").textContent = "";
  document.getElementById("resetMessage").className = "signup-message";
});

document.getElementById("cancelResetBtn").addEventListener("click", function() {
  document.getElementById("resetPasswordForm").hidden = true;
  document.getElementById("loginForm").hidden = false;
  document.getElementById("resetMessage").textContent = "";
  document.getElementById("resetMessage").className = "signup-message";
});

document.getElementById("resetPasswordForm").addEventListener("submit", async function(e) {
  e.preventDefault();

  var name = document.getElementById("resetName").value.trim();
  var email = document.getElementById("resetEmail").value.trim();
  var currentPassword = document.getElementById("resetCurrentPassword").value;
  var newPassword = document.getElementById("resetNewPassword").value;
  var messageEl = document.getElementById("resetMessage");
  var btn = document.getElementById("resetBtn");

  if (newPassword.length < 6) {
    messageEl.textContent = "New password must be at least 6 characters.";
    messageEl.className = "signup-message error";
    return;
  }

  btn.disabled = true;
  messageEl.textContent = "Updating password...";
  messageEl.className = "signup-message info";

  try {
    var result = await jsonpReset(name, email, currentPassword, newPassword);
    messageEl.textContent = result.message;
    messageEl.className = "signup-message success";
    this.reset();

    setTimeout(function() {
      document.getElementById("resetPasswordForm").hidden = true;
      document.getElementById("loginForm").hidden = false;
    }, 2500);
  } catch (err) {
    messageEl.textContent = err.message;
    messageEl.className = "signup-message error";
  } finally {
    btn.disabled = false;
  }
});

function jsonpReset(name, email, currentPassword, newPassword) {
  return new Promise(function(resolve, reject) {
    var callbackName = "umpireReset_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    var script = document.createElement("script");
    var url = new URL(AUTH_API_URL);
    var settled = false;

    url.searchParams.set("action", "resetPassword");
    url.searchParams.set("callback", callbackName);
    url.searchParams.set("name", name);
    url.searchParams.set("email", email);
    url.searchParams.set("currentPassword", currentPassword);
    url.searchParams.set("newPassword", newPassword);

    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      delete window[callbackName];
      script.remove();
      reject(new Error("Password reset timed out. Please check your connection and try again."));
    }, JSONP_TIMEOUT_MS);

    window[callbackName] = function(payload) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      if (payload && payload.ok) {
        resolve(payload);
      } else {
        reject(new Error((payload && payload.message) || "Password reset failed."));
      }
    };

    script.onerror = function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      reject(new Error("Unable to reach the password reset service."));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}
