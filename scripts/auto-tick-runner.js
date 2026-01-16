const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const Redis = require("ioredis");

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
  return out.replace(/{{[^}]*}}/g, "");
}

function convertTextToHTML(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r?\n/g, "<br>")
    .replace(/  +/g, (s) => "&nbsp;".repeat(s.length))
    .replace(
      /^/,
      '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height:1.6">'
    )
    .replace(/$/, "</div>");
}

function looksLikeAccountLevelFailure(err) {
  const m = (err?.message || "").toLowerCase();
  return (
    m.includes("auth") ||
    m.includes("rate limit") ||
    m.includes("daily user sending limit") ||
    m.includes("bad credentials") ||
    m.includes("account disabled")
  );
}

function looksLikePermanentRecipientFailure(err) {
  const m = (err?.message || "").toLowerCase();
  return (
    m.includes("5.1.1") ||
    m.includes("no such user") ||
    m.includes("invalid recipient") ||
    m.includes("domain not found")
  );
}

function loadAccountsConfig() {
  const p = path.join(process.cwd(), "accounts.json");
  if (!fs.existsSync(p)) throw new Error("accounts.json missing");

  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(a)) throw new Error("accounts.json must be array");

  return a.map((x) => ({
    ...x,
    pass: process.env[`PASS_${x.id}`] || ""
  }));
}

function createTransporter(account) {
  if (!account.email || !account.pass) {
    throw new Error("Missing email/pass");
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: account.email, pass: account.pass }
  });
}

async function redisGetJSON(redis, key) {
  const v = await redis.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

async function redisSetJSON(redis, key, val) {
  await redis.set(key, JSON.stringify(val));
}

function extractTo(c) {
  return (
    c.email ||
    c.Email ||
    c["Email Address"] ||
    c.mail ||
    ""
  );
}

(async function main() {
  const redis = new Redis(process.env.REDIS_URL);
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL missing");

  try {
    const activeId = await redis.get("auto:campaign:active");
    if (!activeId) return process.exit(0);

    const campaignKey = `auto:campaign:${activeId}`;
    const statsKey = `${campaignKey}:stats`;
    const liveKey = `${campaignKey}:live`;
    const eventsKey = `${campaignKey}:events`;
    const retryKey = `${campaignKey}:retry`;

    const campaign = await redisGetJSON(redis, campaignKey);
    if (!campaign || campaign.status !== "running") return process.exit(0);

    const accounts = loadAccountsConfig();
    const runtime = (await redisGetJSON(redis, "accounts:runtime")) || {};
    const connected = accounts.filter(a => runtime[String(a.id)]?.connected !== false);

    if (connected.length === 0) return process.exit(0);

    const emailsPerAcc = campaign.emailsPerAccountPerHour || 40;
    const delayMs = campaign.perEmailDelayMs || 1000;

    let stats = (await redisGetJSON(redis, statsKey)) || {
      campaignId: campaign.id,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    let events = (await redisGetJSON(redis, eventsKey)) || [];
    const pushEvent = async (e) => {
      events.push(e);
      if (events.length > 500) events = events.slice(-500);
      await redisSetJSON(redis, eventsKey, events);
    };

    const retryQueue = (await redisGetJSON(redis, retryKey)) || [];
    const total = campaign.contacts.length;
    const cursor = campaign.cursor || 0;

    const capacity = connected.length * emailsPerAcc;
    const fromRetry = retryQueue.splice(0, capacity);
    const fromMain = campaign.contacts.slice(cursor, cursor + (capacity - fromRetry.length));

    campaign.cursor = cursor + fromMain.length;
    await redisSetJSON(redis, campaignKey, campaign);
    await redisSetJSON(redis, retryKey, retryQueue);

    const queue = [...fromRetry, ...fromMain];
    const carryOver = [];

    await Promise.all(
      connected.map(async (account) => {
        const id = String(account.id);
        stats.byAccount[id] ||= { email: account.email, sent: 0, failed: 0 };

        let transporter;
        try {
          transporter = createTransporter(account);
        } catch (e) {
          runtime[id] = { connected: false, lastError: e.message };
          await redisSetJSON(redis, "accounts:runtime", runtime);
          return;
        }

        for (let i = 0; i < emailsPerAcc; i++) {
          const c = queue.shift();
          if (!c) break;

          const to = extractTo(c);
          if (!to) {
            stats.totalFailed++;
            stats.byAccount[id].failed++;
            continue;
          }

          try {
            await redisSetJSON(redis, liveKey, {
              state: "sending",
              currentEmail: account.email,
              currentAccountId: account.id,
              updatedAt: Date.now()
            });

            const vars = { ...c, brandName: campaign.brandName, senderName: account.senderName };
            await transporter.sendMail({
              from: `${account.senderName || ""} <${account.email}>`,
              to,
              subject: applyMerge(campaign.template.subject, vars),
              html: convertTextToHTML(applyMerge(campaign.template.content, vars))
            });

            stats.totalSent++;
            stats.byAccount[id].sent++;
            await pushEvent({ ts: Date.now(), status: "sent", from: account.email, to });

            await sleep(delayMs);
          } catch (err) {
            stats.totalFailed++;
            stats.byAccount[id].failed++;

            if (looksLikeAccountLevelFailure(err)) {
              runtime[id] = { connected: false, lastError: err.message };
              await redisSetJSON(redis, "accounts:runtime", runtime);
              carryOver.push(c);
              break;
            }

            if (!looksLikePermanentRecipientFailure(err)) {
              carryOver.push(c);
            }

            await pushEvent({
              ts: Date.now(),
              status: "failed",
              from: account.email,
              to,
              error: err.message
            });
          }
        }
      })
    );

    await redisSetJSON(redis, statsKey, stats);
    if (carryOver.length) {
      const r = (await redisGetJSON(redis, retryKey)) || [];
      await redisSetJSON(redis, retryKey, [...carryOver, ...r]);
    }

    await redisSetJSON(redis, liveKey, {
      state: "idle_waiting_next_tick",
      updatedAt: Date.now()
    });

    process.exit(0);
  } catch (e) {
    console.error("[AUTO] ERROR", e);
    process.exit(1);
  } finally {
    redis.disconnect();
  }
})();
