#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const Redis = require("ioredis");

// -------------------- CONFIG --------------------
const CONCURRENCY = Number(process.env.SEND_CONCURRENCY || 5);   // parallel accounts
const DEFAULT_EMAILS_PER_ACC = Number(process.env.EMAILS_PER_ACCOUNT_PER_HOUR || 40);
const DEFAULT_DELAY_MS = Number(process.env.PER_EMAIL_DELAY_MS || 1000);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 300);

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("❌ Missing REDIS_URL env var");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

// -------------------- HELPERS --------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowTs() {
  return Date.now();
}

function applyMerge(text, vars) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const [k, v] of Object.entries(vars || {})) {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, v == null ? "" : String(v));
  }
  // remove leftover {{...}}
  out = out.replace(/{{[^}]*}}/g, "");
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function convertTextToHTML(text) {
  if (!text) return "";
  return (
    `<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6; color: #333;">` +
    String(text)
      .replace(/\r?\n/g, "<br>")
      .replace(/  +/g, (spaces) => "&nbsp;".repeat(spaces.length)) +
    `</div>`
  );
}

// Account-level failure detection (same spirit as your backend)
function looksLikeAccountLevelFailure(err) {
  const msg = (err?.message || "").toLowerCase();
  return (
    msg.includes("invalid login") ||
    msg.includes("username and password not accepted") ||
    msg.includes("authentication failed") ||
    msg.includes("bad credentials") ||
    msg.includes("login") ||
    msg.includes("account") && msg.includes("disabled") ||
    msg.includes("application-specific password") ||
    msg.includes("too many login attempts") ||
    msg.includes("534-5.7.9") ||
    msg.includes("535-5.7.8")
  );
}

function createTransporter(account) {
  if (!account.email || !account.pass) {
    throw new Error(`Missing email/pass for account id=${account.id}`);
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: account.email, pass: account.pass },
  });
}

// Read accounts.json from repo root
function loadAccountsConfig() {
  const filePath = path.join(process.cwd(), "accounts.json");
  if (!fs.existsSync(filePath)) throw new Error("accounts.json not found in repo root");

  const raw = fs.readFileSync(filePath, "utf8");
  const accounts = JSON.parse(raw);
  if (!Array.isArray(accounts)) throw new Error("accounts.json must be an array");

  return accounts.map((a) => ({
    ...a,
    pass: process.env[`PASS_${a.id}`] || "",
  }));
}

