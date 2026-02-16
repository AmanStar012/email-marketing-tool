const { cors, redisGet, redisSet, redisDel } = require("./_shared");

function isSameContacts(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  if (!a.length) return false;

  const aFirst = a[0]?.email;
  const aLast = a[a.length - 1]?.email;
  const bFirst = b[0]?.email;
  const bLast = b[b.length - 1]?.email;

  return aFirst === bFirst && aLast === bLast;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const now = Date.now();
    const { contacts, brandName, template, campaignName } = req.body || {};

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

    const campaignNameValue = String(campaignName || "").trim();
    if (!campaignNameValue) {
      return res.status(400).json({ success: false, error: "campaignName is required" });
    }

    /**
     * ===============================
     * 🔁 RESUME ONLY IF SAME CONTACTS
     * ===============================
     */
    const lastId = await redisGet("auto:campaign:last");

    if (lastId) {
      const lastCampaign = await redisGet(`auto:campaign:${lastId}`);

      if (
        lastCampaign &&
        lastCampaign.status === "stopped" &&
        isSameContacts(lastCampaign.contacts, contacts)
      ) {
        lastCampaign.status = "running";
        lastCampaign.updatedAt = now;
        lastCampaign.campaignName = campaignNameValue;

        await redisSet(`auto:campaign:${lastId}`, lastCampaign);
        await redisSet("auto:campaign:active", lastId);

        // reset cooldown + retry
        await redisDel(`auto:campaign:${lastId}:lastSendAt`);
        await redisDel(`auto:campaign:${lastId}:retry`);

        await redisSet(`auto:campaign:${lastId}:live`, {
          currentAccountId: null,
          currentEmail: null,
          currentSenderName: null,
          state: "running",
          updatedAt: now
        });

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

    /**
     * ===============================
     * 🆕 NEW CAMPAIGN (NEW CSV)
     * ===============================
     */
    const campaignId = `c_${Date.now()}`;

    const campaign = {
      id: campaignId,
      status: "running",
      contacts,
      brandName,
      template,
      campaignName: campaignNameValue,
      cursor: 0,
      total: contacts.length,
      createdAt: now,
      updatedAt: now
    };

    await redisSet(`auto:campaign:${campaignId}`, campaign);
    await redisSet("auto:campaign:active", campaignId);
    await redisSet("auto:campaign:last", campaignId);

    await redisDel(`auto:campaign:${campaignId}:lastSendAt`);
    await redisDel(`auto:campaign:${campaignId}:retry`);

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
