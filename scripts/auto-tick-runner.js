/* scripts/auto-tick-runner.js
   GitHub Actions runner: sends auto campaign emails using Redis state.
   - Uses a GLOBAL QUEUE so if an account fails/quota hits, the SAME contact can be retried
     by the next account in the SAME tick.
   - Stores leftover unsent contacts into Redis retry queue for next tick.
*/

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const Redis = require("ioredis");

// -------------------------
// Helpers
// -------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyMerge(str, vars) {
  if (!str) return "";
  let out = String(str);
  for (const [k, v] of Object.entries(vars || {})) {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, v == null ? "" : String(v));
  }
  out = out.replace(/{{[^}]*}}/g, "");
  return out;
}

function convertTextToHTML(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r?\n/g, "<br>")
    .replace(/  +/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(
      /^/,
      '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6; color:#333;">'
    )
    .replace(/$/, "</div>");
}

// Account-level failure (disable account)
function looksLikeAccountLevelFailure(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return (
    msg.includes("invalid login") ||
    msg.includes("username and password not accepted") ||
    msg.includes("authentication failed") ||
    (msg.includes("auth") && msg.includes("failed")) ||
    msg.includes("daily user sending limit exceeded") ||
    msg.includes("rate limit") ||
    msg.includes("too many login attempts") ||
    msg.includes("account disabled") ||
    msg.includes("bad credentials")
  );
}

// Permanent recipient failure (do NOT retry with another account)
function looksLikePermanentRecipientFailure(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return (
    msg.includes("5.1.1") || // user unknown
    msg.includes("no such user") ||
    msg.includes("recipient address rejected") ||
    msg.includes("mailbox unavailable") ||
    msg.includes("address not found") ||
    msg.includes("invalid recipient") ||
    msg.includes("domain not found")
  );
}

function loadAccountsConfig() {
  const filePath = path.join(process.cwd(), "accounts.json");
  if (!fs.existsSync(filePath)) throw new Error("accounts.json not found in repo root");

  const accounts = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(accounts)) throw new Error("accounts.json must be an array");

  // attach pass from env PASS_<id>
  return accounts.map((a) => ({
    ...a,
    pass: process.env[`PASS_${a.id}`] || ""
  }));
}

function createTransporter(account) {
  if (!account?.email || !account?.pass) {
    throw new Error(`Missing email/pass for account id=${account?.id}`);
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: account.email, pass: account.pass }
  });
}

