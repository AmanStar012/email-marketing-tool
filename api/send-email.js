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

    // Detailed logging
    console.log('=== EMAIL SENDING DEBUG ===');
    console.log('From:', process.env.SMTP_USER);
    console.log('To:', to);
    console.log('Password length:', process.env.SMTP_PASSWORD?.length);
    console.log('Password first 4 chars:', process.env.SMTP_PASSWORD?.substring(0, 4));

    // Try different Gmail configurations
    const smtpConfigs = [
      {
        name: 'Gmail Service',
        config: {
          service: 'gmail',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
          }
        }
      },
      {
        name: 'Gmail SMTP',
        config: {
          host: 'smtp.gmail.com',
          port: 587,
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
          },
          tls: {
            rejectUnauthorized: false
          }
        }
      },
      {
        name: 'Gmail SSL',
        config: {
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
          }
        }
      }
    ];

    let lastError = null;

    for (const smtpConfig of smtpConfigs) {
      try {
        console.log(`Trying ${smtpConfig.name}...`);
        const transporter = nodemailer.createTransport(smtpConfig.config);
        
        // Test connection
        await transporter.verify();
        console.log(`${smtpConfig.name} connection successful!`);

        const mailOptions = {
          from: process.env.SMTP_USER,
          to: to,
          subject: subject,
          html: content
        };

        const result = await transporter.sendMail(mailOptions);
        console.log(`Email sent successfully via ${smtpConfig.name}`);

        return res.status(200).json({ 
          success: true, 
          messageId: result.messageId,
          method: smtpConfig.name
        });

      } catch (error) {
        console.log(`${smtpConfig.name} failed:`, error.message);
        lastError = error;
        continue;
      }
    }

    // If all methods failed
    throw lastError;

  } catch (error) {
    console.error('All methods failed:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message,
      code: error.code
    });
  }
};