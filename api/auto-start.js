// api/auto-start.js
const { cors, redisGet, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { contacts, brandName, template } = req.body || {};
    const now = Date.now();

    // =========================
    // 1️⃣ CONTACTS (CSV) VALIDATION
    // =========================
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: "contacts array is required"
      });
    }

    // =========================
    // 2️⃣ BRAND VALIDATION (string OR array)
    // =========================
    const hasBrand =
      Array.isArray(brandName)
        ? brandName.length > 0
        : typeof brandName === "string" && brandName.trim().length > 0;

    if (!hasBrand) {
      return res.status(400).json({
        success: false,
        error: "brandName is required"
      });
    }

    // =========================
    // 3️⃣ TEMPLATE VALIDATION (string OR array)
    // =========================
    if (!template || typeof template !== "object") {
      return res.status(400).json({
        success: false,
        error: "template is required"
      });
    }

    const hasSubject =
      Array.isArray(template.subject)
        ? template.subject.length > 0
        : typeof template.subject === "string" && template.subject.trim().length > 0;

    const hasContent =
      Array.isArray(template.content)
        ? template.content.length > 0
        : typeof template.content === "string" && template.content.trim().length > 0;

    if (!hasSubject || !hasContent) {
      return res.status(400).json({
        success: false,
        error: "template.subject and template.content are required"
      });
    }

    // =========================
    // 4️⃣ RESUME LOGIC (unchanged)
    // =========================
    const lastId = await redisGet("auto:campaign:last");

    if (lastId) {
      const lastCampaign = await redisGet(`auto:campaign:${lastId}`);

      if (lastCampaign && lastCampaign.status === "stopped") {
        lastCampaign.status = "running";
        lastCampaign.updatedAt = now;

        await redisSet(`auto:campaign:${lastId}`, lastCampaign);
        await redisSet("auto:campaign:active", lastId);

        await redisSet(`auto:campaign:${lastId}:live`, {
          currentAccountId: null,
          currentEmail: null,
          currentSenderName: null,
          state: "running",
          updatedAt: now
        });

        const eventsKey = `auto:campaign:${lastId}:events`;
        const events = (await redisGet(eventsKey)) || [];
        events.push({
          ts: now,
          status: "campaign_resumed",
          campaignId: lastId
        });
        await redisSet(eventsKey, events.slice(-300));

        return res.status(200).json({
          success: true,
          campaignId: lastId,
          resumed: true
        });
      }
    }

    // =========================
    // 5️⃣ CREATE NEW CAMPAIGN (CSV SAVED HERE)
    // =========================
    const campaignId = `c_${Date.now()}`;

    const campaign = {
      id: campaignId,
      status: "running",
      brandName,          // string OR array (both supported)
      template,           // subject/content string OR array
      contacts,           // ✅ CSV STORED HERE
      cursor: 0,
      total: contacts.length,
      emailsPerAccountPerHour: 40,
      perEmailDelayMs: 1000,
      createdAt: now,
      updatedAt: now
    };

    // Save campaign
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
      {
        ts: now,
        status: "campaign_started",
        campaignId,
        total: contacts.length
      }
    ]);

    return res.status(200).json({
      success: true,
      campaignId,
      resumed: false
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};
