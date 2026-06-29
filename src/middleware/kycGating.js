const { CAPITAL_MOVING_STATES } = require('../services/invoiceStateMachine');

function kycGatingMiddleware(req, res, next) {
    const targetState = req.body.state || req.body.targetState;
    
    if (CAPITAL_MOVING_STATES.has(targetState)) {
        if (!req.user || !req.user.isKycVerified) {
            return res.status(403).json({ 
                error: 'KYC_REQUIRED', 
                message: 'Action restricted. KYC verification required for capital-moving operations.' 
            });
        }
    }
    next();
}

module.exports = kycGatingMiddleware;
