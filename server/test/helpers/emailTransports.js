// Fake transports for the password-reset email test suites.
//
// The suites must exercise the real mailer code paths, so nothing is stubbed at
// the mailer's own boundary: https.request is replaced for the Resend transport
// and Nodemailer's transport factory for the SMTP fallback. Both record what
// they were handed and replay a scripted outcome, so no mail is ever sent and no
// network is ever touched.

const https = require('https');
const { EventEmitter } = require('node:events');
const nodemailer = require('nodemailer');

// Replaces https.request with a recorder. `behaviour` receives the recorded
// call, the request object (so a test can emit a socket error or fire the
// timeout handler) and a `respond` helper that replays a scripted HTTP response.
const stubHttps = (behaviour) => {
  const original = https.request;
  const calls = [];
  https.request = (options, callback) => {
    const call = { options, headers: { ...(options.headers || {}) }, body: '' };
    calls.push(call);

    const request = new EventEmitter();
    request.setHeader = (name, value) => {
      call.headers[String(name).toLowerCase()] = value;
    };
    request.getHeader = (name) => call.headers[String(name).toLowerCase()];
    request.setTimeout = (ms, handler) => {
      call.timeoutMs = ms;
      call.fireTimeout = handler;
    };
    request.write = (chunk) => {
      call.body += String(chunk);
    };
    request.destroy = (error) => {
      call.destroyed = true;
      if (error) request.emit('error', error);
    };
    request.end = () => {
      call.payload = call.body ? JSON.parse(call.body) : null;
      behaviour({
        call,
        request,
        respond: ({ status = 200, body = '', headers = {}, abort = false } = {}) => {
          const response = new EventEmitter();
          response.statusCode = status;
          response.headers = headers;
          callback(response);
          process.nextTick(() => {
            if (body) response.emit('data', Buffer.from(body));
            // abort=true leaves the response unfinished, like a dropped socket.
            if (abort) response.emit('aborted');
            else response.emit('end');
          });
        }
      });
    };
    return request;
  };
  return {
    calls,
    restore: () => {
      https.request = original;
    }
  };
};

// Replaces Nodemailer's transport factory and records the messages handed to it.
// `sendMail` may throw to simulate a server-side rejection.
const stubSmtp = (sendMail) => {
  const original = nodemailer.createTransport;
  const delivered = [];
  nodemailer.createTransport = (options) => ({
    options,
    sendMail: async (message) => {
      delivered.push(message);
      if (sendMail) return sendMail(message);
      return { messageId: 'smtp-test-id', accepted: [message.to] };
    }
  });
  return {
    delivered,
    restore: () => {
      nodemailer.createTransport = original;
    }
  };
};

module.exports = { stubHttps, stubSmtp };
