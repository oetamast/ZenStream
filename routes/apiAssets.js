const express = require('express');
const router = express.Router();

// TODO: Implement ZenStream v1 Basic endpoint logic.
router.all('*', (req, res) => {
  res.status(501).json({ message: 'Not implemented yet: ' + req.method + ' ' + req.originalUrl });
});

module.exports = router;
