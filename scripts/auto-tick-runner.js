const {
  sleep,
  convertTextToHTML,
  createTransporter,
  looksLikeAccountLevelFailure,
  applyMerge,
  loadAccountsConfig,
  redisGet,
  redisSet,
  redisSetNx,
  redisDel
} = require("../api/_shared");

const EMAILS_PER_ACCOUNT = 30;           
const PER_EMAIL_DELAY_MIN_MS = 30 * 1000;
const PER_EMAIL_DELAY_MAX_MS = 90 * 1000;
const ONE_HOUR = 60 * 60 * 1000;        
const DAILY_LIMIT = 300;               
const MAX_RETRY = 1;
const TICK_LOCK_TTL_MS = 50 * 60 * 1000;

/**
 * Picks random value (array or string)
 */
function pickRandom(value) {
  if (Array.isArray(value)) {
    return value[Math.floor(Math.random() * value.length)];
  }
  return value;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function indiaDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function campaignSlug(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "campaign";
}

function senderKey(email) {
  return encodeURIComponent(String(email || "").trim().toLowerCase());
}

function getIndiaHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false
  }).formatToParts(new Date());

  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? Number(hourPart.value) : null;
}

function isWithinIndiaSendWindow() {
  const hour = getIndiaHour();
  if (hour == null || Number.isNaN(hour)) return false;
  // 9:00 <= time < 20:00 (9 AM to 8 PM)
  return hour >= 9 && hour < 20;
}

