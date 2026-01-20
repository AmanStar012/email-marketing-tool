const { cors, redisGet, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { contacts, brandName, template } = req.body || {};
    const now = Date.now();

    // 🔍 Check last campaign
    const lastId = await redisGet("auto:campaign:last");

    if (lastId) {
      const lastCampaign = await redisGet(`auto:campaign:${lastId}`);

      // 🔁 RESUME logic
      if (lastCampaign && lastCampaign.status === "stopped") {
        lastCampaign.status = "running";
        lastCampaign.updatedAt = now;

        await redisSet(`auto:campaign:${lastId}`, lastCampaign);
        await redisSet("auto:campaign:active", lastId);

        // Update live state
        await redisSet(`auto:campaign:${lastId}:live`, {
          currentAccountId: null,
          currentEmail: null,
          currentSenderName: null,
          state: "running",
          updatedAt: now
        });

        // Push resume event
        const eventsKey = `auto:campaign:${lastId}:events`;
        const events = (await redisGet(eventsKey)) || [];
        events.push({ ts: now, status: "campaign_resumed", campaignId: lastId });
        await redisSet(eventsKey, events.slice(-300));

        return res.status(200).json({
          success: true,
          campaignId: lastId,
          resumed: true
        });
      }
    }

    // 🆕 No stopped campaign → create NEW
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "contacts array is required" });
    }
    if (!brandName) return res.status(400).json({ success: false, error: "brandName is required" });
    if (!template?.subject || !template?.content) {
      return res.status(400).json({
        success: false,
        error: "template.subject + template.content are required"
      });
    }

    const campaignId = `c_${Date.now()}`;

    const campaign = {
      id: campaignId,
      status: "running",
      brandName,
      template,
      contacts,
      cursor: 0,
      total: contacts.length,
      emailsPerAccountPerHour: 40,
      perEmailDelayMs: 1000,
      createdAt: now,
      updatedAt: now
    };

    await redisSet(`auto:campaign:${campaignId}`, campaign);
    await redisSet("auto:campaign:active", campaignId);
    await redisSet("auto:campaign:last", campaignId);

    await redisSet(`auto:campaign:${campaignId}:stats`, {
      campaignId,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    });

    await redisSet(`auto:campaign:${campaignId}:live`, {
      currentAccountId: null,
      currentEmail: null,
      currentSenderName: null,
      state: "running",
      updatedAt: now
    });

    await redisSet(`auto:campaign:${campaignId}:events`, [
      { ts: now, status: "campaign_started", campaignId, brandName, total: contacts.length }
    ]);

    return res.status(200).json({
      success: true,
      campaignId,
      resumed: false
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
