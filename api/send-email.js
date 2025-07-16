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

    console.log('=== MAILTRAP EMAIL SENDING ===');
    console.log('Host:', process.env.SMTP_HOST);
    console.log('Port:', process.env.SMTP_PORT);
    console.log('User:', process.env.SMTP_USER);
    console.log('To:', to);

    const smtpConfig = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    };

    const transporter = nodemailer.createTransport(smtpConfig);

    const mailOptions = {
      from: 'test@example.com',
      to: to,
      subject: subject,
      html: content
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully via Mailtrap!');
    console.log('Message ID:', result.messageId);

    return res.status(200).json({ 
      success: true, 
      messageId: result.messageId,
      service: 'Mailtrap'
    });

  } catch (error) {
    console.error('❌ Mailtrap error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
};