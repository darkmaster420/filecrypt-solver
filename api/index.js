const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// Store active sessions (in production, you'd want to use a database)
const activeSessions = new Map();

// Middleware to get or create a session
async function getFileCryptSession(filecryptId) {
  // Check if we have an active session for this FileCrypt ID
  if (activeSessions.has(filecryptId)) {
    const session = activeSessions.get(filecryptId);
    // Check if session is still valid (e.g., less than 30 minutes old)
    if (Date.now() - session.createdAt < 30 * 60 * 1000) {
      return session;
    } else {
      // Remove expired session
      if (session.browser) {
        await session.browser.close().catch(console.error);
      }
      activeSessions.delete(filecryptId);
    }
  }

  // Create a new session
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const session = {
    id: uuidv4(),
    filecryptId,
    browser,
    createdAt: Date.now(),
    solvedLinks: new Map(),
  };
  
  activeSessions.set(filecryptId, session);
  return session;
}

// Endpoint to solve FileCrypt
app.post('/solve-filecrypt', async (req, res) => {
  try {
    const { filecryptUrl } = req.body;
    
    // Extract FileCrypt ID from URL
    const filecryptIdMatch = filecryptUrl.match(/filecrypt\.co\/(?:Container\/|Link\/)([A-Z0-9]+)/i);
    if (!filecryptIdMatch) {
      return res.status(400).json({ success: false, error: 'Invalid FileCrypt URL' });
    }
    
    const filecryptId = filecryptIdMatch[1];
    
    // Get or create session
    const session = await getFileCryptSession(filecryptId);
    const page = await session.browser.newPage();
    
    // Navigate to FileCrypt URL
    await page.goto(filecryptUrl, { waitUntil: 'networkidle2' });
    
    // Wait for CAPTCHA to appear (if any)
    await page.waitForSelector('iframe[title*="reCAPTCHA"]', { timeout: 5000 })
      .catch(() => console.log('No CAPTCHA found or already solved'));
    
    // For now, we'll just wait for manual CAPTCHA solving
    // In a production version, you would integrate with a CAPTCHA solving service here
    
    // Wait for the links to appear after solving CAPTCHA (with a longer timeout)
    console.log('Waiting for links to appear (manual CAPTCHA solving required)...');
    
    try {
      // Wait up to 2 minutes for links to appear (allowing time for manual CAPTCHA solving)
      await page.waitForSelector('a[href*="gofile.io"]', { timeout: 120000 });
      
      // Extract all Gofile links
      const gofileLinks = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href*="gofile.io"]').forEach(link => {
          links.push({
            url: link.href,
            text: link.textContent.trim()
          });
        });
        return links;
      });
      
      // Store the solved links in the session
      gofileLinks.forEach(link => {
        session.solvedLinks.set(link.url, link);
      });
      
      // Close the page but keep the browser open for future requests
      await page.close();
      
      res.json({
        success: true,
        links: gofileLinks,
        sessionId: session.id,
        message: 'Successfully extracted Gofile links'
      });
    } catch (e) {
      // If links don't appear within the timeout
      await page.close();
      res.json({
        success: false,
        error: 'Timed out waiting for links to appear. CAPTCHA may need to be solved manually.',
        sessionId: session.id
      });
    }
  } catch (error) {
    console.error('Error solving FileCrypt:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to get previously solved links from a session
app.post('/get-solved-links', async (req, res) => {
  try {
    const { filecryptUrl, sessionId } = req.body;
    
    // Extract FileCrypt ID from URL
    const filecryptIdMatch = filecryptUrl.match(/filecrypt\.co\/(?:Container\/|Link\/)([A-Z0-9]+)/i);
    if (!filecryptIdMatch) {
      return res.status(400).json({ success: false, error: 'Invalid FileCrypt URL' });
    }
    
    const filecryptId = filecryptIdMatch[1];
    
    // Check if we have an active session
    if (!activeSessions.has(filecryptId)) {
      return res.status(404).json({ success: false, error: 'No active session found' });
    }
    
    const session = activeSessions.get(filecryptId);
    
    // Verify session ID if provided
    if (sessionId && session.id !== sessionId) {
      return res.status(403).json({ success: false, error: 'Invalid session ID' });
    }
    
    // Convert the Map to an array for JSON serialization
    const solvedLinks = Array.from(session.solvedLinks.values());
    
    res.json({
      success: true,
      links: solvedLinks,
      sessionId: session.id
    });
  } catch (error) {
    console.error('Error getting solved links:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to clean up expired sessions
app.post('/cleanup-sessions', async (req, res) => {
  try {
    const now = Date.now();
    const expiredThreshold = 30 * 60 * 1000; // 30 minutes
    
    let cleanedCount = 0;
    
    for (const [filecryptId, session] of activeSessions.entries()) {
      if (now - session.createdAt > expiredThreshold) {
        // Close the browser
        if (session.browser) {
          await session.browser.close().catch(console.error);
        }
        activeSessions.delete(filecryptId);
        cleanedCount++;
      }
    }
    
    res.json({
      success: true,
      message: `Cleaned up ${cleanedCount} expired sessions`,
      activeSessions: activeSessions.size
    });
  } catch (error) {
    console.error('Error cleaning up sessions:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Export the Express app
module.exports = app;