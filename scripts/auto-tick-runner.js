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
} = require("../api/_shared"); // IMPORTANT PATH

const EMAILS_PER_ACCOUNT = 40;
const PER_EMAIL_DELAY_MS = 1000;
const MAX_RETRY = 1;

(async function runAutoTick() {
  try {
    console.log("⏱️ Auto Tick Runner started");

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
      a => runtime[String(a.id)]?.connected !== false
    );

    if (connectedAccounts.length === 0) {
      console.log("❌ No connected accounts");
      process.exit(0);
    }

    // Load retry queue first
    let retryQueue = (await redisGet(retryKey)) || [];
    let cursor = campaign.cursor || 0;
    const contacts = campaign.contacts;
    const total = contacts.length;

    // Prepare per-account job queues
    const jobs = connectedAccounts.map(acc => ({
      account: acc,
      queue: []
    }));

    // 1️⃣ Fill from retry queue FIRST
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && retryQueue.length > 0) {
        job.queue.push(retryQueue.shift());
      }
    }

    // 2️⃣ Fill from main contacts list
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && cursor < total) {
        job.queue.push({
          contact: contacts[cursor],
          retry: 0
        });
        cursor++;
      }
    }

    // Save updated retry queue + cursor EARLY (safe now)
    campaign.cursor = cursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);
    await redisSet(retryKey, retryQueue);

    // Init stats
    const stats = (await redisGet(statsKey)) || {
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    // 🔁 Send in PARALLEL
    await Promise.all(
      jobs.map(async ({ account, queue }) => {
        if (queue.length === 0) return;

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
            const vars = {
              ...contact,
              brandName: campaign.brandName,
              senderName: account.senderName
            };

            const subject = applyMerge(campaign.template.subject, vars);
            const body = applyMerge(campaign.template.content, vars);
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

            await redisSet(eventsKey, [
              ...(await redisGet(eventsKey) || []),
              { ts: Date.now(), status: "sent", from: account.email, to }
            ]);

            await sleep(PER_EMAIL_DELAY_MS);

          } catch (err) {
            stats.totalFailed++;
            stats.byAccount[accId].failed++;

            // Account-level failure → DISCONNECT
            if (looksLikeAccountLevelFailure(err)) {
              runtime[accId] = runtime[accId] || {};
              runtime[accId].connected = false;
              runtime[accId].lastError = err.message;
              await redisSet("accounts:runtime", runtime);
              console.error(`❌ Account disabled: ${account.email}`);
              break;
            }

            // Retry ONLY ONCE
            if (retry < MAX_RETRY) {
              retryQueue.push({ contact, retry: retry + 1 });
            }

            await redisSet(eventsKey, [
              ...(await redisGet(eventsKey) || []),
              {
                ts: Date.now(),
                status: "failed",
                from: account.email,
                to,
                error: err.message
              }
            ]);
          }
        }
      })
    );

    // Save retry queue + stats
    await redisSet(retryKey, retryQueue);
    await redisSet(statsKey, stats);

    // Campaign completion check
    if (campaign.cursor >= total && retryQueue.length === 0) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");

      await redisSet(eventsKey, [
        ...(await redisGet(eventsKey) || []),
        { ts: Date.now(), status: "campaign_completed", campaignId: campaign.id }
      ]);

      console.log("🏁 Campaign completed");
    } else {
      console.log("⏳ Tick complete, waiting for next run");
    }

    process.exit(0);

  } catch (err) {
    console.error("🔥 Auto Tick Runner crashed:", err);
    process.exit(1);
  }
})();