// Redis JSON helpers
async function redisGetJSON(redis, key) {
  const v = await redis.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function redisSetJSON(redis, key, value) {
  await redis.set(key, JSON.stringify(value));
}

function extractTo(c) {
  return (
    c.email ||
    c.Email ||
    c.EMAIL ||
    c["Email Address"] ||
    c.email_address ||
    c.mail ||
    c.Mail ||
    ""
  );
}

// -------------------------
// Main
// -------------------------
(async function main() {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) throw new Error("Missing REDIS_URL env var (add it to GitHub Secrets)");

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true });

  try {
    // Step 1: Get active campaign ID from Redis
    const activeId = await redis.get("auto:campaign:active");
    if (!activeId) {
      console.log("[AUTO] No active campaign. Exiting.");
      process.exit(0);
    }

    // Step 2: Check if the campaign exists and is running
    const campaignKey = `auto:campaign:${activeId}`;
    const liveKey = `auto:campaign:${activeId}:live`;
    const statsKey = `auto:campaign:${activeId}:stats`;
    const eventsKey = `auto:campaign:${activeId}:events`;
    const retryKey = `auto:campaign:${activeId}:retry`; // stores unsent contacts for next tick

    const campaign = await redisGetJSON(redis, campaignKey);
    if (!campaign) {
      console.log("[AUTO] Campaign missing; clearing active pointer.");
      await redis.del("auto:campaign:active");
      process.exit(0);
    }

    // Ensure campaign status is "running"
    if (campaign.status !== "running") {
      console.log(`[AUTO] Campaign status is ${campaign.status}. Exiting.`);
      process.exit(0);
    }

    // Step 3: Get connected accounts
    const accounts = loadAccountsConfig();
    const runtime = (await redisGetJSON(redis, "accounts:runtime")) || {};
    let connectedAccounts = accounts.filter((a) => runtime[String(a.id)]?.connected !== false);

    const emailsPerAcc = Number(campaign.emailsPerAccountPerHour || 40);
    const delayMs = Number(campaign.perEmailDelayMs || 1000);

    const total = campaign.contacts.length;
    let cursor = campaign.cursor || 0;

    // Step 4: Initialize stats and events
    let stats = (await redisGetJSON(redis, statsKey)) || {
      campaignId: campaign.id,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    let events = (await redisGetJSON(redis, eventsKey)) || [];
    if (!Array.isArray(events)) events = [];

    async function pushEvent(ev) {
      events.push(ev);
      if (events.length > 800) events = events.slice(-800);
      await redisSetJSON(redis, eventsKey, events);
    }

    async function setLive(payload) {
      await redisSetJSON(redis, liveKey, { ...payload, updatedAt: Date.now() });
    }

    // Step 5: Handle cursor and retry
    if (cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSetJSON(redis, campaignKey, campaign);
      await redis.set("auto:campaign:last", campaign.id);
      await redis.del("auto:campaign:active");
      await setLive({ state: "completed", currentEmail: null, currentAccountId: null, currentSenderName: null });

      console.log("[AUTO] Completed (no contacts left).");
      process.exit(0);
    }

    if (connectedAccounts.length === 0) {
      await setLive({ state: "idle_no_accounts", currentEmail: null, currentAccountId: null, currentSenderName: null });
      console.log("[AUTO] No connected accounts. Exiting.");
      process.exit(0);
    }

    // Step 6: Build global queue
    const tickCapacity = connectedAccounts.length * emailsPerAcc;
    let retryQueue = (await redisGetJSON(redis, retryKey)) || [];
    if (!Array.isArray(retryQueue)) retryQueue = [];

    const fromRetry = retryQueue.slice(0, tickCapacity);
    retryQueue = retryQueue.slice(fromRetry.length);

    const remainingCapacity = tickCapacity - fromRetry.length;
    const fromMain = campaign.contacts.slice(cursor, Math.min(cursor + remainingCapacity, total));
    const takenFromMain = fromMain.length;

    // Update campaign cursor
    campaign.cursor = cursor + takenFromMain;
    campaign.updatedAt = Date.now();
    await redisSetJSON(redis, campaignKey, campaign);

    // Save leftover retry back
    await redisSetJSON(redis, retryKey, retryQueue);

    // Global queue
    const queue = [...fromRetry, ...fromMain];

    console.log(`[AUTO] Tick capacity=${tickCapacity}, pulled retry=${fromRetry.length}, pulled main=${takenFromMain}`);
    console.log(`[AUTO] Queue size this tick: ${queue.length}`);

    if (queue.length === 0) {
      await setLive({ state: "idle_waiting_next_tick", currentEmail: null, currentAccountId: null, currentSenderName: null });
      console.log("[AUTO] Nothing queued this tick.");
      process.exit(0);
    }

    // Main sending loop
    const carryOver = [];

    // Helper to init per-account stats
    function ensureAccountStats(a) {
      const idStr = String(a.id);
      if (!stats.byAccount[idStr]) {
        stats.byAccount[idStr] = {
          email: a.email,
          senderName: a.senderName || "",
          sent: 0,
          failed: 0,
          lastSentAt: 0
        };
      }
      return idStr;
    }

    // ---------
    // Main loop: attempt to send emails
    // ---------
    const results = [];

    for (const account of connectedAccounts) {
      const idStr = ensureAccountStats(account);

      let transporter;
      try {
        transporter = createTransporter(account);
      } catch (e) {
        runtime[idStr] = runtime[idStr] || {};
        runtime[idStr].connected = false;
        runtime[idStr].lastError = e.message;
        await redisSetJSON(redis, "accounts:runtime", runtime);

        console.log(`[AUTO] Account disabled (missing creds): ${account.email} :: ${e.message}`);
        results.push({ accountId: account.id, email: account.email, sent: 0, failed: 0, errors: [{ error: e.message }] });
        continue;
      }

      let sent = 0;
      let failed = 0;
      const errors = [];

      for (let i = 0; i < emailsPerAcc; i++) {
        if (queue.length === 0) break;

        const c = queue[0];
        const to = extractTo(c);

        if (!to) {
          queue.shift();
          failed++;
          stats.totalFailed++;
          stats.byAccount[idStr].failed++;
          await redisSetJSON(redis, statsKey, stats);

          await pushEvent({
            ts: Date.now(),
            accountId: account.id,
            from: account.email,
            senderName: account.senderName || "",
            to: "",
            status: "failed",
            error: "Missing email in contact row"
          });

          continue;
        }

        try {
          await setLive({
            state: "sending",
            currentAccountId: account.id,
            currentEmail: account.email,
            currentSenderName: account.senderName || "",
            currentTo: to
          });

          const vars = { brandName: campaign.brandName, senderName: account.senderName || "", ...c };

          const subj = applyMerge(campaign.template.subject, vars);
          const bodyText = applyMerge(campaign.template.content, vars);
          const html = convertTextToHTML(bodyText);

          await transporter.sendMail({
            from: `${account.senderName || ""} <${account.email}>`,
            to,
            subject: subj,
            html
          });

          queue.shift();

          sent++;
          stats.totalSent++;
          stats.byAccount[idStr].sent++;
          stats.byAccount[idStr].lastSentAt = Date.now();
          await redisSetJSON(redis, statsKey, stats);

          await pushEvent({
            ts: Date.now(),
            accountId: account.id,
            from: account.email,
            senderName: account.senderName || "",
            to,
            status: "sent"
          });

          if (delayMs > 0) await sleep(delayMs);
        } catch (err) {
          const msg = err?.message || "Unknown error";

          if (looksLikeAccountLevelFailure(err)) {
            runtime[idStr] = runtime[idStr] || {};
            runtime[idStr].connected = false;
            runtime[idStr].lastError = msg;
            await redisSetJSON(redis, "accounts:runtime", runtime);

            failed++;
            stats.totalFailed++;
            stats.byAccount[idStr].failed++;
            await redisSetJSON(redis, statsKey, stats);

            await pushEvent({
              ts: Date.now(),
              accountId: account.id,
              from: account.email,
              senderName: account.senderName || "",
              to,
              status: "failed",
              error: msg,
              note: "account_disabled_try_next_account"
            });

            console.log(`[AUTO] Account disabled due to failure: ${account.email} :: ${msg}`);
            errors.push({ email: to, error: msg });

            break; // Next account
          }

          if (looksLikePermanentRecipientFailure(err)) {
            queue.shift();
            failed++;
            stats.totalFailed++;
            stats.byAccount[idStr].failed++;
            await redisSetJSON(redis, statsKey, stats);

            await pushEvent({
              ts: Date.now(),
              accountId: account.id,
              from: account.email,
              senderName: account.senderName || "",
              to,
              status: "failed",
              error: msg,
              note: "permanent_recipient_failure_dropped"
            });

            errors.push({ email: to, error: msg });
            continue;
          }

          // Other errors -> retry in next tick
          queue.shift();
          carryOver.push(c);

          failed++;
          stats.totalFailed++;
          stats.byAccount[idStr].failed++;
          await redisSetJSON(redis, statsKey, stats);

          await pushEvent({
            ts: Date.now(),
            accountId: account.id,
            from: account.email,
            senderName: account.senderName || "",
            to,
            status: "failed",
            error: msg,
            note: "transient_moved_to_retry"
          });

          errors.push({ email: to, error: msg });
        }
      }

      results.push({ accountId: account.id, email: account.email, sent, failed, errors });
    }

    // Step 7: Handle retries for leftovers
    const leftovers = [...queue, ...carryOver];

    if (leftovers.length > 0) {
      let existingRetry = (await redisGetJSON(redis, retryKey)) || [];
      if (!Array.isArray(existingRetry)) existingRetry = [];

      const merged = [...leftovers, ...existingRetry];
      const MAX_RETRY = 10000;
      await redisSetJSON(redis, retryKey, merged.slice(0, MAX_RETRY));

      console.log(`[AUTO] Stored retry leftovers: ${leftovers.length} (retry total capped to ${MAX_RETRY})`);
    } else {
      console.log("[AUTO] No leftovers to retry.");
    }

    // Step 8: Completion check
    const retryNow = (await redisGetJSON(redis, retryKey)) || [];
    const retryCount = Array.isArray(retryNow) ? retryNow.length : 0;

    if (campaign.cursor >= total && retryCount === 0) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSetJSON(redis, campaignKey, campaign);
      await redis.set("auto:campaign:last", campaign.id);
      await redis.del("auto:campaign:active");

      await setLive({ state: "completed", currentEmail: null, currentAccountId: null, currentSenderName: null });
      await pushEvent({ ts: Date.now(), status: "campaign_completed", campaignId: campaign.id });

      console.log("[AUTO] Tick finished and campaign completed.");
    } else {
      await setLive({ state: "idle_waiting_next_tick", currentEmail: null, currentAccountId: null, currentSenderName: null });
      console.log(`[AUTO] Tick finished. Next tick will continue. cursor=${campaign.cursor}/${total}, retry=${retryCount}`);
    }

    console.log("[AUTO] Batch results:", JSON.stringify(results, null, 2));
    process.exit(0);
  } catch (e) {
    console.error("[AUTO] ERROR:", e);
    process.exit(1);
  } finally {
    try { redis.disconnect(); } catch {}
  }
})();