(async function runAutoTick() {
  let lockKey = null;
  try {
    console.log("🚀 Auto Tick Runner started");

    const activeId = await redisGet("auto:campaign:active");
    if (!activeId) {
      console.log("ℹ️ No active campaign");
      process.exit(0);
    }

    const campaignKey = `auto:campaign:${activeId}`;
    const retryKey = `auto:campaign:${activeId}:retry`;
    const statsKey = `auto:campaign:${activeId}:stats`;
    const eventsKey = `auto:campaign:${activeId}:events`;
    const lastSendKey = `auto:campaign:${activeId}:lastSendAt`;
    const liveKey = `auto:campaign:${activeId}:live`;

    const campaign = await redisGet(campaignKey);
    const campaignName = String(campaign?.campaignName || campaign?.id || "campaign");
    const campaignKeySlug = campaignSlug(campaignName);
    if (!campaign || campaign.status !== "running") {
      console.log("ℹ️ Campaign not running");
      process.exit(0);
    }

    /**
     * ⏱️ 1-HOUR GAP BETWEEN BATCHES
     */
    if (!isWithinIndiaSendWindow()) {
      console.log("⏰ Outside India send window (09:00-20:00 IST)");
      process.exit(0);
    }

    const lastSendAt = await redisGet(lastSendKey);
    const now = Date.now();
    if (lastSendAt && now - Number(lastSendAt) < ONE_HOUR) {
      console.log("⏳ Batch cooldown active");
      process.exit(0);
    }

    const runtime = (await redisGet("accounts:runtime")) || {};
    const accounts = loadAccountsConfig();

    const connectedAccounts = accounts.filter(
      (a) => runtime[String(a.id)]?.connected !== false
    );

    if (connectedAccounts.length === 0) {
      console.log("❌ No connected accounts");
      process.exit(0);
    }

    lockKey = "auto:tick:lock";
    const lockAcquired = await redisSetNx(lockKey, Date.now(), TICK_LOCK_TTL_MS);
    if (!lockAcquired) {
      console.log("Another auto tick is running, skipping this run");
      process.exit(0);
    }

    let retryQueue = (await redisGet(retryKey)) || [];
    let cursor = campaign.cursor || 0;
    const contacts = campaign.contacts;
    const total = contacts.length;

    /**
     * Create jobs
     */
    const jobs = connectedAccounts.map(acc => ({
      account: acc,
      queue: []
    }));

    /**
     * Retry queue first
     */
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && retryQueue.length > 0) {
        job.queue.push(retryQueue.shift());
      }
    }

    /**
     * New contacts
     */
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && cursor < total) {
        job.queue.push({ contact: contacts[cursor], retry: 0 });
        cursor++;
      }
    }

    /**
     * Save cursor
     */
    campaign.cursor = cursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);
    await redisSet(retryKey, retryQueue);

    const stats = (await redisGet(statsKey)) || {
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    /**
     * Process accounts
     */
    await Promise.all(
      jobs.map(async ({ account, queue }) => {
        if (!queue.length) return;

        const accId = String(account.id);
        const today = todayKey();
        const dailyKey = `auto:account:${accId}:dailyCount:${today}`;
        let dailyCount = Number(await redisGet(dailyKey)) || 0;

        // 🚫 DAILY LIMIT CHECK
        if (dailyCount >= DAILY_LIMIT) {
          console.log(`🚫 Daily limit reached for ${account.email}`);
          return;
        }

        stats.byAccount[accId] ||= {
          email: account.email,
          senderName: account.senderName,
          sent: 0,
          failed: 0,
          lastSentAt: null
        };

        const transporter = createTransporter(account);

        for (const item of queue) {
          if (dailyCount >= DAILY_LIMIT) {
            console.log(`🚫 Daily limit reached mid-batch for ${account.email}`);
            break;
          }

          const { contact, retry } = item;
          const to = String(contact.email || "").trim();
          if (!to) continue;

          try {
            await redisSet(liveKey, {
              currentAccountId: accId,
              currentEmail: to,
              currentSenderName: account.senderName || "",
              state: "sending",
              updatedAt: Date.now()
            });

            const randomBrand = pickRandom(campaign.brandName);
            const randomSubject = pickRandom(campaign.template.subject);
            const randomBody = pickRandom(campaign.template.content);

            const vars = {
              ...contact,
              brandName: randomBrand,
              senderName: account.senderName
            };

            const subject = applyMerge(randomSubject, vars);
            const body = applyMerge(randomBody, vars);
            const html = convertTextToHTML(body);

            const result = await transporter.sendMail({
              from: `"${account.senderName}" <${account.email}>`,
              to,
              subject,
              html
            });

            dailyCount++;
            await redisSet(dailyKey, dailyCount);

            stats.totalSent++;
            stats.byAccount[accId].sent++;
            stats.byAccount[accId].lastSentAt = Date.now();

            if (retry > 0) {
              if (stats.totalFailed > 0) stats.totalFailed--;
              if (stats.byAccount[accId].failed > 0) stats.byAccount[accId].failed--;
            }
            await redisSet(statsKey, stats);

            const reportDate = indiaDateKey();
            const reportSender = senderKey(account.email);
            const reportKey = `report:campaign:${campaignKeySlug}:daily:${reportDate}:sender:${reportSender}`;
            const currentSenderCount = Number(await redisGet(reportKey)) || 0;
            await redisSet(reportKey, currentSenderCount + 1);
            await redisSet(`report:campaign:${campaignKeySlug}:name`, campaignName);

            const ev = (await redisGet(eventsKey)) || [];
            ev.push({
              ts: Date.now(),
              status: "sent",
              from: account.email,
              to,
              subject,
              messageId: result && result.messageId,
              accepted: result && result.accepted,
              rejected: result && result.rejected,
              response: result && result.response
            });
            await redisSet(eventsKey, ev.slice(-300));

            const delayMs = randomInt(PER_EMAIL_DELAY_MIN_MS, PER_EMAIL_DELAY_MAX_MS);
            await sleep(delayMs);
          } catch (err) {
            stats.totalFailed++;
            stats.byAccount[accId].failed++;
            await redisSet(statsKey, stats);

            if (looksLikeAccountLevelFailure(err)) {
              runtime[accId] = { connected: false, lastError: err.message };
              await redisSet("accounts:runtime", runtime);
              break;
            }

            if (retry < MAX_RETRY) {
              retryQueue.push({ contact, retry: retry + 1 });
            }

            const ev = (await redisGet(eventsKey)) || [];
            ev.push({
              ts: Date.now(),
              status: "failed",
              from: account.email,
              to,
              error: err.message,
              code: err.code,
              response: err.response
            });
            await redisSet(eventsKey, ev.slice(-300));
          }
        }

        await redisSet(liveKey, {
          currentAccountId: accId,
          currentEmail: null,
          currentSenderName: account.senderName || "",
          state: "running",
          updatedAt: Date.now()
        });
      })
    );

    await redisSet(retryKey, retryQueue);
    await redisSet(statsKey, stats);

    // ✅ batch timestamp
    await redisSet(lastSendKey, Date.now());

    /**
     * Finish campaign
     */
    if (campaign.cursor >= total && retryQueue.length === 0) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");

      const ev = (await redisGet(eventsKey)) || [];
      ev.push({
        ts: Date.now(),
        status: "campaign_completed",
        campaignId: campaign.id
      });
      await redisSet(eventsKey, ev.slice(-300));
    }

    if (lockKey) await redisDel(lockKey);
    process.exit(0);
  } catch (err) {
    console.error("🔥 Auto Tick Runner crashed:", err);
    try {
      if (lockKey) await redisDel(lockKey);
    } catch (_) {
      // best-effort unlock
    }
    process.exit(1);
  }
})();
