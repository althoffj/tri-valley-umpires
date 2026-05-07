var APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxAUMxCm-PebuhlMTlnODLyaWXwtO5rbiAzBVgI8ozSJQeGxPyB_t6StTiI1Ejy_QOA/exec";

emailjs.init("H9Z9Qz-HB-PehAQjp");

document.getElementById("umpireForm").addEventListener("submit", async function(e) {
  e.preventDefault();

  var submitBtn = this.querySelector('button[type="submit"]');
  var turnstileResponse = document.querySelector('[name="cf-turnstile-response"]')?.value;

  if (!turnstileResponse) {
    alert("Please complete the security check before submitting.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting...";

  var formData = {
    name: document.getElementById("name").value,
    address: document.getElementById("address").value || "Not provided",
    email: document.getElementById("email").value,
    phone: document.getElementById("phone").value,
    signature: document.getElementById("signature").value,
    password: document.getElementById("password").value,
    parent_name: document.getElementById("parent_name").value || "Not provided",
    parent_email: document.getElementById("parent_email").value || "",
    parent_phone: document.getElementById("parent_phone").value || "",
    datetime: new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }),
    main_page_link: "https://althoffj.github.io/tri-valley-umpires/"
  };

  var emailSuccess = false;
  var sheetSuccess = false;
  var errors = [];

  try {
    await emailjs.send("service_vljauqe", "template_om0629c", formData);
    emailSuccess = true;
  } catch (err) {
    errors.push("Email notification failed: " + err.message);
  }

  if (formData.parent_email) {
    try {
      await emailjs.send("service_vljauqe", "template_n8kehkc", formData);
    } catch (err) {
      errors.push("Parent email notification failed: " + err.message);
    }
  }

  try {
    await new Promise(function(resolve, reject) {
      var callbackName = "umpireSubmit_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var script = document.createElement("script");
      var url = new URL(APPS_SCRIPT_URL);
      var settled = false;

      url.searchParams.set("action", "submitAcknowledgment");
      url.searchParams.set("callback", callbackName);
      url.searchParams.set("name", formData.name);
      url.searchParams.set("email", formData.email);
      url.searchParams.set("phone", formData.phone);
      url.searchParams.set("signature", formData.signature);
      url.searchParams.set("password", formData.password);
      url.searchParams.set("parent_name", formData.parent_name);
      url.searchParams.set("parent_email", formData.parent_email);
      url.searchParams.set("parent_phone", formData.parent_phone);

      var timer = setTimeout(function() {
        if (settled) return;
        settled = true;
        delete window[callbackName];
        script.remove();
        reject(new Error("Submission timed out. Please check your connection and try again."));
      }, 10000);

      window[callbackName] = function(payload) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete window[callbackName];
        script.remove();
        if (payload && payload.ok) {
          resolve(payload);
        } else {
          reject(new Error((payload && payload.message) || "Submission failed."));
        }
      };

      script.onerror = function() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete window[callbackName];
        script.remove();
        reject(new Error("Unable to reach the submission service."));
      };

      script.src = url.toString();
      document.body.appendChild(script);
    });
    sheetSuccess = true;
  } catch (err) {
    errors.push("Roster submission failed: " + err.message);
  }

  if (window.turnstile) turnstile.reset();

  if (emailSuccess || sheetSuccess) {
    localStorage.setItem("umpireName", formData.name);
    localStorage.setItem("umpireEmail", formData.email);

    alert("Thank you, " + formData.name + "! Your acknowledgment has been recorded. You can now log in on the home page to view contact info and sign up for games.");
    this.reset();
  } else {
    alert("We encountered an issue saving your acknowledgment.\n\n" + errors.join("\n") + "\n\nPlease try again or contact the league.");
  }

  submitBtn.disabled = false;
  submitBtn.textContent = "Submit Official Acknowledgment";
});
