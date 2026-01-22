const { cors, redisGet, redisSet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const now = Date.now();

    /**
     * EXPECTED PAYLOAD SHAPE (NEW)
     * {
     *   contacts: [...],
     *   brands: ["Brand A", "Brand B", "Brand C"],
     *   templates: {
     *     subjects: ["...", "...", "..."],
     *     bodies: ["...", "...", "..."]
     *   }
     * }
     */
    const { contacts, brands, templates } = req.body || {};

    /* =====================================================
       🔁 RESUME LOGIC (UNCHANGED)
    ===================================================== */

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

    /* =====================================================
       🆕 NEW CAMPAIGN VALIDATION
    ===================================================== */

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: "contacts array is required"
      });
    }

    if (!Array.isArray(brands) || brands.length < 1) {
      return res.status(400).json({
        success: false,
        error: "brands array is required"
      });
    }

    if (
      !templates ||
      !Array.isArray(templates.subjects) ||
      templates.subjects.length < 1 ||
      !Array.isArray(templates.bodies) ||
      templates.bodies.length < 1
    ) {
      return res.status(400).json({
        success: false,
        error: "templates.subjects and templates.bodies arrays are required"
      });
    }

    /* =====================================================
       🆕 CREATE NEW CAMPAIGN
    ===================================================== */

    const campaignId = `c_${Date.now()}`;

    const campaign = {
      id: campaignId,
      status: "running",

      // NEW STRUCTURE
      brands,                  // [ "Brand1", "Brand2", "Brand3" ]
      templates: {
        subjects: templates.subjects, // 5 subjects
        bodies: templates.bodies      // 5 bodies
      },

      contacts,
      cursor: 0,
      total: contacts.length,

      // timing (informational only now)
      emailsPerAccountPerHour: 30,
      perEmailDelayMs: 60_000,

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

  } catch (e) {
    return res.status(500).json({
      success: false,
      error: e.message
    });
  }
};
