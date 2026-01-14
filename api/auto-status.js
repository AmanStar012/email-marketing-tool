const { cors, redisGet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const activeId = await redisGet("auto:campaign:active");
    if (!activeId) {
      return res.status(200).json({ success: true, activeId: null, campaign: null });
    }

    const campaign = await redisGet(`auto:campaign:${activeId}`);
    return res.status(200).json({ success: true, activeId, campaign });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
