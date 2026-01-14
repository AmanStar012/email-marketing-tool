const { kv } = require("@vercel/kv");
const { cors } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const activeId = await kv.get("auto:campaign:active");
    const campaign = activeId ? await kv.get(`auto:campaign:${activeId}`) : null;

    return res.status(200).json({
      success: true,
      activeId: activeId || null,
      campaign: campaign
        ? {
            id: campaign.id,
            status: campaign.status,
            cursor: campaign.cursor,
            total: campaign.contacts?.length || 0,
            brandName: campaign.brandName,
            updatedAt: campaign.updatedAt
          }
        : null
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
