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

const EMAILS_PER_ACCOUNT = 40;
const PER_EMAIL_DELAY_MS = 1000;
const MAX_RETRY = 1;

/**
 * Picks a random value.
 * Supports string OR array (backend-safe, backward-compatible)
 */
function pickRandom(value) {
  if (Array.isArray(value)) {
    return value[Math.floor(Math.random() * value.length)];
  }
  return value;
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

    const campaign = await redisGet(campaignKey);
    if (!campaign || campaign.status !== "running") {
      console.log("ℹ️ Campaign not running");
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

    // Create jobs per account
    const jobs = connectedAccounts.map((acc) => ({
      account: acc,
      queue: []
    }));

    // 1️⃣ Fill retry queue first
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && retryQueue.length > 0) {
        job.queue.push(retryQueue.shift());
      }
    }

    // 2️⃣ Fill new contacts
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && cursor < total) {
        job.queue.push({ contact: contacts[cursor], retry: 0 });
        cursor++;
      }
    }

    // Save cursor progress
    campaign.cursor = cursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);
    await redisSet(retryKey, retryQueue);

    const stats = (await redisGet(statsKey)) || {
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    // 3️⃣ Process each account
    await Promise.all(
      jobs.map(async ({ account, queue }) => {
        if (!queue.length) return;

        const accId = String(account.id);
        stats.byAccount[accId] ||= {
          email: account.email,
          senderName: account.senderName,
          sent: 0,
          failed: 0,
          lastSentAt: null
        };

        let transporter = createTransporter(account);

        for (const item of queue) {
          const { contact, retry } = item;
          const to = contact.email;
          if (!to) continue;

          try {
            // 🔥 RANDOM SELECTION (KEY CHANGE)
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

            // Account-level failure → disable account
            if (looksLikeAccountLevelFailure(err)) {
              runtime[accId] = { connected: false, lastError: err.message };
              await redisSet("accounts:runtime", runtime);
              console.error(`❌ Account disabled: ${account.email}`);
              break;
            }

            // Retry logic
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

    // Save retry + stats
    await redisSet(retryKey, retryQueue);
    await redisSet(statsKey, stats);

    // 4️⃣ Finish campaign if done
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

      console.log("✅ Campaign completed");
    } else {
      console.log("⏳ Tick complete, waiting for next run");
    }

    process.exit(0);
  } catch (err) {
    console.error("🔥 Auto Tick Runner crashed:", err);
    process.exit(1);
  }
})();
