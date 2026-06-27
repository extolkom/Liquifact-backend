const express = require('express');
const router = express.Router();
const { CAPITAL_MOVING_STATES } = require('../services/invoiceStateMachine');

router.post('/transition', (req, res) => {
    const { targetState } = req.body;
    
    if (CAPITAL_MOVING_STATES.has(targetState)) {
        return res.status(200).json({ requiresKYC: true, state: targetState });
    }
    
    return res.status(200).json({ requiresKYC: false, state: targetState });
});

module.exports = router;
