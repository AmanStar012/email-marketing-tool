const {
  cors,
  sleep,
  convertTextToHTML,
  createTransporter,
  looksLikeAccountLevelFailure,
  applyMerge,
  loadAccountsConfig,
  redisGet,
  redisSet,
  redisDel
} = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const activeId = await redisGet("auto:campaign:active");
    if (!activeId)
      return res.status(200).json({ success: true, message: "No active campaign" });

    const campaignKey = `auto:campaign:${activeId}`;
    const liveKey = `auto:campaign:${activeId}:live`;
    const statsKey = `auto:campaign:${activeId}:stats`;
    const eventsKey = `auto:campaign:${activeId}:events`;

    const campaign = await redisGet(campaignKey);
    if (!campaign || campaign.status !== "running") {
      return res.status(200).json({ success: true, message: "Campaign not running" });
    }

    const accounts = loadAccountsConfig();
    const runtime = (await redisGet("accounts:runtime")) || {};

    const connectedAccounts = accounts.filter(
      (a) => runtime[String(a.id)]?.connected !== false
    );

    if (connectedAccounts.length === 0) {
      await redisSet(liveKey, {
        state: "no_connected_accounts",
        updatedAt: Date.now()
      });
      return res.status(200).json({ success: true, message: "No connected accounts" });
    }

    const emailsPerAccount = Number(campaign.emailsPerAccountPerHour || 40);
    const delayMs = Number(campaign.perEmailDelayMs || 1000);

    const retryQueueKey = `auto:campaign:${activeId}:retry`;
    const retryQueue = (await redisGet(retryQueueKey)) || [];

    let cursor = campaign.cursor || 0;
    const totalContacts = campaign.contacts.length;

    // 🔁 Build work pool (retry first)
    const workPool = [...retryQueue];
    const freshContacts = campaign.contacts.slice(cursor);
    workPool.push(...freshContacts);

    const assignedMap = new Map();
    let poolIndex = 0;

    // 📦 Assign emails per account
    for (const acc of connectedAccounts) {
      assignedMap.set(acc.id, []);
      for (let i = 0; i < emailsPerAccount; i++) {
        if (poolIndex >= workPool.length) break;
        assignedMap.get(acc.id).push(workPool[poolIndex]);
        poolIndex++;
      }
    }

    const assignedCount = poolIndex;
    campaign.cursor = cursor + Math.max(0, assignedCount - retryQueue.length);
    campaign.updatedAt = Date.now();

    // Clear retry queue now (failed will re-add)
    await redisSet(retryQueueKey, []);
    await redisSet(campaignKey, campaign);

    // 🧵 Parallel send per account
    const sendForAccount = async (account, contacts) => {
      const accId = String(account.id);
      const transporter = createTransporter(account);
      let sent = 0;
      let failed = 0;
      const failedContacts = [];

      for (const c of contacts) {
        const to = c.email || c.Email || c["Email Address"];
        if (!to) {
          failed++;
          continue;
        }

        try {
          const vars = {
            ...c,
            brandName: campaign.brandName,
            senderName: account.senderName
          };

          const subject = applyMerge(campaign.template.subject, vars);
          const bodyText = applyMerge(campaign.template.content, vars);
          const html = convertTextToHTML(bodyText);

          await transporter.sendMail({
            from: `${account.senderName || ""} <${account.email}>`,
            to,
            subject,
            html
          });

          sent++;

          await pushEvent(eventsKey, {
            ts: Date.now(),
            status: "sent",
            from: account.email,
            to
          });

          await sleep(delayMs);
        } catch (err) {
          failed++;
          failedContacts.push(c);

          await pushEvent(eventsKey, {
            ts: Date.now(),
            status: "failed",
            from: account.email,
            to,
            error: err.message
          });

          if (looksLikeAccountLevelFailure(err)) {
            runtime[accId] = runtime[accId] || {};
            runtime[accId].connected = false;
            runtime[accId].lastError = err.message;
            await redisSet("accounts:runtime", runtime);
            break;
          }
        }
      }

      return { accountId: account.id, email: account.email, sent, failed, failedContacts };
    };

    const results = await Promise.all(
      connectedAccounts.map((acc) =>
        sendForAccount(acc, assignedMap.get(acc.id) || [])
      )
    );

    // 🔁 Requeue failed emails
    const requeue = results.flatMap((r) => r.failedContacts || []);
    if (requeue.length) {
      await redisSet(retryQueueKey, requeue);
    }

    // 🧮 Stats
    const stats = (await redisGet(statsKey)) || { totalSent: 0, totalFailed: 0, byAccount: {} };

    for (const r of results) {
      stats.totalSent += r.sent;
      stats.totalFailed += r.failed;
      stats.byAccount[r.accountId] = stats.byAccount[r.accountId] || {
        email: r.email,
        sent: 0,
        failed: 0,
        lastSentAt: null
      };
      stats.byAccount[r.accountId].sent += r.sent;
      stats.byAccount[r.accountId].failed += r.failed;
      stats.byAccount[r.accountId].lastSentAt = Date.now();
    }

    await redisSet(statsKey, stats);

    // 🏁 Completion check
    if (
      campaign.cursor >= totalContacts &&
      (await redisGet(retryQueueKey)).length === 0
    ) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");

      await redisSet(liveKey, {
        state: "completed",
        updatedAt: Date.now()
      });

      await pushEvent(eventsKey, {
        ts: Date.now(),
        status: "campaign_completed",
        campaignId: campaign.id
      });
    } else {
      await redisSet(liveKey, {
        state: "idle_waiting_next_tick",
        updatedAt: Date.now()
      });
    }

    return res.status(200).json({
      success: true,
      message: "Auto tick completed",
      assigned: assignedCount,
      retryQueued: requeue.length
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};

// helpers
async function pushEvent(key, ev) {
  let events = (await redisGet(key)) || [];
  if (!Array.isArray(events)) events = [];
  events.push(ev);
  if (events.length > 500) events = events.slice(-500);
  await redisSet(key, events);
}
