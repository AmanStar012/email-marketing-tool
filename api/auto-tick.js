const { cors, sleep, convertTextToHTML, createTransporter, looksLikeAccountLevelFailure, applyMerge, loadAccountsConfig, redisGet, redisSet, redisDel } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    // Check if the campaign is running
    const activeId = await redisGet("auto:campaign:active");
    if (!activeId) return res.status(200).json({ success: true, message: "No active campaign" });

    const campaignKey = `auto:campaign:${activeId}`;
    const liveKey = `auto:campaign:${activeId}:live`;
    const statsKey = `auto:campaign:${activeId}:stats`;
    const eventsKey = `auto:campaign:${activeId}:events`;

    const campaign = await redisGet(campaignKey);
    if (!campaign || campaign.status !== "running") {
      return res.status(200).json({ success: true, message: `Campaign status: ${campaign.status}` });
    }

    const accounts = loadAccountsConfig();
    const runtime = (await redisGet("accounts:runtime")) || {};

    const connectedAccounts = accounts.filter((a) => runtime[String(a.id)]?.connected !== false);
    const emailsPerAcc = Number(campaign.emailsPerAccountPerHour || 40);
    const delayMs = Number(campaign.perEmailDelayMs || 1000);

    const total = campaign.contacts.length;
    let cursor = campaign.cursor || 0;

    // Handle concurrency control: send emails from multiple accounts
    const CONCURRENCY = 20;
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

    // Save cursor early to prevent re-sending in the next tick
    campaign.cursor = tmpCursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);

    const sendBatchForAccount = async (account, contactsSlice) => {
      const accountIdStr = String(account.id);
      let transporter = createTransporter(account);
      let sent = 0;
      let failed = 0;

      for (const c of contactsSlice) {
        const to = c.email || c.Email || c["Email Address"];
        if (!to) {
          failed++;
          continue;
        }

        try {
          // Send the email
          const vars = {
            brandName: campaign.brandName,
            senderName: account.senderName,
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
        } catch (err) {
          failed++;
          if (looksLikeAccountLevelFailure(err)) {
            runtime[accountIdStr] = runtime[accountIdStr] || {};
            runtime[accountIdStr].connected = false;
            await redisSet("accounts:runtime", runtime);
            break;
          }
        }
      }

      return { accountId: account.id, email: account.email, sent, failed };
    };

    const results = [];
    const workers = new Array(Math.min(CONCURRENCY, hourPlan.length)).fill(0).map(async () => {
      while (hourPlan.length > 0) {
        const job = hourPlan.shift();
        const r = await sendBatchForAccount(job.account, job.contacts);
        results.push(r);
      }
    });

    await Promise.all(workers);

    // If campaign completed
    if (campaign.cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");
      await setLive({ state: "completed", currentEmail: null, currentAccountId: null, currentSenderName: null });
      await pushEvent({ ts: Date.now(), status: "campaign_completed", campaignId: campaign.id });
    } else {
      await setLive({ state: "idle_waiting_next_tick", currentEmail: null, currentAccountId: null, currentSenderName: null });
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
