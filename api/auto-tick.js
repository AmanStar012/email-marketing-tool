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
    // --- Secret protection (for GitHub Actions / private calls)
    const secret = req.headers["x-auto-secret"];
    const expected = process.env.AUTO_SECRET;
    if (!expected) return res.status(500).json({ success: false, error: "Missing AUTO_SECRET env var" });
    if (!secret || secret !== expected) {
      return res.status(401).json({ success: false, error: "Unauthorized (bad auto secret)" });
    }

    const activeId = await redisGet("auto:campaign:active");
    if (!activeId) return res.status(200).json({ success: true, message: "No active campaign" });

    const campaignKey = `auto:campaign:${activeId}`;
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

    if (cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");
      return res.status(200).json({ success: true, message: "Completed (no contacts left)" });
    }

    if (connectedAccounts.length === 0) {
      return res.status(200).json({ success: true, message: "No connected accounts; nothing sent" });
    }

    // Concurrency control: avoid 34 parallel SMTP sessions at once.
    const CONCURRENCY = 5;

    const hourPlan = [];
    for (const acc of connectedAccounts) {
      const start = cursor;
      const end = Math.min(cursor + emailsPerAcc, total);
      if (start >= end) break;

      hourPlan.push({
        account: acc,
        contacts: campaign.contacts.slice(start, end)
      });

      cursor = end;
    }

    // Save cursor early so we don't resend same contacts in next tick
    campaign.cursor = cursor;
    campaign.updatedAt = Date.now();
    await redisSet(campaignKey, campaign);

    const sendBatchForAccount = async (account, contactsSlice) => {
      let transporter = createTransporter(account);

      let sent = 0;
      let failed = 0;
      const errors = [];

      for (const c of contactsSlice) {
        const to =
          c.email || c.Email || c.EMAIL || c["Email Address"] || c.email_address || c.mail || c.Mail || "";

        if (!to) {
          failed++;
          errors.push({ email: "missing", error: "Missing email in contact row" });
          continue;
        }

        try {
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
          if (delayMs > 0) await sleep(delayMs);
        } catch (err) {
          failed++;
          errors.push({ email: to, error: err.message });

          // Disable account if it's account-level failure
          if (looksLikeAccountLevelFailure(err)) {
            const key = String(account.id);
            runtime[key] = runtime[key] || {};
            runtime[key].connected = false;
            runtime[key].lastError = err.message || "Account disabled due to failure";
            await redisSet("accounts:runtime", runtime);

            // stop this account batch immediately
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

    if (campaign.cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await redisSet(campaignKey, campaign);
      await redisDel("auto:campaign:active");
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
