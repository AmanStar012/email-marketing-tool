const { kv } = require("@vercel/kv");
const {
  cors,
  sleep,
  convertTextToHTML,
  createTransporter,
  looksLikeAccountLevelFailure,
  applyMerge,
  loadAccountsConfig
} = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);

  // Allow preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // (Recommended) Only allow POST for triggering
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed (use POST)" });
  }

  // ✅ SECURITY: require secret for GitHub / external cron
  // Use either ?secret=... OR header x-auto-secret: ...
  const secret = req.query.secret || req.headers["hhggjddoiiweee"];
  if (!process.env.AUTO_SECRET) {
    return res.status(500).json({
      success: false,
      error: "AUTO_SECRET env var is missing on server"
    });
  }
  if (secret !== process.env.AUTO_SECRET) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  try {
    // Helpful message if KV is not connected
    // (@vercel/kv throws a specific error; we surface it cleanly)
    // If KV is missing, auto mode cannot work safely.
    // So we fail early with a clear reason.
    // (If KV is configured, this is harmless.)
    try {
      // quick noop read to detect missing env early
      await kv.get("kv:healthcheck");
    } catch (kvErr) {
      const msg = String(kvErr?.message || kvErr);
      if (msg.includes("Missing required environment variables KV_REST_API_URL")) {
        return res.status(500).json({
          success: false,
          error:
            "@vercel/kv is not configured. Connect/attach KV to this project so KV_REST_API_URL and KV_REST_API_TOKEN exist."
        });
      }
      // if it's some other KV error, continue to normal catch below
      throw kvErr;
    }

    const activeId = await kv.get("auto:campaign:active");
    if (!activeId) {
      return res.status(200).json({ success: true, message: "No active campaign" });
    }

    const campaignKey = `auto:campaign:${activeId}`;
    const campaign = await kv.get(campaignKey);

    if (!campaign) {
      await kv.del("auto:campaign:active");
      return res.status(200).json({
        success: true,
        message: "Campaign missing; cleared active pointer"
      });
    }

    if (campaign.status !== "running") {
      return res.status(200).json({
        success: true,
        message: `Campaign status: ${campaign.status}`
      });
    }

    const accounts = loadAccountsConfig();
    const runtime = (await kv.get("accounts:runtime")) || {};

    const connectedAccounts = accounts.filter(
      (a) => runtime[String(a.id)]?.connected !== false
    );

    const emailsPerAcc = Number(campaign.emailsPerAccountPerHour || 40);
    const delayMs = Number(campaign.perEmailDelayMs || 1000);

    const total = campaign.contacts.length;
    let cursor = campaign.cursor || 0;

    if (cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await kv.set(campaignKey, campaign);
      await kv.del("auto:campaign:active");
      return res.status(200).json({ success: true, message: "Completed (no contacts left)" });
    }

    if (connectedAccounts.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No connected accounts; nothing sent"
      });
    }

    // Concurrency control: avoid 35 parallel SMTP sessions at once.
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

    // Save cursor now (so even if some jobs fail, we don't resend same contacts next hour)
    campaign.cursor = cursor;
    campaign.updatedAt = Date.now();
    await kv.set(campaignKey, campaign);

    // Worker: send one batch for one account
    const sendBatchForAccount = async (account, contactsSlice) => {
      let transporter = createTransporter(account);

      let sent = 0;
      let failed = 0;
      const errors = [];

      for (const c of contactsSlice) {
        const to =
          c.email ||
          c.Email ||
          c.EMAIL ||
          c["Email Address"] ||
          c.email_address ||
          "";

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
            from: account.senderName
              ? `${account.senderName} <${account.email}>`
              : account.email,
            to,
            subject: subj,
            html
          });

          sent++;
          if (delayMs > 0) await sleep(delayMs);
        } catch (err) {
          failed++;
          errors.push({ email: to, error: err.message });

          // Disable account immediately if it's account-level failure
          if (looksLikeAccountLevelFailure(err)) {
            const key = String(account.id);
            runtime[key] = runtime[key] || {};
            runtime[key].connected = false;
            runtime[key].lastError = err.message || "Account disabled due to failure";
            await kv.set("accounts:runtime", runtime);

            // Stop this account batch immediately
            break;
          }
        }
      }

      return { accountId: account.id, email: account.email, sent, failed, errors };
    };

    // Process hour plan with limited concurrency
    const results = [];
    let idx = 0;

    const workers = new Array(Math.min(CONCURRENCY, hourPlan.length))
      .fill(0)
      .map(async () => {
        while (idx < hourPlan.length) {
          const myIndex = idx++;
          const job = hourPlan[myIndex];
          const r = await sendBatchForAccount(job.account, job.contacts);
          results.push(r);
        }
      });

    await Promise.all(workers);

    // If finished contacts, stop campaign automatically
    if (campaign.cursor >= total) {
      campaign.status = "completed";
      campaign.updatedAt = Date.now();
      await kv.set(campaignKey, campaign);
      await kv.del("auto:campaign:active");
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
