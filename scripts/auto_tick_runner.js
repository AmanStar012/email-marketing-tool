/* scripts/auto-tick-runner.js
   GitHub Actions runner: sends auto campaign emails using Redis state.
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

function applyMerge(str, vars) {
  if (!str) return "";
  let out = String(str);
  for (const [k, v] of Object.entries(vars || {})) {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, v == null ? "" : String(v));
  }
  // remove any leftover {{...}}
  out = out.replace(/{{[^}]*}}/g, "");
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// very basic account-level failure detection
function looksLikeAccountLevelFailure(err) {
  const msg = (err && err.message ? err.message : "").toLowerCase();

  return (
    msg.includes("invalid login") ||
    msg.includes("username and password not accepted") ||
    msg.includes("authentication failed") ||
    msg.includes("auth") && msg.includes("failed") ||
    msg.includes("daily user sending quota exceeded") ||
    msg.includes("rate limit") ||
    msg.includes("too many login attempts") ||
    msg.includes("account disabled") ||
    msg.includes("bad credentials")
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

  // Gmail SMTP
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

// -------------------------
// Main
// -------------------------
(async function main() {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) throw new Error("Missing REDIS_URL env var (add it to GitHub Secrets)");

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true
  });

  try {
    const activeId = await redis.get("auto:campaign:active");
    if (!activeId) {
      console.log("[AUTO] No active campaign. Exiting.");
      process.exit(0);
    }

    const campaignKey = `auto:campaign:${activeId}`;
    const liveKey = `auto:campaign:${activeId}:live`;
    const statsKey = `auto:campaign:${activeId}:stats`;
    const eventsKey = `auto:campaign:${activeId}:events`;

    const campaign = await redisGetJSON(redis, campaignKey);
    if (!campaign) {
      console.log("[AUTO] Campaign missing; clearing active pointer.");
      await redis.del("auto:campaign:active");
      process.exit(0);
    }

    if (campaign.status !== "running") {
      console.log(`[AUTO] Campaign status is ${campaign.status}. Exiting.`);
      process.exit(0);
    }

    const accounts = loadAccountsConfig();
    const runtime = (await redisGetJSON(redis, "accounts:runtime")) || {};
    const connectedAccounts = accounts.filter((a) => runtime[String(a.id)]?.connected !== false);

    const emailsPerAcc = Number(campaign.emailsPerAccountPerHour || 40);
    const delayMs = Number(campaign.perEmailDelayMs || 1000);

    const total = campaign.contacts.length;
    let cursor = campaign.cursor || 0;

    // Initialize stats
    let stats = (await redisGetJSON(redis, statsKey)) || {
      campaignId: campaign.id,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    // Events list (cap last 500)
    let events = (await redisGetJSON(redis, eventsKey)) || [];
    if (!Array.isArray(events)) events = [];

    async function pushEvent(ev) {
      events.push(ev);
      if (events.length > 500) events = events.slice(-500);
      await redisSetJSON(redis, eventsKey, events);
    }

    async function setLive(payload) {
      await redisSetJSON(redis, liveKey, { ...payload, updatedAt: Date.now() });
    }

    // Completed?
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

    // Build hour plan: each connected account gets up to 40 contacts from remaining cursor
    const hourPlan = [];
    let tmpCursor = cursor;

    for (const acc of connectedAccounts) {
      const start = tmpCursor;
      const end = Math.min(tmpCursor + emailsPerAcc, total);
      if (start >= end) break;

      hourPlan.push({ account: acc, contacts: campaign.contacts.slice(start, end) });
      tmpCursor = end;
    }

    // Save cursor early so next tick doesn't resend same contacts
    campaign.cursor = tmpCursor;
    campaign.updatedAt = Date.now();
    await redisSetJSON(redis, campaignKey, campaign);

    console.log(`[AUTO] Tick started. Cursor now reserved: ${cursor} -> ${tmpCursor} (total=${total})`);
    console.log(`[AUTO] Accounts this tick: ${hourPlan.length}, per account up to ${emailsPerAcc}`);

    // We do small concurrency to avoid slamming Gmail
    const CONCURRENCY = 3;
    let idx = 0;

    async function sendBatchForAccount(account, contactsSlice) {
      const idStr = String(account.id);

      if (!stats.byAccount[idStr]) {
        stats.byAccount[idStr] = {
          email: account.email,
          senderName: account.senderName || "",
          sent: 0,
          failed: 0,
          lastSentAt: 0
        };
      }

      let transporter;
      try {
        transporter = createTransporter(account);
      } catch (e) {
        // disable if missing pass
        runtime[idStr] = runtime[idStr] || {};
        runtime[idStr].connected = false;
        runtime[idStr].lastError = e.message;
        await redisSetJSON(redis, "accounts:runtime", runtime);

        console.log(`[AUTO] Account ${account.email} disabled: ${e.message}`);
        return { accountId: account.id, email: account.email, sent: 0, failed: contactsSlice.length, errors: [{ error: e.message }] };
      }

      let sent = 0;
      let failed = 0;
      const errors = [];

      for (const c of contactsSlice) {
        const to =
          c.email || c.Email || c.EMAIL || c["Email Address"] || c.email_address || c.mail || c.Mail || "";

        if (!to) {
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

          const vars = {
            brandName: campaign.brandName,
            senderName: account.senderName || "",
            ...c
          };

          const subj = applyMerge(campaign.template.subject, vars);
          const bodyText = applyMerge(campaign.template.content, vars);
          const html = convertTextToHTML(bodyText);

          await transporter.sendMail({
            from: `${account.senderName || ""} <${account.email}>`,
            to,
            subject: subj,
            html
          });

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
            error: err.message
          });

          errors.push({ email: to, error: err.message });

          if (looksLikeAccountLevelFailure(err)) {
            runtime[idStr] = runtime[idStr] || {};
            runtime[idStr].connected = false;
            runtime[idStr].lastError = err.message;
            await redisSetJSON(redis, "accounts:runtime", runtime);

            console.log(`[AUTO] Account ${account.email} disabled due to failure: ${err.message}`);
            break;
          }
        }
      }

      return { accountId: account.id, email: account.email, sent, failed, errors };
    }

    const results = [];
    const workers = new Array(Math.min(CONCURRENCY, hourPlan.length)).fill(0).map(async () => {
      while (idx < hourPlan.length) {
        const my = idx++;
        const job = hourPlan[my];
        const r = await sendBatchForAccount(job.account, job.contacts);
        results.push(r);
      }
    });

    await Promise.all(workers);

    // mark completed if cursor reached end
    if (campaign.cursor >= total) {
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
      console.log("[AUTO] Tick finished. Waiting for next hour.");
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
