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

    const jobs = connectedAccounts.map((acc) => ({
      account: acc,
      queue: []
    }));

    // 1️⃣ Retry first
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && retryQueue.length > 0) {
        job.queue.push(retryQueue.shift());
      }
    }

    // 2️⃣ New contacts
    for (const job of jobs) {
      while (job.queue.length < EMAILS_PER_ACCOUNT && cursor < total) {
        job.queue.push({ contact: contacts[cursor], retry: 0 });
        cursor++;
      }
    }

    campaign.cursor = cursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);
    await redisSet(retryKey, retryQueue);

    const stats = (await redisGet(statsKey)) || {
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

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

            const ev = (await redisGet(eventsKey)) || [];
            ev.push({ ts: Date.now(), status: "sent", from: account.email, to });
            await redisSet(eventsKey, ev.slice(-300));

            await sleep(PER_EMAIL_DELAY_MS);

          } catch (err) {
            stats.totalFailed++;
            stats.byAccount[accId].failed++;

            if (looksLikeAccountLevelFailure(err)) {
              runtime[accId] = { connected: false, lastError: err.message };
              await redisSet("accounts:runtime", runtime);
              console.error(`❌ Account disabled: ${account.email}`);
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

    if (campaign.cursor >= total && retryQueue.length === 0) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");

      const ev = (await redisGet(eventsKey)) || [];
      ev.push({ ts: Date.now(), status: "campaign_completed", campaignId: campaign.id });
      await redisSet(eventsKey, ev.slice(-300));

      console.log("🏁 Campaign completed");
    } else {
      console.log("⏳ Tick complete, waiting next run");
    }

    process.exit(0);

  } catch (err) {
    console.error("🔥 Auto Tick Runner crashed:", err);
    process.exit(1);
  }
})();
