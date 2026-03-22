// mailConnection.js
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import EventEmitter from 'events';
import { filterEmailToStandardMessage } from './filters/mailFilter.js';

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

export async function sendMail({ to, subject, text, html }) {
  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
      html,
    });
    console.log('📧 Email sent:', info.messageId);
    return info;
  } catch (error) {
    console.error('❌ Failed to send email:', error);
    throw error;
  }
}

export function startMailListener(onNewMail) {
  const imap = new Imap({
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASS,
    host: process.env.MAIL_IMAP_HOST,
    port: parseInt(process.env.MAIL_IMAP_PORT || '993'),
    tls: true,
  });

  const mailEvents = new EventEmitter();

  imap.once('ready', function () {
    imap.openBox('INBOX', false, function (err, box) {
      if (err) throw err;
      imap.on('mail', function () {
        const fetch = imap.seq.fetch(box.messages.total + ':*', {
          bodies: '',
          struct: true
        });

        fetch.on('message', function (msg) {
          msg.on('body', function (stream) {
            simpleParser(stream, async (err, parsed) => {
              if (err) {
                console.error('❌ Error parsing email:', err);
                return;
              }
              console.log('📥 New email received:', parsed.subject);
              const standardizedMessage = filterEmailToStandardMessage(parsed);
              mailEvents.emit('newMail', standardizedMessage);
              if (onNewMail) onNewMail(standardizedMessage);
            });
          });
        });
      });
    });
  });

  imap.once('error', function (err) {
    console.error('❌ IMAP error:', err);
  });

  imap.once('end', function () {
    console.log('📭 IMAP connection ended');
  });

  imap.connect();
  return mailEvents;
}
