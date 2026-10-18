// Vercel Serverless Function entry point for FutureIN Quiz
const handler = require('../server.js');

module.exports = async (req, res) => {
  return handler(req, res);
};
