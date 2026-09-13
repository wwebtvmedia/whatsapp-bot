// mailConnection.js
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import EventEmitter from 'events';
import { filterEmailToStandardMessage } from './filters/mailFilter.js';

dotenv.config();

const reconnectDelay = parseInt(process.env.MAIL_RECONNECT_DELAY || '30000', 10);

let transporter = null;

// Lazy: only build the SMTP transport when a send is actually requested,
// so the module can be imported with mail unconfigured (env vars empty).
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: parseInt(process.env.MAIL_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, text, html }) {
  try {
    const info = await getTransporter().sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    console.log('📧 Email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('❌ Failed to send email:', error.message);
    throw error;
  }
}

export function startMailListener(onNewMail) {
  const mailEvents = new EventEmitter();
  let stopped = false;
  let lastMessageId = null; // 'mail' can fire more than once for the same message

  const connect = () => {
    if (stopped) return;
    const imap = new Imap({
      user: process.env.MAIL_USER,
      password: process.env.MAIL_PASS,
      host: process.env.MAIL_IMAP_HOST,
      port: parseInt(process.env.MAIL_IMAP_PORT || '993'),
      tls: true,
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          console.error('❌ IMAP openBox failed:', err.message);
          imap.end();
          return;
        }

        imap.on('mail', () => {
          const fetch = imap.seq.fetch(`${box.messages.total}:*`, {
            bodies: '',
            struct: true
          });

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (err) {
                  console.error('❌ Error parsing email:', err.message);
                  return;
                }
                const standardizedMessage = filterEmailToStandardMessage(parsed);
                if (standardizedMessage.messageId === lastMessageId) return;
                lastMessageId = standardizedMessage.messageId;
                console.log('📥 New email received:', parsed.subject);
                mailEvents.emit('newMail', standardizedMessage);
                if (onNewMail) onNewMail(standardizedMessage);
              });
            });
          });

          fetch.on('error', (err) => console.error('❌ IMAP fetch error:', err.message));
        });
      });
    });

    imap.once('error', (err) => {
      console.error('❌ IMAP error:', err.message);
    });

    imap.once('end', () => {
      if (stopped) {
        console.log('📭 IMAP connection ended');
        return;
      }
      console.log(`📭 IMAP disconnected — retrying in ${reconnectDelay / 1000}s`);
      setTimeout(connect, reconnectDelay);
    });

    imap.connect();
  };

  connect();
  return mailEvents;
}
