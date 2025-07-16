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
    const { contacts, template } = req.body;

    const transporter = nodemailer.createTransport({
      host: 'sandbox.smtp.mailtrap.io',
      port: 2525,
      secure: false,
      auth: {
        user: 'c2418473e9f491',
        pass: '3320713de2d339'
      }
    });

    const results = {
      total: contacts.length,
      sent: 0,
      failed: 0,
      errors: []
    };

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        let personalizedSubject = template.subject;
        let personalizedContent = template.content;
        
        Object.keys(contact).forEach(key => {
          const regex = new RegExp(`{{${key}}}`, 'g');
          personalizedSubject = personalizedSubject.replace(regex, contact[key] || '');
          personalizedContent = personalizedContent.replace(regex, contact[key] || '');
        });

        await transporter.sendMail({
          from: 'test@example.com',
          to: contact.email,
          subject: personalizedSubject,
          html: personalizedContent
        });

        results.sent++;
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        results.failed++;
        results.errors.push({
          email: contact.email || 'unknown',
          error: error.message
        });
      }
    }

    results.successRate = results.total > 0 ? Math.round((results.sent / results.total) * 100) : 0;

    return res.status(200).json({ 
      success: true, 
      results: results
    });

  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
};