const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

// Get the secret from environment variables
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('Error: GITHUB_WEBHOOK_SECRET not found in .env file');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      const signature = req.headers['x-hub-signature-256'];
      
      if (!signature) {
        res.writeHead(401);
        return res.end('No signature provided');
      }
      
      // Verify the signature
      const hmac = crypto.createHmac('sha256', SECRET);
      const digest = 'sha256=' + hmac.update(body).digest('hex');
      
      if (signature !== digest) {
        res.writeHead(401);
        return res.end('Invalid signature');
      }
      
      // Parse the payload
      const payload = JSON.parse(body);
      
      // Check if it's a push to main/master branch
      const branch = payload.ref ? payload.ref.split('/').pop() : '';
      if (branch === 'main' || branch === 'master') {
        console.log('Deploying latest changes...');
        exec('/home/opc/deploy.sh', (error, stdout, stderr) => {
          if (error) {
            console.error(`Exec error: ${error}`);
            return;
          }
          console.log(`stdout: ${stdout}`);
          console.error(`stderr: ${stderr}`);
        });
      }
      
      res.writeHead(200);
      res.end('Webhook received successfully');
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Listen on port 9000
server.listen(9000, () => {
  console.log('Webhook server running on port 9000');
});