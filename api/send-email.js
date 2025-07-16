const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { to, subject, content } = req.body;

    const transporter = nodemailer.createTransport({
      host: 'sandbox.smtp.mailtrap.io',
      port: 2525,
      secure: false,
      auth: {
        user: 'c2418473e9f491',
        pass: '3320713de2d339'
      }
    });

    const result = await transporter.sendMail({
      from: 'test@example.com',
      to: to,
      subject: subject,
      html: content
    });

    return res.status(200).json({ 
      success: true, 
      messageId: result.messageId
    });

  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
};