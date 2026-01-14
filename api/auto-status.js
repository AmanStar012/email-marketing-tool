const { cors, redisGet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const activeId = await redisGet("auto:campaign:active");
    const lastId = await redisGet("auto:campaign:last");

    // Prefer active campaign, else show last campaign (completed/stopped)
    const id = activeId || lastId;

    if (!id) {
      return res.status(200).json({
        success: true,
        activeId: null,
        lastId: null,
        campaign: null,
        live: null,
        stats: null,
        events: []
      });
    }

    const campaignKey = `auto:campaign:${id}`;
    const liveKey = `auto:campaign:${id}:live`;
    const statsKey = `auto:campaign:${id}:stats`;
    const eventsKey = `auto:campaign:${id}:events`;

    const campaign = await redisGet(campaignKey);
    const live = await redisGet(liveKey);
    const stats = await redisGet(statsKey);
    let events = (await redisGet(eventsKey)) || [];
    if (!Array.isArray(events)) events = [];

    // If campaign key missing, still return something useful
    if (!campaign) {
      return res.status(200).json({
        success: true,
        activeId,
        lastId,
        campaign: null,
        live: live || null,
        stats: stats || null,
        events
      });
    }

    // Compute useful fields for UI
    const total = Number(campaign.total || (campaign.contacts ? campaign.contacts.length : 0) || 0);
    const cursor = Number(campaign.cursor || 0);
    const percent = total > 0 ? Math.round((cursor / total) * 100) : 0;

    return res.status(200).json({
      success: true,
      activeId,
      lastId,
      campaign: {
        ...campaign,
        total,
        cursor,
        percent,
        isActive: Boolean(activeId && activeId === id)
      },
      live: live || null,
      stats: stats || null,
      events
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
