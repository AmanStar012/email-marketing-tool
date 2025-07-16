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
      service: 'gmail',
      auth: {
        user: '2003aman01.sharma@gmail.com',
        pass: 'phszxjngntaqqncj'
      }
    });

    const result = await transporter.sendMail({
      from: '2003aman01.sharma@gmail.com',
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