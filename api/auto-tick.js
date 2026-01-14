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
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    // Secret protection (GitHub Actions / private calls)
    const secret = req.headers["x-auto-secret"];
    const expected = process.env.AUTO_SECRET;
    if (!expected) return res.status(500).json({ success: false, error: "Missing AUTO_SECRET env var" });
    if (!secret || secret !== expected) {
      return res.status(401).json({ success: false, error: "Unauthorized (bad auto secret)" });
    }

    const activeId = await redisGet("auto:campaign:active");
    if (!activeId) return res.status(200).json({ success: true, message: "No active campaign" });

    const campaignKey = `auto:campaign:${activeId}`;
    const liveKey = `auto:campaign:${activeId}:live`;
    const statsKey = `auto:campaign:${activeId}:stats`;
    const eventsKey = `auto:campaign:${activeId}:events`;

    const campaign = await redisGet(campaignKey);
    if (!campaign) {
      await redisDel("auto:campaign:active");
      return res.status(200).json({ success: true, message: "Campaign missing; cleared active pointer" });
    }

    if (campaign.status !== "running") {
      return res.status(200).json({ success: true, message: `Campaign status: ${campaign.status}` });
    }

    const accounts = loadAccountsConfig();
    const runtime = (await redisGet("accounts:runtime")) || {};

    const connectedAccounts = accounts.filter((a) => runtime[String(a.id)]?.connected !== false);
    const emailsPerAcc = Number(campaign.emailsPerAccountPerHour || 40);
    const delayMs = Number(campaign.perEmailDelayMs || 1000);

    const total = campaign.contacts.length;
    let cursor = campaign.cursor || 0;

    // ensure stats exists
    let stats = (await redisGet(statsKey)) || {
      campaignId: campaign.id,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    };

    // ensure events exists
    let events = (await redisGet(eventsKey)) || [];
    if (!Array.isArray(events)) events = [];

    const pushEvent = async (ev) => {
      events.push(ev);
      // cap to last 300 events
      if (events.length > 300) events = events.slice(-300);
      await redisSet(eventsKey, events);
    };

    const setLive = async (payload) => {
      await redisSet(liveKey, { ...payload, updatedAt: Date.now() });
    };

    // Completed case
    if (cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisSet("auto:campaign:last", campaign.id);
      await redisDel("auto:campaign:active");
      await setLive({ currentAccountId: null, currentEmail: null, currentSenderName: null, state: "completed" });

      return res.status(200).json({ success: true, message: "Completed (no contacts left)" });
    }

    if (connectedAccounts.length === 0) {
      await setLive({ currentAccountId: null, currentEmail: null, currentSenderName: null, state: "idle_no_accounts" });
      return res.status(200).json({ success: true, message: "No connected accounts; nothing sent" });
    }

    // Concurrency control (avoid 34 SMTP at once)
    const CONCURRENCY = 5;

    // Build this hour plan (each account gets up to emailsPerAcc from remaining cursor)
    const hourPlan = [];
    let tmpCursor = cursor;

    for (const acc of connectedAccounts) {
      const start = tmpCursor;
      const end = Math.min(tmpCursor + emailsPerAcc, total);
      if (start >= end) break;

      hourPlan.push({
        account: acc,
        contacts: campaign.contacts.slice(start, end)
      });

      tmpCursor = end;
    }

    // Save cursor early (so we don't resend next tick)
    campaign.cursor = tmpCursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);

    const sendBatchForAccount = async (account, contactsSlice) => {
      const accountIdStr = String(account.id);

      if (!stats.byAccount[accountIdStr]) {
        stats.byAccount[accountIdStr] = {
          email: account.email,
          senderName: account.senderName || "",
          sent: 0,
          failed: 0,
          lastSentAt: 0
        };
      }

      let transporter = createTransporter(account);

      let sent = 0;
      let failed = 0;
      const errors = [];

      for (const c of contactsSlice) {
        const to =
          c.email || c.Email || c.EMAIL || c["Email Address"] || c.email_address || c.mail || c.Mail || "";

        if (!to) {
          failed++;
          stats.totalFailed++;
          stats.byAccount[accountIdStr].failed++;
          await redisSet(statsKey, stats);

          const ev = {
            ts: Date.now(),
            accountId: account.id,
            from: account.email,
            senderName: account.senderName || "",
            to: "",
            status: "failed",
            error: "Missing email in contact row"
          };
          await pushEvent(ev);

          errors.push({ email: "missing", error: "Missing email in contact row" });
          continue;
        }

        try {
          // LIVE UPDATE: which email currently sending from
          await setLive({
            currentAccountId: account.id,
            currentEmail: account.email,
            currentSenderName: account.senderName || "",
            state: "sending"
          });

          const vars = {
            brandName: campaign.brandName,
            senderName: account.senderName,
            ...c
          };

          const subj = applyMerge(campaign.template.subject, vars);
          const bodyText = applyMerge(campaign.template.content, vars);
          const html = convertTextToHTML(bodyText);

          await transporter.sendMail({
            from: `${account.senderName} <${account.email}>`,
            to,
            subject: subj,
            html
          });

          sent++;
          stats.totalSent++;
          stats.byAccount[accountIdStr].sent++;
          stats.byAccount[accountIdStr].lastSentAt = Date.now();
          await redisSet(statsKey, stats);

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
          stats.byAccount[accountIdStr].failed++;
          await redisSet(statsKey, stats);

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

          // Disable account if account-level failure
          if (looksLikeAccountLevelFailure(err)) {
            runtime[accountIdStr] = runtime[accountIdStr] || {};
            runtime[accountIdStr].connected = false;
            runtime[accountIdStr].lastError = err.message || "Account disabled due to failure";
            await redisSet("accounts:runtime", runtime);

            break;
          }
        }
      }

      return { accountId: account.id, email: account.email, sent, failed, errors };
    };

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

    // If finished -> mark completed + clear active pointer but keep last pointer
    if (campaign.cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisSet("auto:campaign:last", campaign.id);
      await redisDel("auto:campaign:active");

      await setLive({ currentAccountId: null, currentEmail: null, currentSenderName: null, state: "completed" });
      await pushEvent({ ts: Date.now(), status: "campaign_completed", campaignId: campaign.id });
    } else {
      await setLive({ currentAccountId: null, currentEmail: null, currentSenderName: null, state: "idle_waiting_next_tick" });
    }

    return res.status(200).json({
      success: true,
      message: "Auto tick completed",
      cursor: campaign.cursor,
      total,
      batches: results
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
