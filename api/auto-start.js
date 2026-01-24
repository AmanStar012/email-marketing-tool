const { cors, redisGet, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const now = Date.now();
    const { contacts, brandName, template } = req.body || {};

    const lastId = await redisGet("auto:campaign:last");

    if (lastId) {
      const lastCampaign = await redisGet(`auto:campaign:${lastId}`);

      if (lastCampaign && lastCampaign.status === "stopped") {
        // Resume campaign
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
        let events = (await redisGet(eventsKey)) || [];
        if (!Array.isArray(events)) events = [];
        events.push({ ts: now, status: "campaign_resumed", campaignId: lastId });
        if (events.length > 300) events = events.slice(-300);
        await redisSet(eventsKey, events);

        return res.status(200).json({
          success: true,
          campaignId: lastId,
          resumed: true
        });
      }
    }

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "contacts is required" });
    }

    const hasBrand =
      Array.isArray(brandName) ? brandName.length > 0 : Boolean(brandName);
    if (!hasBrand) {
      return res.status(400).json({ success: false, error: "brandName is required" });
    }

    const hasSubject =
      Array.isArray(template?.subject)
        ? template.subject.length > 0
        : Boolean(template?.subject);

    const hasContent =
      Array.isArray(template?.content)
        ? template.content.length > 0
        : Boolean(template?.content);

    if (!hasSubject || !hasContent) {
      return res.status(400).json({
        success: false,
        error: "template.subject and template.content are required"
      });
    }
    
    const campaignId = `c_${Date.now()}`;

    const campaign = {
      id: campaignId,
      status: "running",
      contacts,
      brandName,
      template,
      cursor: 0,
      total: contacts.length,
      createdAt: now,
      updatedAt: now
    };

    await redisSet(`auto:campaign:${campaignId}`, campaign);
    await redisSet("auto:campaign:active", campaignId);
    await redisSet("auto:campaign:last", campaignId);

    // Init stats
    await redisSet(`auto:campaign:${campaignId}:stats`, {
      campaignId,
      totalSent: 0,
      totalFailed: 0,
      byAccount: {}
    });

    // Init live state
    await redisSet(`auto:campaign:${campaignId}:live`, {
      currentAccountId: null,
      currentEmail: null,
      currentSenderName: null,
      state: "running",
      updatedAt: now
    });

    // Init events
    await redisSet(`auto:campaign:${campaignId}:events`, [
      { ts: now, status: "campaign_started", campaignId }
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
