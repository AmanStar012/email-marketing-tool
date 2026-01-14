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

    const key = `auto:campaign:${activeId}`;
    const campaign = await redisGet(key);

    if (campaign) {
      campaign.status = "stopped";
      campaign.updatedAt = Date.now();
      await redisSet(key, campaign);
    }

    await redisDel("auto:campaign:active");
    return res.status(200).json({ success: true, message: "Stopped (campaign saved)" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
