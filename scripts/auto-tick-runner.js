const {
  sleep,
  convertTextToHTML,
  createTransporter,
  looksLikeAccountLevelFailure,
  applyMerge,
  loadAccountsConfig,
  redisGet,
  redisSet,
  redisDel
} = require("../api/_shared");

const EMAILS_PER_ACCOUNT = 30;           
const PER_EMAIL_DELAY_MS = 60 * 1000;   
const ONE_HOUR = 60 * 60 * 1000;        
const DAILY_LIMIT = 300;               
const MAX_RETRY = 1;

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

(async function runAutoTick() {
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

    const campaign = await redisGet(campaignKey);
    if (!campaign || campaign.status !== "running") {
      console.log("ℹ️ Campaign not running");
      process.exit(0);
    }

    /**
     * ⏱️ 1-HOUR GAP BETWEEN BATCHES
     */
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
          const to = contact.email;
          if (!to) continue;

          try {
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

            await transporter.sendMail({
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

            const ev = (await redisGet(eventsKey)) || [];
            ev.push({
              ts: Date.now(),
              status: "sent",
              from: account.email,
              to,
              subject
            });
            await redisSet(eventsKey, ev.slice(-300));

            await sleep(PER_EMAIL_DELAY_MS);
          } catch (err) {
            stats.totalFailed++;
            stats.byAccount[accId].failed++;

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
              error: err.message
            });
            await redisSet(eventsKey, ev.slice(-300));
          }
        }
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

    process.exit(0);
  } catch (err) {
    console.error("🔥 Auto Tick Runner crashed:", err);
    process.exit(1);
  }
})();
