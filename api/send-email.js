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

    // FIXED: Convert text to HTML with preserved spacing
    const htmlContent = convertTextToHTML(content);

    const result = await transporter.sendMail({
      from: '2003aman01.sharma@gmail.com',
      to: to,
      subject: subject,
      html: htmlContent  // Use HTML instead of plain text
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

// ADDED: Function to convert text to HTML with preserved spacing
function convertTextToHTML(text) {
  if (!text) return '';
  
  return text
    // Convert line breaks to <br> tags
    .replace(/\r?\n/g, '<br>')
    // Convert multiple spaces to &nbsp; to preserve spacing
    .replace(/  +/g, function(spaces) {
      return '&nbsp;'.repeat(spaces.length);
    })
    // Wrap in a div with proper CSS for spacing preservation
    .replace(/^/, '<div style="white-space: pre-wrap; font-family: Arial, sans-serif; line-height: 1.6;">')
    .replace(/$/, '</div>');
}
