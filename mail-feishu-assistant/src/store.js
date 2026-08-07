const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.logsDir, { recursive: true });
}

function readJson(fileName, fallback) {
  ensureDirs();
  const filePath = path.join(config.dataDir, fileName);
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(fileName, data) {
  ensureDirs();
  const filePath = path.join(config.dataDir, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function appendLog(message, details) {
  ensureDirs();
  const line = JSON.stringify({
    time: new Date().toISOString(),
    message,
    details: details || null,
  });
  fs.appendFileSync(path.join(config.logsDir, 'assistant.log'), `${line}\n`);
}

module.exports = {
  readJson,
  writeJson,
  appendLog,
};
