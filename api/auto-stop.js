const { cors, redisGet, redisSet, redisDel } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const activeId = await redisGet("auto:campaign:active");
    if (!activeId) {
      return res.status(200).json({ success: true, message: "No active campaign" });
    }

    const now = Date.now();
    const campaignKey = `auto:campaign:${activeId}`;
    const liveKey = `auto:campaign:${activeId}:live`;
    const eventsKey = `auto:campaign:${activeId}:events`;

    const campaign = await redisGet(campaignKey);
    if (campaign) {
      campaign.status = "stopped";
      campaign.updatedAt = now;
      await redisSet(campaignKey, campaign);
    }

    // Keep last pointer so UI shows stopped campaign
    await redisSet("auto:campaign:last", activeId);

    // Update live state
    const live = (await redisGet(liveKey)) || {};
    await redisSet(liveKey, {
      ...live,
      currentAccountId: null,
      currentEmail: null,
      currentSenderName: null,
      state: "stopped",
      updatedAt: now
    });

    // Push event for stop action
    let events = (await redisGet(eventsKey)) || [];
    if (!Array.isArray(events)) events = [];
    events.push({ ts: now, status: "campaign_stopped", campaignId: activeId });
    if (events.length > 300) events = events.slice(-300);
    await redisSet(eventsKey, events);

    // Clear active pointer
    await redisDel("auto:campaign:active");

    return res.status(200).json({ success: true, message: "Campaign stopped" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
