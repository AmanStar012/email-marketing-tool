const { cors, loadAccountsConfig, redisGet } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const accounts = loadAccountsConfig();
    const runtime = (await redisGet("accounts:runtime")) || {};

    const safe = accounts.map((a) => {
      const rt = runtime[String(a.id)] || {};
      return {
        id: a.id,
        email: a.email,
        senderName: a.senderName,
        connected: rt.connected !== false, // default true
        lastError: rt.lastError || ""
      };
    });

    return res.status(200).json({ success: true, accounts: safe });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
};
