const nodemailer = require("nodemailer");
const { kv } = require("@vercel/kv");
const { cors, loadAccountsConfig } = require("./_shared");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { contacts, template, selectedAccount } = req.body || {};
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "contacts is required" });
    }
    if (!template || !template.subject || !template.content) {
      return res.status(400).json({ success: false, error: "template.subject and template.content are required" });
    }

    // Load accounts from accounts.json + PASS_#
    const rawAccounts = loadAccountsConfig();

    // Load runtime (connected/disconnected)
    const runtime = (await kv.get("accounts:runtime")) || {};

    // Build accounts list for sending (include password)
    const emailAccounts = rawAccounts.map((a) => {
      const rt = runtime[String(a.id)] || {};
      return {
        id: a.id,
        name: `Account ${a.id}`,
        email: a.email,
        password: a.pass,
        senderName: a.senderName || "",
        connected: rt.connected !== false, // default true
        lastError: rt.lastError || "",
        active: false
      };
    });

    // Filter: only connected AND has password
    const usableAccounts = emailAccounts.filter((a) => a.connected && a.password);

    if (usableAccounts.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No usable email accounts (connected + PASS_id set)."
      });
    }

    // Choose starting account
    let currentAccount =
      (selectedAccount && usableAccounts.find((a) => a.id === selectedAccount)) ||
      usableAccounts[0];

    let currentAccountIndex = usableAccounts.findIndex((a) => a.id === currentAccount.id);
    if (currentAccountIndex < 0) currentAccountIndex = 0;

    // Create transporter (will be replaced when rotating)
    let transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: currentAccount.email, pass: currentAccount.password }
    });

    const results = {
      total: contacts.length,
      sent: 0,
      failed: 0,
      errors: [],
      usedAccount: currentAccount.email,
      accountSwitches: [],
      successRate: 0
    };

    const emailsPerAccount = 40;
    let emailsSentFromCurrentAccount = 0;

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      try {
        // Rotate account after 40
        if (emailsSentFromCurrentAccount >= emailsPerAccount && usableAccounts.length > 1) {
          currentAccountIndex = (currentAccountIndex + 1) % usableAccounts.length;
          currentAccount = usableAccounts[currentAccountIndex];
          emailsSentFromCurrentAccount = 0;

          transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: currentAccount.email, pass: currentAccount.password }
          });

          results.accountSwitches.push({ switchAt: i, newAccount: currentAccount.email });
        }

        // Personalize template
        let personalizedSubject = template.subject;
        let personalizedContent = template.content;

        Object.keys(contact || {}).forEach((key) => {
          const regex = new RegExp(`{{${key}}}`, "g");
          personalizedSubject = personalizedSubject.replace(regex, contact[key] || "");
          personalizedContent = personalizedContent.replace(regex, contact[key] || "");
        });

        // Auto-fill senderName placeholder if you use it
        personalizedSubject = personalizedSubject.replace(/{{senderName}}/g, currentAccount.senderName || "");
        personalizedContent = personalizedContent.replace(/{{senderName}}/g, currentAccount.senderName || "");

        // Auto-fill brandName if you send it from frontend as template.brandName
        if (template.brandName) {
          personalizedSubject = personalizedSubject.replace(/{{brandName}}/g, template.brandName);
          personalizedContent = personalizedContent.replace(/{{brandName}}/g, template.brandName);
        }

        const htmlContent = convertTextToHTML(personalizedContent);

        // Send
        await transporter.sendMail({
          from: currentAccount.senderName
            ? `"${currentAccount.senderName}" <${currentAccount.email}>`
            : currentAccount.email,
          to: contact.email,
          subject: personalizedSubject,
          html: htmlContent
        });

        results.sent++;
        emailsSentFromCurrentAccount++;

        // small delay
        await new Promise((r) => setTimeout(r, 1000));
      } catch (error) {
        results.failed++;
        results.errors.push({
          email: (contact && contact.email) || "unknown",
          error: error.message,
          account: currentAccount.email
        });

        // IMPORTANT: disable account immediately on first failure (your requirement)
        runtime[String(currentAccount.id)] = {
          ...(runtime[String(currentAccount.id)] || {}),
          connected: false,
          lastError: error.message
        };
        await kv.set("accounts:runtime", runtime);

        // Remove it from usableAccounts so it won't be used again this run
        const idx = usableAccounts.findIndex((a) => a.id === currentAccount.id);
        if (idx >= 0) usableAccounts.splice(idx, 1);

        // If no accounts left, stop
        if (usableAccounts.length === 0) {
          break;
        }

        // Move to next available account immediately
        currentAccountIndex = currentAccountIndex % usableAccounts.length;
        currentAccount = usableAccounts[currentAccountIndex];

        transporter = nodemailer.createTransport({
          service: "gmail",
          auth: { user: currentAccount.email, pass: currentAccount.password }
        });

        emailsSentFromCurrentAccount = 0;
        results.accountSwitches.push({ switchAt: i, newAccount: currentAccount.email });
      }
    }

    results.successRate = results.total > 0 ? Math.round((results.sent / results.total) * 100) : 0;
    results.usedAccount = currentAccount.email;

    return res.status(200).json({ success: true, results });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

function convertTextToHTML(text) {
  if (!text) return "";
  return text
    .replace(/\r?\n/g, "<br>")
    .replace(/  +/g, (spaces) => "&nbsp;".repeat(spaces.length))
    .replace(
      /^/,
      '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6; color: #333;">'
    )
    .replace(/$/, "</div>");
}