async function redisGetJson(key) {
  const v = await redis.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function redisSetJson(key, obj) {
  await redis.set(key, JSON.stringify(obj));
}

async function redisDel(key) {
  await redis.del(key);
}

// push event list (stored as array in Redis)
async function pushEvent(eventsKey, ev) {
  let events = (await redisGetJson(eventsKey)) || [];
  if (!Array.isArray(events)) events = [];
  events.push(ev);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  await redisSetJson(eventsKey, events);
}

// -------------------- MAIN TICK --------------------
async function main() {
  console.log("🔧 GitHub Auto Tick Runner started");

  const activeId = await redis.get("auto:campaign:active");
  if (!activeId) {
    console.log("ℹ️ No active campaign");
    return;
  }

  const campaignKey = `auto:campaign:${activeId}`;
  const liveKey = `auto:campaign:${activeId}:live`;
  const statsKey = `auto:campaign:${activeId}:stats`;
  const eventsKey = `auto:campaign:${activeId}:events`;

  const campaign = await redisGetJson(campaignKey);
  if (!campaign) {
    console.log("⚠️ Campaign missing; clearing active pointer");
    await redisDel("auto:campaign:active");
    return;
  }

  if (campaign.status !== "running") {
    console.log(`ℹ️ Campaign status is ${campaign.status}, nothing to do`);
    return;
  }

  const accounts = loadAccountsConfig();
  let runtime = (await redisGetJson("accounts:runtime")) || {};
  if (typeof runtime !== "object" || runtime == null) runtime = {};

  const connectedAccounts = accounts.filter((a) => runtime[String(a.id)]?.connected !== false);
  const emailsPerAcc = Number(campaign.emailsPerAccountPerHour || DEFAULT_EMAILS_PER_ACC);
  const delayMs = Number(campaign.perEmailDelayMs || DEFAULT_DELAY_MS);

  const total = Number(campaign.total || (campaign.contacts ? campaign.contacts.length : 0));
  let cursor = Number(campaign.cursor || 0);

  // stats init
  let stats = (await redisGetJson(statsKey)) || {
    campaignId: campaign.id,
    totalSent: 0,
    totalFailed: 0,
    byAccount: {},
  };

  // Completed?
  if (cursor >= total) {
    campaign.status = "completed";
    campaign.updatedAt = nowTs();
    await redisSetJson(campaignKey, campaign);
    await redisSetJson("auto:campaign:last", campaign.id);
    await redisDel("auto:campaign:active");
    await redisSetJson(liveKey, { state: "completed", updatedAt: nowTs() });
    await pushEvent(eventsKey, { ts: nowTs(), status: "campaign_completed", campaignId: campaign.id });
    console.log("✅ Already completed; marked completed");
    return;
  }

  if (connectedAccounts.length === 0) {
    await redisSetJson(liveKey, { state: "idle_no_accounts", updatedAt: nowTs() });
    console.log("⚠️ No connected accounts");
    return;
  }

  // Hour plan
  const hourPlan = [];
  let tmpCursor = cursor;

  for (const acc of connectedAccounts) {
    const start = tmpCursor;
    const end = Math.min(tmpCursor + emailsPerAcc, total);
    if (start >= end) break;

    hourPlan.push({ account: acc, contacts: campaign.contacts.slice(start, end) });
    tmpCursor = end;
  }

  // Save cursor early (prevents resend next hour)
  campaign.cursor = tmpCursor;
  campaign.updatedAt = nowTs();
  await redisSetJson(campaignKey, campaign);

  console.log(`📦 Hour plan: ${hourPlan.length} accounts, cursor ${cursor} -> ${tmpCursor} / ${total}`);

  async function setLive(payload) {
    await redisSetJson(liveKey, { ...payload, updatedAt: nowTs() });
  }

  async function sendBatchForAccount(account, contactsSlice) {
    const accountIdStr = String(account.id);

    stats.byAccount[accountIdStr] = stats.byAccount[accountIdStr] || {
      email: account.email,
      senderName: account.senderName || "",
      sent: 0,
      failed: 0,
      lastSentAt: 0,
    };

    let transporter = createTransporter(account);
    let sent = 0;
    let failed = 0;

    for (const c of contactsSlice) {
      const to =
        c.email || c.Email || c.EMAIL || c["Email Address"] || c.email_address || c.mail || c.Mail || "";

      if (!to) {
        failed++;
        stats.totalFailed++;
        stats.byAccount[accountIdStr].failed++;
        await redisSetJson(statsKey, stats);

        await pushEvent(eventsKey, {
          ts: nowTs(),
          accountId: account.id,
          from: account.email,
          senderName: account.senderName || "",
          to: "",
          status: "failed",
          error: "Missing email in contact row",
        });
        continue;
      }

      try {
        await setLive({
          state: "sending",
          currentAccountId: account.id,
          currentEmail: account.email,
          currentSenderName: account.senderName || "",
          currentTo: to,
        });

        const vars = { brandName: campaign.brandName, senderName: account.senderName, ...c };
        const subject = applyMerge(campaign.template.subject, vars);
        const bodyText = applyMerge(campaign.template.content, vars);
        const html = convertTextToHTML(bodyText);

        await transporter.sendMail({
          from: `${account.senderName} <${account.email}>`,
          to,
          subject,
          html,
        });

        sent++;
        stats.totalSent++;
        stats.byAccount[accountIdStr].sent++;
        stats.byAccount[accountIdStr].lastSentAt = nowTs();
        await redisSetJson(statsKey, stats);

        await pushEvent(eventsKey, {
          ts: nowTs(),
          accountId: account.id,
          from: account.email,
          senderName: account.senderName || "",
          to,
          status: "sent",
        });

        if (delayMs > 0) await sleep(delayMs);
      } catch (err) {
        failed++;
        stats.totalFailed++;
        stats.byAccount[accountIdStr].failed++;
        await redisSetJson(statsKey, stats);

        await pushEvent(eventsKey, {
          ts: nowTs(),
          accountId: account.id,
          from: account.email,
          senderName: account.senderName || "",
          to,
          status: "failed",
          error: err.message || String(err),
        });

        // Disconnect account on account-level failures
        if (looksLikeAccountLevelFailure(err)) {
          runtime[accountIdStr] = runtime[accountIdStr] || {};
          runtime[accountIdStr].connected = false;
          runtime[accountIdStr].lastError = err.message || "Account disabled due to failure";
          await redisSetJson("accounts:runtime", runtime);

          console.log(`🚫 Disabled account ${account.email} due to account-level failure`);
          break;
        }
      }
    }

    return { accountId: account.id, email: account.email, sent, failed };
  }

  // Workers with limited concurrency
  const results = [];
  let idx = 0;

  const workers = new Array(Math.min(CONCURRENCY, hourPlan.length)).fill(0).map(async () => {
    while (idx < hourPlan.length) {
      const myIndex = idx++;
      const job = hourPlan[myIndex];
      const r = await sendBatchForAccount(job.account, job.contacts);
      results.push(r);
    }
  });

  await Promise.all(workers);

  // Completion check
  const updatedCampaign = await redisGetJson(campaignKey);
  if (updatedCampaign && Number(updatedCampaign.cursor || 0) >= total) {
    updatedCampaign.status = "completed";
    updatedCampaign.updatedAt = nowTs();
    await redisSetJson(campaignKey, updatedCampaign);
    await redisSetJson("auto:campaign:last", updatedCampaign.id);
    await redisDel("auto:campaign:active");

    await setLive({ state: "completed", currentAccountId: null, currentEmail: null, currentSenderName: null });
    await pushEvent(eventsKey, { ts: nowTs(), status: "campaign_completed", campaignId: updatedCampaign.id });

    console.log("✅ Campaign completed in this tick");
  } else {
    await setLive({ state: "idle_waiting_next_tick", currentAccountId: null, currentEmail: null, currentSenderName: null });
    console.log("⏳ Tick done; waiting next hour");
  }

  console.log("📊 Results:", results);
}

main()
  .then(() => redis.quit())
  .catch(async (e) => {
    console.error("❌ Runner error:", e);
    try { await redis.quit(); } catch {}
    process.exit(1);
  });
