const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { to, subject, content, fromAccount, campaignId, isHtml = true } = req.body;

    if (!to || !subject || !content) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields' 
      });
    }

    // SMTP configuration
    const smtpConfig = {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    };

    // Create transporter - THIS IS THE FIX
    const transporter = nodemailer.createTransporter(smtpConfig);

    // Send email
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: to,
      subject: subject,
      html: content
    };

    const result = await transporter.sendMail(mailOptions);

    return res.status(200).json({ 
      success: true, 
      messageId: result.messageId,
      recipient: to
    });

  } catch (error) {
    console.error('Email error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
};