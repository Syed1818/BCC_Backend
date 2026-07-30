const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const REGION = process.env.AWS_REGION || "ap-south-1";

const sesClient = new SESClient({ region: REGION });
const snsClient = new SNSClient({ region: REGION });

/**
 * Sends a transactional email using AWS SES
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject line
 * @param {string} options.htmlBody - HTML formatted body
 * @param {string} options.textBody - Plain text fallback body
 */
async function sendEmail({ to, subject, htmlBody, textBody }) {
    if (!to) return { success: false, error: "No recipient email provided" };
    
    const params = {
        Destination: {
            ToAddresses: [to],
        },
        Message: {
            Body: {
                Html: {
                    Charset: "UTF-8",
                    Data: htmlBody || textBody,
                },
                Text: {
                    Charset: "UTF-8",
                    Data: textBody || htmlBody.replace(/<[^>]*>?/gm, ""),
                },
            },
            Subject: {
                Charset: "UTF-8",
                Data: subject,
            },
        },
        Source: process.env.AWS_SES_SENDER_EMAIL || "no-reply@bharatcareerconnect.in",
    };

    try {
        const command = new SendEmailCommand(params);
        const response = await sesClient.send(command);
        console.log(`📧 [SES] Email sent successfully to ${to} | MessageId: ${response.MessageId}`);
        return { success: true, messageId: response.MessageId };
    } catch (error) {
        console.error("❌ [SES] Email Send Error:", error.message || error);
        return { success: false, error: error.message };
    }
}

/**
 * Sends an SMS text message using AWS SNS
 * @param {Object} options
 * @param {string} options.phone - Recipient mobile number (10 digits or E.164 format)
 * @param {string} options.message - SMS message text content
 */
async function sendSms({ phone, message }) {
    if (!phone) return { success: false, error: "No phone number provided" };

    // Format phone number to E.164 standard (+91 for India if 10 digits)
    const cleanDigits = phone.replace(/\D/g, "");
    const formattedPhone = cleanDigits.length === 10 ? `+91${cleanDigits}` : `+${cleanDigits}`;

    const params = {
        Message: message,
        PhoneNumber: formattedPhone,
        MessageAttributes: {
            "AWS.SNS.SMS.SMSType": {
                DataType: "String",
                StringValue: "Transactional", // Ensures high-priority delivery
            },
        },
    };

    try {
        const command = new PublishCommand(params);
        const response = await snsClient.send(command);
        console.log(`📱 [SNS] SMS sent successfully to ${formattedPhone} | MessageId: ${response.MessageId}`);
        return { success: true, messageId: response.MessageId };
    } catch (error) {
        console.error("❌ [SNS] SMS Send Error:", error.message || error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    sendEmail,
    sendSms,
};
