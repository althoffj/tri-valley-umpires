// admin-config.js — Pay rates, default slot types, Slack webhooks, push notifications
import { db } from "./firebase.js";
import { authReadyPromise, isAdmin } from "./auth.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  updateDoc,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setMsg(id, text, type = "info") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = `signup-message ${type}`;
}

// ── Pay Rates ─────────────────────────────────────────────────────────────────

async function loadPayRates() {
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    if (snap.exists()) {
      const r = snap.data();
      document.getElementById("ratePlate").value = r.plate ?? "";
      document.getElementById("rateField").value  = r.field  ?? "";
      document.getElementById("rateExtra").value  = r.extra  ?? "";

      // Load defaultSlotTypes checkboxes
      const defaults = r.defaultSlotTypes ?? [];
      document.getElementById("defaultSlotPlate").checked = defaults.includes("Plate");
      document.getElementById("defaultSlotField").checked = defaults.includes("Field");
      document.getElementById("defaultSlotExtra").checked = defaults.includes("Extra");
    }
  } catch (err) {
    console.error("Failed to load pay rates:", err);
  }
}

document.getElementById("payRatesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("payRatesMessage", "Saving…", "info");
  try {
    const snap = await getDoc(doc(db, "config", "payRates"));
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(doc(db, "config", "payRates"), {
      ...existing,
      plate: parseFloat(document.getElementById("ratePlate").value) || 0,
      field: parseFloat(document.getElementById("rateField").value)  || 0,
      extra: parseFloat(document.getElementById("rateExtra").value)  || 0
    });
    setMsg("payRatesMessage", "Pay rates saved.", "success");
  } catch (err) {
    setMsg("payRatesMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Default Slot Types ────────────────────────────────────────────────────────

document.getElementById("defaultSlotTypesForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("defaultSlotTypesMessage", "Saving…", "info");
  try {
    const selected = ["Plate", "Field", "Extra"].filter(t =>
      document.getElementById(`defaultSlot${t}`).checked
    );
    const snap = await getDoc(doc(db, "config", "payRates"));
    const existing = snap.exists() ? snap.data() : {};
    await setDoc(doc(db, "config", "payRates"), {
      ...existing,
      defaultSlotTypes: selected
    });
    setMsg("defaultSlotTypesMessage", "Default slot types saved.", "success");
  } catch (err) {
    setMsg("defaultSlotTypesMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Slack Webhooks ────────────────────────────────────────────────────────────

async function loadSlackWebhooks() {
  try {
    const snap = await getDoc(doc(db, "config", "slackWebhooks"));
    if (snap.exists()) {
      const d = snap.data();
      document.getElementById("slackJeff").value = d.jeff  || "";
      document.getElementById("slack10u").value  = d.ch10u || "";
      document.getElementById("slack12u").value  = d.ch12u || "";
    }
  } catch (_) {}
}

document.getElementById("slackWebhooksForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn = this.querySelector("button[type='submit']");
  btn.disabled = true;
  setMsg("slackWebhooksMessage", "Saving…", "info");
  try {
    await setDoc(doc(db, "config", "slackWebhooks"), {
      jeff:  document.getElementById("slackJeff").value.trim(),
      ch10u: document.getElementById("slack10u").value.trim(),
      ch12u: document.getElementById("slack12u").value.trim()
    });
    setMsg("slackWebhooksMessage", "Webhooks saved.", "success");
  } catch (err) {
    setMsg("slackWebhooksMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Push Notifications ────────────────────────────────────────────────────────

document.getElementById("notifForm").addEventListener("submit", async function(e) {
  e.preventDefault();
  const btn   = document.getElementById("sendNotifBtn");
  const title = document.getElementById("notifTitle").value.trim();
  const body  = document.getElementById("notifBody").value.trim();

  btn.disabled = true;
  setMsg("notifMessage", "Sending notifications…", "info");

  try {
    // Load approved umpires for email notifications
    const snap = await getDocs(query(collection(db, "umpires"), orderBy("lastName")));
    const approved = snap.docs.map(d => d.data()).filter(u => u.approved && u.email);

    if (typeof emailjs !== "undefined") {
      emailjs.init("H9Z9Qz-HB-PehAQjp");
      await Promise.allSettled(approved.map(u =>
        emailjs.send("service_vljauqe", "template_notification", {
          to_name:     u.name,
          to_email:    u.email,
          notif_title: title,
          notif_body:  body
        })
      ));
    }
    setMsg("notifMessage", `Notification sent to ${approved.length} umpire${approved.length !== 1 ? "s" : ""}.`, "success");
    this.reset();
  } catch (err) {
    setMsg("notifMessage", err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

authReadyPromise.then(() => {
  if (!isAdmin()) {
    document.getElementById("adminContent").style.display = "none";
    document.getElementById("noAccess").style.display = "";
    return;
  }
  document.getElementById("adminContent").style.display = "";
  document.getElementById("noAccess").style.display = "none";

  loadPayRates();
  loadSlackWebhooks();
});
